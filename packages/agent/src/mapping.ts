import {
  type AgentEventInput,
  type ChangedFile,
  type ImageAttachment,
  isAbsolutePath,
  NudgeKind,
  ScheduleToolResult,
  ScheduleToolTask,
  SearchBackend,
  type TranscriptItem,
  type Usage,
} from "@codezal/contracts";
import type { Locale } from "@codezal/i18n";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { FILE_EDIT_TOOLS } from "./create-tools.js";
import { liveChangeStat } from "./live-diff.js";
import { maskSecrets } from "./mask.js";
import { explainProviderErrorWithReason } from "./provider-error.js";
import { SCHEDULE_TOOL } from "./schedule-tool.js";
import { describeTool } from "./tool-info.js";
import { NUDGE_TYPE } from "./turn-guard.js";
import { unwrapUntrusted } from "./untrusted.js";

/**
 * Canlı sayacın yayın aralığı: ZCode da akış önizlemesini saniyede bir tazeler. Daha sık ölçü
 * her token'da kart çizdirirdi; sayaç zaten bitişteki gerçek diff'e yakınsıyor.
 */
const PREVIEW_INTERVAL_MS = 1000;

/** Akış sırasındaki araç çağrısı olayları: girdi henüz tamamlanmamış olabilir. */
type ToolCallStreamEvent = Extract<
  AssistantMessageEvent,
  { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
>;

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is TextContent => typeof c === "object" && c !== null && c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Kullanıcı mesajındaki görsel blokları (Pi bunları base64 olarak oturum dosyasında saklar). */
function imagesOf(content: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const imgs = content
    .filter((c): c is ImageContent => typeof c === "object" && c !== null && c.type === "image")
    .map((c) => ({ mimeType: c.mimeType, data: c.data }));
  return imgs.length > 0 ? imgs : undefined;
}

/** Düşünme blokları; boş bloklar (araç çağrısı turlarında sık) elenir, hiç metin yoksa undefined. */
function thinkingOf(msg: AssistantMessage): string | undefined {
  const t = msg.content
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking.trim())
    .filter((c) => c.length > 0)
    .join("\n\n");
  return t.length > 0 ? t : undefined;
}

/** Pi kullanım alanlarını arayüz `Usage`'ına çevirir; keşif alt ajanının maliyeti de buradan geçer. */
export function toUsage(u: AssistantMessage["usage"]): Usage {
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cost: u.cost?.total ?? 0,
  };
}

/** Araç sonucundan gösterilecek çıktıyı seçer: edit için diff, diğerleri için metin. */
export function outputOfResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { content?: unknown; details?: { diff?: unknown } };
  const diff = r.details?.diff;
  if (typeof diff === "string" && diff.length > 0) return diff;
  // Güvenilmez veri zarfı modele yöneliktir; kart yalnız içeriği gösterir.
  const text = unwrapUntrusted(textOf(r.content));
  return text.length > 0 ? text : undefined;
}

/**
 * `write` aracı diff döndürmez ("Successfully wrote to …"); +N sayacı ve İncele için
 * yazılan içerikten Pi'nin edit diff biçiminde (`+<satır no> <metin>`) bir diff üretir.
 */
export function writeDiff(args: Record<string, unknown> | undefined): string | undefined {
  const content = args?.content;
  if (typeof content !== "string" || content.length === 0) return undefined;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((l, i) => `+${String(i + 1).padStart(width, " ")} ${l}`).join("\n");
}

/** Araç çıktısı: sonuçta diff yoksa ve araç `write` ise içerikten sentezlenir. */
export function outputOfTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
  isError: boolean,
): string | undefined {
  const output = outputOfResult(result);
  if (toolName !== "write" || isError) return output;
  const r = result as { details?: { diff?: unknown } } | undefined;
  if (typeof r?.details?.diff === "string" && r.details.diff.length > 0) return output;
  return writeDiff(args) ?? output;
}

