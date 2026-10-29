import type {
  AgentEvent,
  BackgroundJob,
  ExtensionUiRequest,
  GoalState,
  ModelRef,
  PermissionMode,
  PermissionRequest,
  PlanReview,
  QuestionRequest,
  ReviewCounts,
  ReviewFinding,
  SubagentRun,
  ThinkingLevel,
  ToolCallItem,
  TranscriptItem,
  Usage,
} from "@codezal/contracts";
import { applyTrace, emptyTrace, type TraceState } from "../lib/trace";

export type SessionStatus = "idle" | "working" | "waiting";

/** Kod incelemesi (deneysel) koşusunun arayüz durumu; `review` olayından beslenir. */
export interface ReviewRuntime {
  phase: "started" | "done";
  /** Bulguların ait olduğu kullanıcı turu; Transcript tur kapanışını bununla eşler. */
  turn: number;
  files: string[];
  counts?: ReviewCounts | undefined;
  findings?: ReviewFinding[] | undefined;
  usage?: Usage | undefined;
  /** Koşu tamamlanamadıysa hata notu; boş bulgu listesinden ayırır. */
  error?: string | undefined;
}

export interface SessionRuntime {
  transcript: TranscriptItem[];
  status: SessionStatus;
  /**
   * Açık turun kimliği: `run_start` açar, `run_end` kapatır. Tur kapalıyken gelen akış olayları
   * (text_delta, tool_*, message_end, boundary) yoksayılır — gecikmiş eski tur olaylarının yeni
   * tura sızmasını engeller (stale run koruması).
   */
  activeRunId: string | null;
  /**
   * Yanıt bekleyen izin istekleri (geliş sırasıyla). Paralel alt ajanlar ve ayrık koşular aynı
   * anda sorabilir; ayrık koşunun isteği `run` alanını taşır. Kart yalnız `permission_resolved`
   * ile kalkar: durum olayına bağlamak başka bir aracın "working" olayında bekleyen kartı siliyor,
   * kapı sonsuza dek bekliyordu.
   */
  permissions: PermissionRequest[];
  /** Bekleyen plan onayı (`plan_exit`); kart cevaplanınca ya da tur bitince silinir. */
  planReview: PlanReview | null;
  /** Bekleyen soru (`question`); kart cevaplanınca ya da tur bitince silinir. */
  question: QuestionRequest | null;
  /** Bekleyen eklenti `ctx.ui` isteği (confirm/select/input); kart cevaplanınca silinir. */
  extensionUi: ExtensionUiRequest | null;
  usage: Usage;
  lastError: string | null;
  runStartedAt: number | null;
  lastDurationMs: number | null;
  /** Son turdan sonra bağlam penceresi doluluğu (Pi tahmini). */
  context: { tokens: number; contextWindow: number; percent: number } | null;
  /** Oturumun izin modu; açılışta main'den gelir, bilinmiyorsa genel tercih gösterilir. */
  permission: PermissionMode | null;
  /** Arka plan komutları (`bash_background`); Ajanlar kutusu buradan beslenir. */
  backgrounds: BackgroundJob[];
  /**
   * Yerli alt ajan koşuları (keşif, denetim, inceleme, ajan); liste tam durumu taşır, tur
   * sınırından bağımsız sürer. Ajanlar kutusu bu satırları da gösterir.
   */
  subagents: SubagentRun[];
  /** Son tur sonu kontrolü (Ayarlar > Kod incelemesi); yeni tur başlayınca silinir. */
  checks: { ok: boolean; commands: string[]; failed?: string } | null;
  /** Kod incelemesi (deneysel): son koşunun durumu; yeni tur başlayınca silinir. */
  review: ReviewRuntime | null;
  /** Kalıcı hedef (`/goal`); açılışta main'den, sonra goal olaylarından gelir. */
  goal: GoalState | null;
  /**
   * Kuyrukta bekleyen mesajlar (Pi `queue_update`): `steering` sıradaki çağrıda teslim edilecek
   * yönlendirmeler, `followUp` tur tamamen bitince işlenecek takip mesajları.
   */
  queue: { steering: string[]; followUp: string[] };
  /**
   * Oturumun kendi modeli ve düşünme seviyesi: açılışta main'den, sonra çip seçiminden ve yanıtı
   * üreten modelden gelir. Bilinmiyorsa (null) genel tercih gösterilir. Çip eskiden yalnızca genel
   * tercihi gösteriyordu; DeepSeek ile süren oturuma dönünce "Kimi" yazıyordu.
   */
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  /** Tanılama izi: olay akışından türetilen tur/adım/araç kayıtları (sınırlı, yalnız bellekte). */
  trace: TraceState;
}

