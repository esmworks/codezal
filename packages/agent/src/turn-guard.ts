import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AppMode } from "@codezal/contracts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { TASK_LIST_TOOL } from "./task-list.js";

/** Motorun tur sonunda modele gönderdiği gizli dürtmelerin `customType`'ı. */
export const NUDGE_TYPE = "codezal-nudge";

export type NudgeKind = "empty-response" | "unrun-script" | "checks" | "open-steps";

export interface Nudge {
  kind: NudgeKind;
  /** `unrun-script`: yazılıp hiç çalıştırılmayan betiğin yolu. */
  path?: string;
  /** `open-steps`: turda kapatılmadan bırakılan adımların başlıkları. */
  open?: string[];
}

/** `analyzeTurn`ın döndürdüğü dürtmeler: `checks` tur sonu kontrollerinde ayrıca gönderilir. */
export type TurnNudge = Nudge & { kind: Exclude<NudgeKind, "checks"> };

/** Yazıldığı hâlde çalıştırılmamış sayılan betik uzantıları. */
const SCRIPT_EXT = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".sh",
  ".rb",
  ".r",
  ".pl",
  ".php",
]);

interface CustomLike {
  role: "custom";
  customType: string;
  details?: unknown;
}

function isCustom(m: AgentMessage): m is AgentMessage & CustomLike {
  return (m as { role: string }).role === "custom";
}

/** Bu tur: son kullanıcı mesajından sonrakiler (yönlendirme de kullanıcı mesajıdır, tur oradan sayılır). */
export function turnMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  return messages.slice(start);
}

/** Bu turda daha önce gönderilen dürtmelerin türleri; aynı tür ikinci kez gönderilmez (döngü olmasın). */
export function nudgedKinds(turn: readonly AgentMessage[]): Set<NudgeKind> {
  const out = new Set<NudgeKind>();
  for (const m of turn) {
    if (!isCustom(m) || m.customType !== NUDGE_TYPE) continue;
    const kind = (m.details as { kind?: unknown } | undefined)?.kind;
    if (typeof kind === "string") out.add(kind as NudgeKind);
  }
  return out;
}

function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/** Bu turda başarıyla biten `edit`/`write` çağrılarının dosya yolları (yol okunamazsa boş). */
function successfulFileCalls(turn: readonly AgentMessage[]): Array<{ path: string | undefined }> {
  const failed = new Set<string>();
  for (const m of turn) {
    if (m.role !== "toolResult") continue;
    const r = m as ToolResultMessage;
    if (r.isError) failed.add(r.toolCallId);
  }
  const out: Array<{ path: string | undefined }> = [];
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    for (const c of (m as AssistantMessage).content) {
      if (c.type !== "toolCall") continue;
      if (c.name !== "edit" && c.name !== "write") continue;
      if (failed.has(c.id)) continue;
      const raw = c.arguments.path;
      out.push({ path: typeof raw === "string" && raw.length > 0 ? raw : undefined });
    }
  }
  return out;
}

/**
 * Turdaki son `task_list` çağrısının adımları (yoksa `undefined`). Başarısız çağrı atlanır:
 * şema hatası alan liste modelin gerçek durumu değildir.
 */
export function lastTaskList(turn: readonly AgentMessage[]): TaskStepLike[] | undefined {
  const failed = new Set<string>();
  for (const m of turn) {
    if (m.role !== "toolResult") continue;
    if ((m as ToolResultMessage).isError) failed.add((m as ToolResultMessage).toolCallId);
  }
  let found: TaskStepLike[] | undefined;
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    for (const c of (m as AssistantMessage).content) {
      if (c.type !== "toolCall" || c.name !== TASK_LIST_TOOL || failed.has(c.id)) continue;
      const raw = (c.arguments as { steps?: unknown } | undefined)?.steps;
      if (Array.isArray(raw)) found = raw as TaskStepLike[];
    }
  }
  return found;
}

interface TaskStepLike {
  title?: unknown;
  status?: unknown;
}

/** Bu turda kapatılmadan bırakılan adımların başlıkları (başlık okunamazsa boş dize). */
export function openStepTitles(turn: readonly AgentMessage[]): string[] {
  const steps = lastTaskList(turn);
  if (!steps) return [];
  return steps
    .filter((s) => s.status !== "done")
    .map((s) => (typeof s.title === "string" ? s.title : ""));
}

