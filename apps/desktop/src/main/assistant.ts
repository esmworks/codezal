import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CodezalEngine } from "@codezal/agent";
import {
  type AssistantContext,
  contextDirFor,
  outputsDirFor,
  type ScheduledTask,
  safeFolderName,
} from "@codezal/contracts";
import { type Locale, localeOf, localeTag } from "@codezal/i18n";
import { app, Notification } from "electron";
import { i18n } from "./i18n.js";
import { broadcast } from "./ipc.js";
import type { AppStores } from "./stores.js";

export const assistantDir = () => join(app.getPath("userData"), "asistan");

/** Zamanlanmış görevi asistan oturumu olarak çalıştırır, sonucu kaydeder ve bildirir. */
export async function runScheduled(
  eng: CodezalEngine,
  stores: AppStores,
  task: ScheduledTask,
): Promise<void> {
  const settings = stores.settings.get();
  const model = task.model ?? settings.defaultModel;
  if (!model) throw new Error(i18n.t("errors.defaultModelMissing"));
  const project = task.projectId
    ? stores.projects().find((p) => p.id === task.projectId)
    : undefined;
  // Proje kimliği `assistant.json`dan gelir ve şemada serbest metindir; yol parçası olmadan önce
  // güvenli ada çevrilir (kardeş yol `outputsDirFor` da aynısını yapar). Aksi hâlde elle
  // düzenlenmiş bir kayıt `../../..` ile oturum klasörünü userData dışına taşıyabilirdi.
  const cwd = join(assistantDir(), project ? safeFolderName(project.id) : "genel");
  mkdirSync(cwd, { recursive: true });
  const lang: Locale = localeOf(i18n.language);
  const summary = await eng.createSession({
    cwd,
    mode: "asistan",
    model,
    thinking: "low",
    permission: task.permission,
    location: "local",
    name: `${task.title} · ${new Date().toLocaleString(localeTag(lang))}`,
    projectId: task.projectId,
  });
  // Onay isteyecek adımlar (tam erişimde yalnız tehlikeli komutlar) soracak kimse olmadığı için
  // reddedilir; ajan gerekçeyi görür ve başka yoldan sürer.
  eng.permissions.setUnattended(summary.id, true);
  // "Web'e erişebilir": onay kullanıcı görevi kaydederken verildi; koşu bitince geri alınır ki
  // oturumu sonradan açıp sürdüren kullanıcıya yine sorulsun.
  eng.permissions.setWebAllowed(summary.id, task.allowWeb);
  // Uzun süren görevlerde sohbet sidebar'a geç düşmesin: oturum açılır açılmaz haber ver.
  broadcast("schedule:started", { id: task.id, sessionId: summary.id });
  try {
    await eng.promptAndWait(summary.id, task.prompt);
  } finally {
    eng.permissions.setUnattended(summary.id, false);
    eng.permissions.setWebAllowed(summary.id, false);
  }
  const text = eng.lastAssistantText(summary.id);
  // Zamanlayıcı bu arada sonraki çalışmayı yazmış olabilir; güncel kaydın üstüne eklenir.
  // Koşu sürerken silinen görev geri yazılmaz (eski `?? task` onu bayat hâliyle geri getiriyordu).
  const current = stores.tasks().find((x) => x.id === task.id);
  if (current) {
    stores.saveTask({
      ...current,
      lastRunAt: Date.now(),
      lastResult: text.slice(0, 2000),
      lastSessionId: summary.id,
    });
  }
  broadcast("schedule:ran", { id: task.id, sessionId: summary.id });
  if (settings.notifications && Notification.isSupported()) {
    new Notification({
      title: task.title,
      body: text.slice(0, 160) || i18n.t("notifications.taskDone"),
      silent: !settings.notificationSound,
    }).show();
  }
}

/**
 * Asistan oturumu ekleri: proje talimatları + bağlam + çıktı kuralı ve çıktı klasörü.
 * Engine hem oluştururken hem yeniden açarken çağırır; çıktı klasörü yoksa oluşturulur.
 */
export function assistantExtras(
  documents: string,
  stores: AppStores,
  projectId: string | null,
): { extraSystem: string; outputsDir: string } {
  const project = projectId ? stores.projects().find((p) => p.id === projectId) : undefined;
  const outputsDir = outputsDirFor(documents, project ? project.name : null);
  ensureProjectFolders(documents, project ? project.name : null);
  const extraSystem = [project ? assistantSystem(project) : "", outputsInstructions(outputsDir)]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  return { extraSystem, outputsDir };
}

/** Sistem istemi eki: kalıcı sonuçlar çıktı klasörüne .md olarak yazılır, sohbette özet verilir. */
export function outputsInstructions(outputsDir: string): string {
  return `${i18n.t("prompt.outputsRule", { dir: outputsDir })}\n${i18n.t("prompt.fileRules")}`;
}

/**
 * Proje klasörünü hazırlar: çıktılar ve bağlam kopyaları. Proje kaydedilirken ve oturum
 * açılırken çağrılır; idempotenttir (var olan klasöre dokunmaz).
 */
export function ensureProjectFolders(documents: string, projectName: string | null): void {
  mkdirSync(contextDirFor(documents, projectName), { recursive: true });
  mkdirSync(outputsDirFor(documents, projectName), { recursive: true });
}

/**
 * Bağlam satırı: kopyası varsa birincil yol kopyadır (ajan yerel ve taze sürümü okusun),
 * kaynak parantez içinde kalır. Kopya yoksa yalnız kaynak yol yazılır.
 */
export function contextLine(c: AssistantContext, copyNote: (source: string) => string): string {
  const head = `- [${c.kind}] ${c.label}: `;
  return c.copy ? `${head}${c.copy.path} (${copyNote(c.value)})` : `${head}${c.value}`;
}

export function assistantSystem(p: {
  name: string;
  instructions: string;
  context: AssistantContext[];
}): string {
  const parts: string[] = [i18n.t("prompt.projectTitle", { name: p.name })];
  if (p.instructions.trim())
    parts.push(`${i18n.t("prompt.projectInstructions")}\n${p.instructions.trim()}`);
  if (p.context.length) {
    const lines = p.context.map((c) =>
      contextLine(c, (source) => i18n.t("prompt.contextCopyNote", { source })),
    );
    parts.push(`${i18n.t("prompt.contextSources")}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Eski sürümde proje.memory düz metin listesiydi; dosya tabanlı belleğe taşınır ve boşaltılır. */
export function migrateProjectMemory(eng: CodezalEngine, stores: AppStores): void {
  for (const p of stores.projects()) {
    if (p.memory.length === 0) continue;
    for (const note of p.memory)
      eng.memory.save(
        { kind: "asistan", projectId: p.id },
        { description: note, type: "kullanici", body: note },
      );
    stores.saveProject({ ...p, memory: [] });
  }
}
