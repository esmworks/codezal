import { contextDirFor, formatBytes } from "@codezal/contracts";
import { shell } from "electron";
import { ensureProjectFolders, runScheduled } from "../assistant.js";
import type { AppContext } from "../context.js";
import {
  COPY_CONFIRM_BYTES,
  COPY_LIMIT_BYTES,
  copyContext,
  inside,
  measure,
  trashContext,
} from "../context-copy.js";
import { i18n } from "../i18n.js";
import { handle } from "../ipc.js";
import { nextRun } from "../scheduler.js";

/** Asistan kanalları: zamanlanmış görevler, projeler, bellek. */
export function registerAssistantIpc({ engine: eng, paths, stores }: AppContext): void {
  handle("schedule:list", () => stores.tasks());
  // Sonraki çalışma kayıtta hesaplanır; yeniden başlatmayı beklemez ve renderer anında görür.
  handle("schedule:save", (task) => stores.saveTask({ ...task, nextRunAt: nextRun(task) }));
  handle("schedule:delete", ({ id }) => stores.deleteTask(id));
  handle("schedule:runNow", async ({ id }) => {
    const t = stores.tasks().find((x) => x.id === id);
    if (!t) throw new Error(i18n.t("errors.taskNotFound"));
    await runScheduled(eng, stores, t);
  });
  handle("assistant:projects", () => stores.projects());
  handle("assistant:saveProject", (p) => {
    // Proje oluşturulur oluşturulmaz klasörleri hazır olsun: çıktılar ve bağlam kopyaları.
    ensureProjectFolders(paths.documents, p.name);
    return stores.saveProject(p);
  });
  handle("assistant:deleteProject", ({ id }) => stores.deleteProject(id));
  handle("assistant:reorderProjects", ({ ids }) => stores.reorderProjects(ids));

  handle("assistant:copyContext", async ({ projectId, value, confirm }) => {
    const project = stores.projects().find((p) => p.id === projectId);
    if (!project) throw new Error(i18n.t("errors.projectNotFound"));
    const ctx = project.context.find((c) => c.value === value);
    if (!ctx) throw new Error(i18n.t("errors.contextNotFound"));
    if (ctx.kind === "link") throw new Error(i18n.t("errors.contextLinkNotCopyable"));
    const bytes = await measure(ctx.value);
    if (bytes > COPY_LIMIT_BYTES)
      throw new Error(
        i18n.t("errors.contextTooLarge", { size: formatBytes(COPY_LIMIT_BYTES, i18n.language) }),
      );
    // Büyük kopya sessizce başlamasın: kullanıcı onayı olmadan yalnız ölçüm döner.
    if (bytes > COPY_CONFIRM_BYTES && !confirm) return { project, bytes, needsConfirm: true };
    const contextDir = contextDirFor(paths.documents, project.name);
    // Kayıtlı kopya yolu yalnız bağlam klasörü içindeyse hedef alınır; dışarıdaki bir yol ne
    // üzerine yazılır ne çöpe atılır (bozuk kayıt ya da elle düzenlenmiş `assistant.json`).
    const stale = ctx.copy && inside(contextDir, ctx.copy.path) ? ctx.copy.path : undefined;
    let target: string;
    try {
      target = await copyContext(ctx.value, contextDir, stale);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(i18n.t("errors.contextCopyFailed", { message }));
    }
    const next = {
      ...project,
      context: project.context.map((c) =>
        c.value === value ? { ...c, copy: { path: target, copiedAt: Date.now() } } : c,
      ),
    };
    return { project: stores.saveProject(next), bytes, needsConfirm: false };
  });

  handle("assistant:removeContext", async ({ projectId, value }) => {
    const project = stores.projects().find((p) => p.id === projectId);
    if (!project) throw new Error(i18n.t("errors.projectNotFound"));
    const ctx = project.context.find((c) => c.value === value);
    // Kopya kalıcı silinmez: yanlışlıkla kaldırılan bağlam çöp kutusundan geri alınabilir.
    // Yalnız kendi bağlam klasörümüzdeki yol çöpe atılır; kayıttaki keyfi yol yok sayılır.
    const contextDir = contextDirFor(paths.documents, project.name);
    if (ctx?.copy && inside(contextDir, ctx.copy.path)) await trashContext(ctx.copy.path);
    const next = { ...project, context: project.context.filter((c) => c.value !== value) };
    return { project: stores.saveProject(next) };
  });

  handle("memory:list", ({ scope }) => eng.memory.list(scope));
  handle("memory:save", ({ scope, draft }) => eng.memory.save(scope, draft));
  handle("memory:remove", ({ scope, name }) => eng.memory.remove(scope, name));
  handle("memory:openFolder", async ({ scope }) => {
    await shell.openPath(eng.memory.ensure(scope));
  });
}