/** Bu turda başarıyla biten `edit`/`write` çağrısı var mı (tur sonu kontrolleri bunu bekler). */
export function turnTouchedFiles(turn: readonly AgentMessage[]): boolean {
  return successfulFileCalls(turn).length > 0;
}

/** Turda değişen dosyalar (depo-göreli); inceleme kapsamı bu listeyi alır. */
export function turnTouchedPaths(turn: readonly AgentMessage[], cwd: string): string[] {
  const out = new Set<string>();
  for (const call of successfulFileCalls(turn)) {
    if (!call.path) continue;
    const abs = isAbsolute(call.path) ? call.path : resolve(cwd, call.path);
    const rel = relative(cwd, abs);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.add(rel);
  }
  return [...out];
}

/**
 * Tur sonunda modele bir dürtme gerekiyor mu.
 *
 * - `empty-response`: model metin de araç da üretmeden durdu (DeepSeek gibi sağlayıcılar araç
 *   turundan sonra boş mesaj döndürebiliyor). Kullanıcı "devam" yazmak zorunda kalmasın.
 * - `unrun-script` (Asistan): model çıktı üretmek için betik yazdı ama hiç çalıştırmadı; iş
 *   yarım kalıyor, Çıktılar kutusuna yalnızca `.py` düşüyordu.
 * - `open-steps`: model bu turda `task_list` kurdu/güncelledi ama açık adım bıraktı (oturum
 *   kayıtlarında turların %31'i). Liste tur sonunda yarım kalınca kullanıcı işin bittiğini
 *   sanıyor; dürtme adımı kapatmayı ya da gerekçe yazmayı ister. Yalnızca bu turda kullanılan
 *   liste dürtülür; önceki turdan kalan liste kullanıcıyı ve modeli gereksiz dürtmez.
 *
 * Kesilen (`aborted`) ve hatayla biten turlar dürtülmez; hata yolu motorun yeniden deneme
 * döngüsünde, kesme kullanıcının kararıdır.
 */
export function analyzeTurn(
  messages: readonly AgentMessage[],
  opts: { mode: AppMode },
): TurnNudge | undefined {
  const turn = turnMessages(messages);
  if (turn.length === 0) return undefined;
  const last = turn[turn.length - 1];
  if (last?.role !== "assistant") return undefined;
  const final = last as AssistantMessage;
  if (final.stopReason !== "stop") return undefined;
  const already = nudgedKinds(turn);

  const hasToolCall = final.content.some((c) => c.type === "toolCall");
  if (!hasToolCall && textOf(final).length === 0 && !already.has("empty-response"))
    return { kind: "empty-response" };

  if (opts.mode === "asistan" && !already.has("unrun-script")) {
    const unrun = findUnrunScript(turn);
    if (unrun) return { kind: "unrun-script", path: unrun };
  }

  // Açık adım kontrolü moddan bağımsız: hem Kodlama hem Asistan adım listesi kullanıyor.
  if (!already.has("open-steps")) {
    const open = openStepTitles(turn);
    if (open.length > 0) return { kind: "open-steps", open };
  }
  return undefined;
}

/** Yazıldığı hâlde çalıştırılmamış sayılan betik (Asistan dürtmesi). */
function findUnrunScript(turn: readonly AgentMessage[]): string | undefined {
  const failed = new Set<string>();
  for (const m of turn) {
    if (m.role !== "toolResult") continue;
    const r = m as ToolResultMessage;
    if (r.isError) failed.add(r.toolCallId);
  }
  const scripts: string[] = [];
  const commands: string[] = [];
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    for (const c of (m as AssistantMessage).content) {
      if (c.type !== "toolCall") continue;
      const args = (c.arguments ?? {}) as Record<string, unknown>;
      if (c.name === "write" && !failed.has(c.id)) {
        const path = typeof args.path === "string" ? args.path : "";
        if (path && SCRIPT_EXT.has(extname(path).toLowerCase())) scripts.push(path);
      }
      if (c.name === "bash" || c.name === "powershell") {
        const command = typeof args.command === "string" ? args.command : "";
        if (command) commands.push(command);
      }
    }
  }
  return scripts.find((p) => {
    const name = basename(p);
    return !commands.some((cmd) => cmd.includes(name));
  });
}