/**
 * `web_search` sonucundaki `details.endpoint`: arama sağlayıcının yerleşik aramasıyla mı yoksa
 * DuckDuckGo uç noktasıyla mı yapıldı. Kartta etiket olarak görünür. Başka araçlarda, eski
 * kayıtlarda ve arama hiç sonuçlanmadıysa `undefined` döner; alan tanınmıyorsa yazılmaz
 * (ileride yeni bir uç nokta eklenirse kart bilinmeyen etiket basmasın).
 */
export function searchBackendOf(toolName: string, result: unknown): SearchBackend | undefined {
  if (toolName !== "web_search") return undefined;
  if (!result || typeof result !== "object") return undefined;
  const endpoint = (result as { details?: { endpoint?: unknown } }).details?.endpoint;
  const parsed = SearchBackend.safeParse(endpoint);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `schedule_task` sonucundaki eylem ve görev(ler) (`details.action`, `details.task`/`tasks`).
 * Sohbetteki görev kartı bunu çizer. Görev şemaya uymuyorsa, çağrı hatalıysa ya da sonuç ayrıntı
 * taşımıyorsa (bulunamadı, eksik alan) `undefined` döner ve genel araç satırı kalır. Eylemi
 * yazmayan eski kayıtta tek görev "create", liste "list" sayılır.
 */
export function scheduleResultOf(
  toolName: string,
  result: unknown,
  isError: boolean,
): ScheduleToolResult | undefined {
  if (isError || toolName !== SCHEDULE_TOOL) return undefined;
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const d = details as { action?: unknown; task?: unknown; tasks?: unknown };
  const raw = Array.isArray(d.tasks) ? d.tasks : d.task !== undefined ? [d.task] : undefined;
  if (!raw) return undefined;
  const tasks = ScheduleToolTask.array().safeParse(raw);
  if (!tasks.success) return undefined;
  const fallback = Array.isArray(d.tasks) ? "list" : "create";
  const parsed = ScheduleToolResult.safeParse({ action: d.action ?? fallback, tasks: tasks.data });
  return parsed.success ? parsed.data : undefined;
}

/**
 * `bash` sonucundaki `details.sandboxed`: komut macOS korumalı alanında koştu (motor
 * `tool_result` kancasıyla yazar). Kart "Korumalı" etiketi gösterir; diğer araçlarda `false`.
 */
export function sandboxedOf(toolName: string, result: unknown): boolean {
  if (toolName !== "bash" || !result || typeof result !== "object") return false;
  return (result as { details?: { sandboxed?: unknown } }).details?.sandboxed === true;
}

const CHANGE_KINDS: ReadonlySet<string> = new Set(["create", "edit", "delete"]);

/**
 * Sonuçtaki `details.changedFiles`: terminal komutunun ya da alt ajanın değiştirdiği dosyalar
 * (motorun tur yedeği kancası ekler). Biçimi tutmayan öğe atlanır; liste boşsa `undefined`.
 */
export function changedFilesOf(result: unknown): ChangedFile[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const raw = (result as { details?: { changedFiles?: unknown } }).details?.changedFiles;
  if (!Array.isArray(raw)) return undefined;
  const files: ChangedFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { path, kind } = item as { path?: unknown; kind?: unknown };
    if (typeof path !== "string" || typeof kind !== "string" || !CHANGE_KINDS.has(kind)) continue;
    files.push({ path, kind: kind as ChangedFile["kind"] });
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Dosya üreten aracın (`pdf_create` gibi `create` kartı çizen araçlar) sonucundaki çözülmüş yol
 * (`details.path`). Bu araçlar göreli adı Asistan'da çalışma klasörüne değil çıktı klasörüne göre
 * çözer; ham argüman karta kalırsa dosya listesi, Çıktılar kutusu ve belge kartı yanlış yolu
 * gösterir. Kart türü argümansız `describeTool`'dan okunur ki yeni üretici araç ayrıca
 * listelenmeden kapsansın. Başka araçta, hatalı çağrıda ve yol mutlak değilse `undefined` döner.
 */
export function resolvedTargetOf(
  toolName: string,
  result: unknown,
  isError: boolean,
): string | undefined {
  // `write` göreli yolu zaten çalışma klasörüne göre çözer; ham hedef onda doğrudur.
  if (isError || toolName === "write") return undefined;
  // Belge düzenlemesi `output` ile kaynağın klasörüne yazabilir; yerinde düzenlemede de yol aynıdır.
  if (!FILE_EDIT_TOOLS.has(toolName) && describeTool(toolName, {}).kind !== "create") {
    return undefined;
  }
  if (!result || typeof result !== "object") return undefined;
  const path = (result as { details?: { path?: unknown } }).details?.path;
  return typeof path === "string" && isAbsolutePath(path) ? path : undefined;
}

let idCounter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

/**
 * Mesaj kimliği: sağlayıcının `responseId`'si varsa ondan, yoksa mesajın zaman damgasından
 * türetilir. Snapshot yolu ile canlı yol aynı işlevi kullandığı için aynı mesaj her iki yolda
 * aynı kimliği alır; renderer'daki `exists` kontrolü böylece doğru eşleşir ve çift balon oluşmaz.
 * `responseId` legacy/eksik yanıtlarda bulunmayabilir; zaman damgası yeterli benzersizlik verir
 * (iki asistan mesajının aynı milisaniyede bitmesi pratikte görülmez).
 */
const stableMessageId = (m: AssistantMessage): string =>
  m.responseId ? `m-${m.responseId}` : `msg-${m.timestamp.toString(36)}`;

/**
 * Pi oturum olaylarını AgentEvent'e çevirir. Oturum başına bir eşleyici; asistan mesaj kimliğini izler.
 */
export class EventMapper {
  readonly #sessionId: string;
  readonly #lang: Locale;
  readonly #hasQueuedContinuation: () => boolean;
  #runId: string | undefined;
  #messageId: string | undefined;
  #lastStop: string | undefined;
  /**
   * Açık turda kullanıcı Durdur'a bastı. Araç sürerken durdurulan turda Pi bir sonraki model
   * isteğini iptal edilmiş sinyalle açar; istek kurulumu (`lazyStream`) sağlayıcıdan bağımsız
   * olarak "This operation was aborted" metniyle `stopReason: "error"` döner. Bu kesme hata bandı
   * değil, durdurulmuş turdur.
   */
  #stopRequested = false;
  /** `write` çağrılarının argümanları; sonuçta diff olmadığı için bitişte içerikten üretilir. */
  readonly #writeArgs = new Map<string, Record<string, unknown>>();
  /** Canlı sayaç önizlemesinin son yayın anı; çağrı başına saniyede bir ölçü yayınlanır. */
  readonly #previewAt = new Map<string, number>();

  constructor(
    sessionId: string,
    lang: Locale = "tr",
    /**
     * Tur bitince Pi'nin turu kendiliğinden sürdürüp sürdüreceği: kuyrukta bekleyen devam mesajı
     * (dürtme ya da yönlendirme) var mı. Verilmezse tur her `agent_end`'de kapanır.
     */
    hasQueuedContinuation: () => boolean = () => false,
  ) {
    this.#sessionId = sessionId;
    this.#lang = lang;
    this.#hasQueuedContinuation = hasQueuedContinuation;
  }

  /**
   * Açık turun kimliği; tur yoksa undefined. Snapshot'a taşınır: renderer, açılış anında süren
   * turu geri kurabilsin (aksi hâlde akış olayları stale-run kapısında düşerdi).
   */
  get runId(): string | undefined {
    return this.#runId;
  }

  /** Açık diziyi kapatır: tur özeti ve "boşta" durumu yayar. Açık dizi yoksa bir şey yaymaz. */
  #closeRun(base: { sessionId: string; at: number }): AgentEventInput[] {
    const runId = this.#runId;
    if (!runId) return [];
    this.#runId = undefined;
    this.#stopRequested = false;
    return [
      { ...base, type: "run_end", runId, aborted: this.#lastStop === "aborted" },
      { ...base, type: "status", status: "idle" },
    ];
  }

  /** Kullanıcı açık turu durdurdu; tur kapanana dek gelen hata yanıtı kesme sayılır. */
  noteStop(): void {
    if (this.#runId) this.#stopRequested = true;
  }

  /**
   * Model aracın girdisini üretirken (yazma/düzenleme) kartın canlı sayacı. Ölçü kısmi girdiden
   * hesaplanır ve yayın sıklığı saniyede birle sınırlanır (ZCode'un akış önizlemesi de ~1 sn);
   * ilk ölçü beklemeden gider ki satır hemen doğsun. Girdi tamamlanınca (`toolcall_end`) son ölçü
   * sınırı beklemeden yayınlanır — çağrı başlamadan önceki son değer odur.
   */
  #previewEvents(
    base: { sessionId: string; at: number },
    e: ToolCallStreamEvent,
  ): AgentEventInput[] {
    const block = e.type === "toolcall_end" ? e.toolCall : e.partial.content[e.contentIndex];
    if (block?.type !== "toolCall") return [];
    const args = (block.arguments ?? {}) as Record<string, unknown>;
    const stat = liveChangeStat(block.name, args);
    if (!stat || (stat.added === 0 && stat.removed === 0)) return [];
    const last = this.#previewAt.get(block.id);
    if (last !== undefined && e.type !== "toolcall_end" && base.at - last < PREVIEW_INTERVAL_MS)
      return [];
    this.#previewAt.set(block.id, base.at);
    const info = describeTool(block.name, args, this.#lang);
    return [
      {
        ...base,
        type: "tool_preview",
        toolCallId: block.id,
        toolName: block.name,
        kind: info.kind,
        title: info.title,
        ...(info.target ? { target: info.target } : {}),
        added: stat.added,
        removed: stat.removed,
      },
    ];
  }

  map(ev: AgentSessionEvent): AgentEventInput[] {
    const base = { sessionId: this.#sessionId, at: Date.now() };
    switch (ev.type) {
      case "queue_update":
        // Kuyruk durumu değişti (yönlendirme/takip eklendi ya da teslim edildi); arayüz şeridi
        // bekleyen mesajları bu olaydan öğrenir.
        return [
          {
            ...base,
            type: "queue",
            steering: [...ev.steering],
            followUp: [...ev.followUp],
          },
        ];
      case "agent_start": {
        // Tur sonu dürtmesinden sonra Pi döngüye yeniden girer; dizi kapanmadığı için yeni run açılmaz.
        if (this.#runId) {
          // Yeniden deneme sonrası tur kaldığı yerden sürer: "bekliyor"da takılan durum
          // "çalışıyor"a döner ki composer onay bekliyormüş gibi görünmesin.
          return [{ ...base, type: "status", status: "working" }];
        }
        this.#runId = nextId("run");
        return [
          { ...base, type: "run_start", runId: this.#runId },
          { ...base, type: "status", status: "working" },
        ];
      }
      case "message_start": {
        // Kimlik mesajın kendi alanlarından türetilir: snapshot'tan yüklenen aynı mesajla eşleşir.
        if (ev.message.role === "assistant") this.#messageId = stableMessageId(ev.message);
        return [];
      }
      case "message_update": {
        const e = ev.assistantMessageEvent;
        // "done" ve "error" varyantlarında mesaj başka alanla taşınır; diğerlerinde akış `partial`'dır.
        if (!this.#messageId)
          this.#messageId = stableMessageId(
            e.type === "done" ? e.message : e.type === "error" ? e.error : e.partial,
          );
        const messageId = this.#messageId;
        if (e.type === "text_delta")
          return [{ ...base, type: "text_delta", messageId, delta: e.delta }];
        if (e.type === "thinking_delta")
          return [{ ...base, type: "thinking_delta", messageId, delta: e.delta }];
        if (e.type === "thinking_end") return [{ ...base, type: "thinking_end", messageId }];
        // Araç girdisi akarken (yazma/düzenleme) kartın canlı sayacı: satır erken doğar ve
        // `+N −N` içerik büyüdükçe artar — ZCode'un akış önizlemesiyle aynı davranış.
        if (e.type === "toolcall_start" || e.type === "toolcall_delta" || e.type === "toolcall_end")
          return this.#previewEvents(base, e);
        return [];
      }
      case "message_end": {
        // Gizli dürtme modele teslim edildi: çizilmeyen sınır öğesi düşer ki dürtme yanıtı bir araç
        // çağırsa da önceki asıl rapor katlanmış çalışma dizisine gömülmesin. Pi, özel mesajı da
        // `message_start`/`message_end` ile yayar; iki kez sınır üretmemek için yalnızca bitişe bakılır.
        if (ev.message.role !== "assistant") {
          const boundary = nudgeBoundary(ev.message);
          if (boundary) return [{ ...base, type: "boundary", kind: boundary.kind }];
          return ev.message.role === "user" ? [{ ...base, type: "user_message" }] : [];
        }
        const msg = ev.message as AssistantMessage;
        const messageId = this.#messageId ?? stableMessageId(msg);
        this.#messageId = undefined;
        const stopReason =
          this.#stopRequested && msg.stopReason === "error" ? "aborted" : msg.stopReason;
        this.#lastStop = stopReason;
        const thinking = thinkingOf(msg);
        const out: AgentEventInput[] = [
          {
            ...base,
            type: "message_end",
            messageId,
            text: textOf(msg.content),
            model: msg.model,
            provider: msg.provider,
            stopReason,
            ...(thinking ? { thinking } : {}),
          },
          { ...base, type: "usage", usage: toUsage(msg.usage), model: msg.model },
        ];
        if (stopReason === "error" && msg.errorMessage) {
          // Sebep kodu metinle birlikte taşınır: sağlayıcı hatası en sık bu yoldan gelir ve
          // tanı paketi sayımı yalnız kodlarla yapılabilir (`reason` yoksa "unknown" sayılıyordu).
          const { message, reason } = explainProviderErrorWithReason(msg.errorMessage, this.#lang);
          out.push({ ...base, type: "error", message, reason });
        }
        return out;
      }
      case "tool_execution_start": {
        const args = (ev.args ?? {}) as Record<string, unknown>;
        const info = describeTool(ev.toolName, args, this.#lang);
        if (ev.toolName === "write") this.#writeArgs.set(ev.toolCallId, args);
        return [
          {
            ...base,
            type: "tool_start",
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            kind: info.kind,
            title: info.title,
            ...(info.target ? { target: info.target } : {}),
            ...(info.command ? { command: info.command } : {}),
          },
        ];
      }
      case "tool_execution_update": {
        const output = outputOfResult(ev.partialResult) ?? "";
        return output ? [{ ...base, type: "tool_update", toolCallId: ev.toolCallId, output }] : [];
      }
      case "tool_execution_end": {
        const args = this.#writeArgs.get(ev.toolCallId);
        this.#writeArgs.delete(ev.toolCallId);
        // Önizleme defteri de kapanır: kimlikler oturum boyunca birikir, sayaç artık diff'ten okunur.
        this.#previewAt.delete(ev.toolCallId);
        const output = outputOfTool(ev.toolName, args, ev.result, ev.isError);
        const searchBackend = searchBackendOf(ev.toolName, ev.result);
        const target = resolvedTargetOf(ev.toolName, ev.result, ev.isError);
        const schedule = scheduleResultOf(ev.toolName, ev.result, ev.isError);
        const sandboxed = sandboxedOf(ev.toolName, ev.result);
        const changedFiles = changedFilesOf(ev.result);
        // Durdur'un kestiği çağrı ("Command aborted") hata değil, durdurulmuş sayılır.
        const stopped = this.#stopRequested && ev.isError;
        return [
          {
            ...base,
            type: "tool_end",
            toolCallId: ev.toolCallId,
            isError: ev.isError,
            ...(stopped ? { stopped } : {}),
            ...(output ? { output } : {}),
            ...(searchBackend ? { searchBackend } : {}),
            ...(target ? { target } : {}),
            ...(schedule ? { schedule } : {}),
            ...(sandboxed ? { sandboxed } : {}),
            ...(changedFiles ? { changedFiles } : {}),
          },
        ];
      }
      case "agent_end": {
        if (ev.willRetry) return [];
        // Kuyrukta devam mesajı varsa (tur sonu dürtmesi, yönlendirme) tur sürüyor: dizi açık kalır
        // ve durum "working" kalır ki arayüz boşta görünüp gelen mesajı yeni tur sanmasın.
        if (this.#hasQueuedContinuation()) return [];
        return this.#closeRun(base);
      }
      case "agent_settled": {
        // Emniyet kemeri: kuyruk boşalsa da dizi kapanmadıysa (mesaj kuyruktan düştü) burada kapanır.
        return this.#closeRun(base);
      }
      case "auto_retry_start":
        return [
          { ...base, type: "status", status: "waiting" },
          {
            ...base,
            type: "retry",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            // Yeniden deneme bandı da ham sağlayıcı metnini taşır; anahtar yansıması maskelenir.
            message: maskSecrets(ev.errorMessage),
          },
        ];
      default:
        return [];
    }
  }
}

/** Kaydedilmiş gizli dürtme mesajı (transcript'te çizilmeyen sınır öğesine dönüşür). */
interface NudgeMessage {
  role: "custom";
  customType: string;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

/** Dürtme mesajıysa sınır bilgisi; tanınmayan ya da eksik `kind` sınır üretmez. */
function nudgeBoundary(m: AgentMessage): { kind: NudgeKind; at: number } | undefined {
  const c = m as Partial<NudgeMessage>;
  if (c.role !== "custom" || c.customType !== NUDGE_TYPE || c.display !== false) return undefined;
  const details = c.details;
  const kind =
    typeof details === "object" && details !== null
      ? (details as { kind?: unknown }).kind
      : undefined;
  const parsed = NudgeKind.safeParse(kind);
  if (!parsed.success) return undefined;
  return { kind: parsed.data, at: typeof c.timestamp === "number" ? c.timestamp : Date.now() };
}

/**
 * Hiç çalışmadan durdurulan araç çağrısının oturum kaydı (`appendCustomEntry`; modele gitmez).
 * Pi engellenen çağrının sonucunu `tool_result` işleyicilerinden geçirmeden `details: {}` ile
 * yazar; işaret oraya konamadığı için ayrı kayıt tutulur ve açılışta kart durumuna uygulanır.
 */
export const TOOL_STOP_TYPE = "codezal-tool-stop";

/** Plan engeli ve hook reddi çağrıyı hiç çalıştırmaz; "stopped" süren çağrıyı Durdur kesti. */
export type ToolStop = "blocked" | "denied" | "stopped";

/** Oturum kayıtlarından durdurulan çağrılar (araç kimliği → engel / ret / Durdur). */
export function toolStopsOf(entries: readonly unknown[]): Map<string, ToolStop> {
  const stops = new Map<string, ToolStop>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (e.type !== "custom" || e.customType !== TOOL_STOP_TYPE) continue;
    const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as {
      toolCallId?: unknown;
      reason?: unknown;
    };
    if (typeof data.toolCallId !== "string") continue;
    if (data.reason === "blocked" || data.reason === "denied" || data.reason === "stopped")
      stops.set(data.toolCallId, data.reason);
  }
  return stops;
}

/**
 * Kaydedilmiş mesajlardan transcript üretir (oturum açma). `stops` verilirse hiç çalışmamış
 * çağrılar "hata" yerine "engellendi"/"reddedildi" durumuyla döner (canlı akıştaki gibi).
 */
export function transcriptFromMessages(
  messages: readonly AgentMessage[],
  lang: Locale = "tr",
  stops: ReadonlyMap<string, ToolStop> = new Map(),
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  const toolArgs = new Map<string, Record<string, unknown>>();
  // Tur başlangıcı: süre, asistan mesajının zamanı ile turun kullanıcı mesajı arasındaki fark.
  let turnStart: number | undefined;

  for (const m of messages) {
    const boundary = nudgeBoundary(m);
    if (boundary) {
      items.push({ type: "boundary", id: nextId("b"), kind: boundary.kind, at: boundary.at });
      continue;
    }
    if (m.role === "user") {
      const u = m as UserMessage;
      turnStart = u.timestamp;
      const images = imagesOf(u.content);
      items.push({
        type: "user",
        id: nextId("u"),
        text: textOf(u.content),
        at: u.timestamp,
        ...(images ? { images } : {}),
      });
      continue;
    }
    if (m.role === "assistant") {
      const a = m as AssistantMessage;
      const thinking = thinkingOf(a);
      items.push({
        type: "assistant",
        id: stableMessageId(a),
        text: textOf(a.content),
        model: a.model,
        provider: a.provider,
        streaming: false,
        at: a.timestamp,
        ...(thinking ? { thinking } : {}),
        // Hata/kesme ile biten tur, yeniden açılan oturumda da yarım görünsün.
        ...(a.stopReason && a.stopReason !== "stop" ? { stopReason: a.stopReason } : {}),
        ...(turnStart !== undefined && a.timestamp >= turnStart
          ? { durationMs: a.timestamp - turnStart }
          : {}),
      });
      for (const c of a.content) {
        if (c.type !== "toolCall") continue;
        const info = describeTool(c.name, c.arguments ?? {}, lang);
        toolIndex.set(c.id, items.length);
        if (c.name === "write") toolArgs.set(c.id, c.arguments ?? {});
        items.push({
          type: "tool",
          id: c.id,
          toolName: c.name,
          kind: info.kind,
          status: "running",
          title: info.title,
          startedAt: a.timestamp,
          ...(info.target ? { target: info.target } : {}),
          ...(info.command ? { command: info.command } : {}),
        });
      }
      continue;
    }
    if (m.role === "toolResult") {
      const r = m as ToolResultMessage;
      const idx = toolIndex.get(r.toolCallId);
      if (idx === undefined) continue;
      const item = items[idx];
      if (item?.type !== "tool") continue;
      const output = outputOfTool(
        item.toolName,
        toolArgs.get(r.toolCallId),
        { content: r.content, details: r.details },
        r.isError,
      );
      // Pi `details`'i oturum dosyasına yazıyor: etiket yeniden açılışta da kalır.
      const result = { content: r.content, details: r.details };
      const searchBackend = searchBackendOf(item.toolName, result);
      const target = resolvedTargetOf(item.toolName, result, r.isError);
      const schedule = scheduleResultOf(item.toolName, result, r.isError);
      const sandboxed = sandboxedOf(item.toolName, result);
      const changedFiles = changedFilesOf(result);
      items[idx] = {
        ...item,
        status: stops.get(r.toolCallId) ?? (r.isError ? "error" : "done"),
        endedAt: r.timestamp,
        ...(output ? { output } : {}),
        ...(searchBackend ? { searchBackend } : {}),
        ...(target ? { target } : {}),
        ...(schedule ? { schedule } : {}),
        ...(sandboxed ? { sandboxed } : {}),
        ...(changedFiles ? { changedFiles } : {}),
      };
    }
  }
  return items;
}