export const emptyRuntime = (): SessionRuntime => ({
  transcript: [],
  status: "idle",
  activeRunId: null,
  permissions: [],
  planReview: null,
  question: null,
  extensionUi: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  lastError: null,
  runStartedAt: null,
  lastDurationMs: null,
  context: null,
  permission: null,
  backgrounds: [],
  subagents: [],
  checks: null,
  review: null,
  goal: null,
  queue: { steering: [], followUp: [] },
  model: null,
  thinking: null,
  trace: emptyTrace(),
});

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/**
 * Tur kapsamındaki olay türleri: yalnız `run_start` ile `run_end` arasında uygulanır.
 * Durum/kuyruk/alt ajan gibi olaylar tur dışından da gelebilir, kapıya girmez.
 */
const RUN_SCOPED_EVENTS = new Set([
  "text_delta",
  "thinking_delta",
  "thinking_end",
  "tool_preview",
  "tool_start",
  "tool_update",
  "tool_end",
  "message_end",
  "boundary",
]);

function updateItem(
  items: TranscriptItem[],
  id: string,
  fn: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return items;
  const next = items.slice();
  const cur = next[idx];
  if (cur) next[idx] = fn(cur);
  return next;
}

/** Olayı runtime'a uygular (saf fonksiyon, test edilebilir). */
export function reduceEvent(rt: SessionRuntime, ev: AgentEvent): SessionRuntime {
  const trace = applyTrace(rt.trace, ev);
  const next = reduceCore(rt, ev);
  return trace === rt.trace ? next : { ...next, trace };
}

/** Görünür duruma dokunan kısım; tanılama izi `reduceEvent` sarmalayıcısında eklenir. */
function reduceCore(rt: SessionRuntime, ev: AgentEvent): SessionRuntime {
  // Yalnız açık tur içinde anlamı olan akış olayları: tur kapalıyken gelenleri (gecikmiş eski tur
  // olayları, yeniden deneme artıkları) yoksayarız; transcript'e sızmazlar.
  if (RUN_SCOPED_EVENTS.has(ev.type) && rt.activeRunId === null) return rt;
  switch (ev.type) {
    case "run_start":
      // Yeni tur temiz sayfa açar: bitmiş arka plan satırları düşer, sürenler kalır.
      return {
        ...rt,
        status: "working",
        activeRunId: ev.runId,
        runStartedAt: ev.at,
        lastError: null,
        checks: null,
        review: null,
        backgrounds: rt.backgrounds.filter((b) => b.status === "running"),
      };
    case "background_start":
      return {
        ...rt,
        backgrounds: [
          ...rt.backgrounds,
          {
            id: ev.jobId,
            command: ev.command,
            ...(ev.description ? { description: ev.description } : {}),
            status: "running",
            startedAt: ev.at,
          },
        ],
      };
    case "background_end": {
      // Başlangıcı kaçmışsa (ör. oturum açılışından önce bitmişse) kaydedecek komut yok, yoksay.
      let seen = false;
      const backgrounds = rt.backgrounds.map((b) => {
        if (b.id !== ev.jobId) return b;
        seen = true;
        return {
          ...b,
          status: ev.status,
          endedAt: ev.at,
          ...(ev.code === undefined ? {} : { code: ev.code }),
        };
      });
      return seen ? { ...rt, backgrounds } : rt;
    }
    // Alt ajan durumu: liste tam durumu taşır, boş dizi temizler.
    // Tur başlangıcı bu listeye dokunmaz: koşular tur bitince de sürebilir.
    case "subagents":
      return { ...rt, subagents: ev.runs };
    case "status":
      return {
        ...rt,
        status: ev.status,
        planReview: ev.status === "waiting" ? rt.planReview : null,
      };
    case "queue":
      return { ...rt, queue: { steering: [...ev.steering], followUp: [...ev.followUp] } };
    // Gizli dürtme teslim edildi: çizilmeyen sınır öğesi. Katlama hesabı bunu tur başlangıcı
    // sayar; dürtme yanıtı araç çağırsa da önceki asıl rapor görünür kalır.
    case "boundary":
      return {
        ...rt,
        transcript: [
          ...rt.transcript,
          { type: "boundary", id: uid("b"), kind: ev.kind, at: ev.at },
        ],
      };
    // Yerel komut sonucu (`/model`, `/mod`, `/düşünme`, `/compact`): sohbete ayraç satırı düşer.
    // İşaret main'de meta'ya da yazılır, yeniden açılan oturumda satırlar snapshot'tan gelir;
    // aynı kimlik ikinci kez uygulanırsa satır tekrarlanmaz.
    case "marker":
      return rt.transcript.some((i) => i.id === ev.marker.id)
        ? rt
        : { ...rt, transcript: [...rt.transcript, ev.marker] };
    case "text_delta":
    case "thinking_delta": {
      const exists = rt.transcript.some((i) => i.id === ev.messageId);
      let transcript = rt.transcript;
      if (!exists) {
        transcript = [
          ...transcript,
          { type: "assistant", id: ev.messageId, text: "", streaming: true, at: ev.at },
        ];
      }
      transcript = updateItem(transcript, ev.messageId, (i) =>
        i.type !== "assistant"
          ? i
          : ev.type === "text_delta"
            ? { ...i, text: i.text + ev.delta }
            : { ...i, thinking: (i.thinking ?? "") + ev.delta },
      );
      return { ...rt, transcript };
    }
    case "message_end": {
      const exists = rt.transcript.some((i) => i.id === ev.messageId);
      const durationMs = rt.runStartedAt ? ev.at - rt.runStartedAt : undefined;
      const patch = {
        text: ev.text,
        streaming: false,
        ...(ev.thinking ? { thinking: ev.thinking } : {}),
        ...(ev.model ? { model: ev.model } : {}),
        ...(ev.provider ? { provider: ev.provider } : {}),
        ...(ev.stopReason ? { stopReason: ev.stopReason } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      // Yanıtı gerçekten üreten model çipe yansır (oturum dosyasından geri yüklenen model dahil).
      const model = ev.model && ev.provider ? { provider: ev.provider, id: ev.model } : rt.model;
      const transcript = exists
        ? updateItem(rt.transcript, ev.messageId, (i) =>
            i.type === "assistant" ? { ...i, ...patch } : i,
          )
        : ev.text.trim()
          ? [
              ...rt.transcript,
              { type: "assistant" as const, id: ev.messageId, at: ev.at, ...patch },
            ]
          : rt.transcript;
      return { ...rt, transcript, model };
    }
    case "tool_preview": {
      // Satır akıştan doğar: model henüz aracın girdisini üretiyor, `+N −N` canlı okunur. Aynı
      // çağrının sonraki ölçüleri satırı yerinde günceller; yeni satır açılmaz.
      if (rt.transcript.some((i) => i.id === ev.toolCallId))
        return {
          ...rt,
          transcript: updateItem(rt.transcript, ev.toolCallId, (i) =>
            i.type === "tool"
              ? {
                  ...i,
                  added: ev.added,
                  removed: ev.removed,
                  ...(ev.target ? { target: ev.target } : {}),
                }
              : i,
          ),
        };
      const preview: ToolCallItem = {
        type: "tool",
        id: ev.toolCallId,
        toolName: ev.toolName,
        kind: ev.kind,
        status: "running",
        title: ev.title,
        startedAt: ev.at,
        preview: true,
        added: ev.added,
        removed: ev.removed,
        ...(ev.target ? { target: ev.target } : {}),
      };
      return { ...rt, transcript: [...rt.transcript, preview] };
    }
    case "tool_start": {
      // Çağrı başladı: akıştan doğan satır varsa devralınır (kimlik aynıdır), yoksa yenisi açılır.
      // Devralmada başlangıç anı ve canlı ölçü korunur — sayaç çağrı başlarken sıfırlanmasın.
      const started = rt.transcript.find((i) => i.id === ev.toolCallId);
      const previewStartedAt = started?.type === "tool" ? started.startedAt : undefined;
      const fresh: ToolCallItem = {
        type: "tool",
        id: ev.toolCallId,
        toolName: ev.toolName,
        kind: ev.kind,
        status: "running",
        title: ev.title,
        startedAt: previewStartedAt ?? ev.at,
        ...(ev.target ? { target: ev.target } : {}),
        ...(ev.command ? { command: ev.command } : {}),
      };
      return started
        ? {
            ...rt,
            transcript: updateItem(rt.transcript, ev.toolCallId, (i) =>
              i.type === "tool"
                ? {
                    ...fresh,
                    ...(i.added === undefined ? {} : { added: i.added }),
                    ...(i.removed === undefined ? {} : { removed: i.removed }),
                  }
                : i,
            ),
          }
        : { ...rt, transcript: [...rt.transcript, fresh] };
    }
    case "tool_update":
      return {
        ...rt,
        transcript: updateItem(rt.transcript, ev.toolCallId, (i) =>
          i.type === "tool" ? { ...i, output: (i.output ?? "") + ev.output } : i,
        ),
      };
    case "tool_end":
      return {
        ...rt,
        transcript: updateItem(rt.transcript, ev.toolCallId, (i) => {
          if (i.type !== "tool") return i;
          // Canlı ölçü ve önizleme bayrağı düşer: biten çağrının sayacı artık diff çıktısından
          // okunur (canlı ölçü akış sırasındaki bir tahmindi, son değer gerçek diff'tir).
          const done = { ...i };
          delete done.added;
          delete done.removed;
          delete done.preview;
          return {
            ...done,
            status: ev.blocked
              ? "blocked"
              : ev.denied
                ? "denied"
                : ev.stopped
                  ? "stopped"
                  : ev.isError
                    ? "error"
                    : "done",
            endedAt: ev.at,
            ...(ev.output !== undefined ? { output: ev.output } : {}),
            // Arama kartı hangi yolla aradığını söyler (yerleşik arama / DuckDuckGo).
            ...(ev.searchBackend ? { searchBackend: ev.searchBackend } : {}),
            // Araç yolu kendisi çözdüyse (pdf_create) kart ham argümanı değil yazılan yolu taşır.
            ...(ev.target ? { target: ev.target } : {}),
            // Zamanlanmış görev çağrısı: tur sonundaki görev kartı bunu çizer.
            ...(ev.schedule ? { schedule: ev.schedule } : {}),
            // Komut macOS korumalı alanında koştu: terminal kartı "Korumalı" der.
            ...(ev.sandboxed ? { sandboxed: true } : {}),
            // Terminal komutu/alt ajanın değiştirdiği dosyalar tur dosya listesine girer.
            ...(ev.changedFiles ? { changedFiles: ev.changedFiles } : {}),
          };
        }),
      };
    case "usage":
      return {
        ...rt,
        usage: {
          input: rt.usage.input + ev.usage.input,
          output: rt.usage.output + ev.usage.output,
          cacheRead: rt.usage.cacheRead + ev.usage.cacheRead,
          cacheWrite: rt.usage.cacheWrite + ev.usage.cacheWrite,
          cost: rt.usage.cost + ev.usage.cost,
        },
      };
    case "permission_request": {
      const id = ev.request.requestId;
      const permissions = [...rt.permissions.filter((r) => r.requestId !== id), ev.request];
      // Ayrık koşunun sorusu ana oturumun turunu bekletmez; durum yalnız kendi isteğinde değişir.
      return ev.request.run ? { ...rt, permissions } : { ...rt, permissions, status: "waiting" };
    }
    case "permission_resolved": {
      const permissions = rt.permissions.filter((r) => r.requestId !== ev.requestId);
      return permissions.length === rt.permissions.length ? rt : { ...rt, permissions };
    }
    // Koşu bitti: bekleyen kartı kalmışsa kalkar (iptalde istek zaten reddedilmiştir).
    case "worker_ended": {
      const permissions = rt.permissions.filter((r) => r.run?.id !== ev.workerId);
      return permissions.length === rt.permissions.length ? rt : { ...rt, permissions };
    }
    case "plan_review":
      return { ...rt, planReview: ev.review, status: "waiting" };
    case "question_request":
      return { ...rt, question: ev.request, status: "waiting" };
    // Eklenti `ctx.ui` isteği: kart gösterilir, cevap karttan `sessions:respondExtensionUi` ile döner.
    // Durum değiştirilmez: istek tur dışında (kullanıcı komutu) da gelebilir; "waiting" bırakmak
    // oturumu kalıcı bekler durumda gösterirdi.
    case "extension_ui_request":
      return { ...rt, extensionUi: ev.request };
    // Bekleyen istekler iptal edildi (tur iptali/oturum kapanışı): kart kalkar.
    case "extension_ui_cancelled":
      return rt.extensionUi && ev.requestIds.includes(rt.extensionUi.requestId)
        ? { ...rt, extensionUi: null }
        : rt;
    case "permission_mode":
      return { ...rt, permission: ev.mode };
    case "run_end": {
      const transcript = rt.transcript
        .map((i) => (i.type === "assistant" && i.streaming ? { ...i, streaming: false } : i))
        // Akıştan doğup hiç çalışmayan satırlar düşer: üretim kesildiğinde (durdurma, hata) araç
        // çağrılmadı, dolayısıyla ortada çalışmış bir çağrı da yok.
        .filter((i) => !(i.type === "tool" && i.preview && i.status === "running"));
      return {
        ...rt,
        transcript,
        status: "idle",
        activeRunId: null,
        // Tur bitti: kendi istekleri de bitmiştir; ayrık koşularınki tur dışında sürer.
        permissions: rt.permissions.filter((r) => r.run),
        planReview: null,
        question: null,
        // Tur bitti: kuyrukta bekleyen kalmadı (Pi devam mesajı varsa run_end yayınlamaz).
        queue: { steering: [], followUp: [] },
        lastDurationMs: rt.runStartedAt ? ev.at - rt.runStartedAt : rt.lastDurationMs,
        runStartedAt: null,
      };
    }
    case "error":
      return { ...rt, lastError: ev.message };
    // Pi yeniden deniyor: hata bandı kalkar, durum "bekliyor".
    case "retry":
      return { ...rt, lastError: null, status: "waiting" };
    case "context":
      return {
        ...rt,
        context: { tokens: ev.tokens, contextWindow: ev.contextWindow, percent: ev.percent },
      };
    case "checks":
      return {
        ...rt,
        checks: { ok: ev.ok, commands: ev.commands, ...(ev.failed ? { failed: ev.failed } : {}) },
      };
    case "review":
      return {
        ...rt,
        review: {
          phase: ev.phase,
          turn: ev.turn,
          files: ev.files,
          ...(ev.counts ? { counts: ev.counts } : {}),
          ...(ev.findings ? { findings: ev.findings } : {}),
          ...(ev.usage ? { usage: ev.usage } : {}),
          ...(ev.error ? { error: ev.error } : {}),
        },
      };
    case "goal":
      return { ...rt, goal: ev.goal };
    default:
      return rt;
  }
}
