import { z } from "zod";
import { GoalState, PermissionMode } from "./domain.js";
import { ExtensionUiRequest } from "./plugins.js";
import { ReviewCounts, ReviewFinding } from "./review.js";
import {
  ChangedFile,
  MarkerItem,
  NudgeKind,
  ScheduleToolResult,
  SearchBackend,
  ToolKind,
  TranscriptItem,
} from "./transcript.js";

export const Usage = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
  /** Sağlayıcı fiyatına göre hesaplanan maliyet (USD). Fiyat bilinmiyorsa 0. */
  cost: z.number().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

export const PermissionRequest = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  kind: ToolKind,
  target: z.string().optional(),
  command: z.string().optional(),
  dangerous: z.boolean().default(false),
  /**
   * Ayrık ajan koşusunun isteği ana oturumda sorulur; kart koşuya aittir ve ana oturumun tek
   * bekleyen isteğinden ayrı tutulur (ana oturumun durum değişimi onu silmez).
   */
  run: z.object({ id: z.string(), title: z.string() }).optional(),
  /**
   * Bellekteki alt ajanın isteği ana oturumun kapısından geçer ve onun bekleyen isteği sayılır;
   * bu alan yalnız karttaki etiket içindir (hangi ajan soruyor).
   */
  agent: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionDecision = z.enum(["allow", "deny", "allow-session"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

/** Plan onayı: `plan_exit` aracı plan dosyasını kullanıcıya sunar; karar `plans:respond` ile döner. */
export const PlanReview = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  /** Plan dosyasının içeriği (Markdown). */
  plan: z.string(),
  path: z.string(),
  /** Onaylanınca dönülecek izin modu. */
  returnTo: PermissionMode,
});
export type PlanReview = z.infer<typeof PlanReview>;

export const PlanDecision = z.object({
  approved: z.boolean(),
  feedback: z.string().optional(),
  /** Kullanıcı plandan vazgeçti: plan uygulanmaz, tur durur ve oturum plan modundan çıkar. */
  cancelled: z.boolean().optional(),
});
export type PlanDecision = z.infer<typeof PlanDecision>;

/** Soru seçeneği: `description` kartta etiketin altında görünür. */
export const QuestionOption = z.object({ label: z.string(), description: z.string().optional() });
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionItem = z.object({
  question: z.string(),
  /** Seçenek yoksa kullanıcı yalnızca serbest metin yazar. */
  options: z.array(QuestionOption).optional(),
  multiple: z.boolean().default(false),
  /** Kendi yanıtını yazma alanı; varsayılan açık. */
  custom: z.boolean().default(true),
});
export type QuestionItem = z.infer<typeof QuestionItem>;

/** Modelin kullanıcıya sorduğu sorular (`question` aracı); cevap `questions:respond` ile döner. */
export const QuestionRequest = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  questions: z.array(QuestionItem).min(1).max(4),
});
export type QuestionRequest = z.infer<typeof QuestionRequest>;

/** Soru başına seçilen etiketler + serbest metin; boş dizi "yanıt verilmedi" demektir. */
export const QuestionAnswers = z.array(z.array(z.string()));
export type QuestionAnswers = z.infer<typeof QuestionAnswers>;

/**
 * Zarf alanları: üreticiler (EventMapper, motor iç kapıları) bunları taşımaz; sıra numarası ve
 * epoch tek üretici olan `AgentEventBus.emit` tarafından eklenir. Renderer bu ikisiyle snapshot
 * ile canlı akış arasındaki sıra boşluğunu tespit eder.
 */
const envelope = { seq: z.number().int().nonnegative(), epoch: z.string().min(1) };

const base = { sessionId: z.string(), at: z.number(), ...envelope };

/** Arka plan komutu (`bash_background`) yaşam döngüsü kaydı; Ajanlar kutusunun verisi. */
export const BackgroundJobStatus = z.enum(["running", "exited", "stopped", "error"]);
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatus>;

export const BackgroundJob = z.object({
  id: z.string(),
  command: z.string(),
  /** Modelin verdiği kısa açıklama ("Depo özetini çıkar"); arayüzde işin başlığıdır. */
  description: z.string().optional(),
  status: BackgroundJobStatus,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** Süreç çıkış kodu; bitmemiş görevde yok. */
  code: z.number().int().optional(),
});
export type BackgroundJob = z.infer<typeof BackgroundJob>;

/**
 * Alt ajan türü: kim başlattı. `explore` modelin keşif aracı, `agent` kullanıcı tanımlı ajan
 * (Ajanlar sayfasındaki profiller), `audit-*` güvenlik denetimi avcı/doğrulayıcısı, `review*` kod
 * incelemesi, `worker` ayrık (arka plan / worktree) ajan koşusu.
 */
export const SubagentKind = z.enum([
  "explore",
  "agent",
  "audit-hunter",
  "audit-verifier",
  "review",
  "review-verifier",
  "worker",
]);
export type SubagentKind = z.infer<typeof SubagentKind>;

export const SubagentRunStatus = z.enum(["queued", "running", "done", "error", "stopped"]);
export type SubagentRunStatus = z.infer<typeof SubagentRunStatus>;

/**
 * Alt ajan koşusu: canlı izleme başlığı (Ajanlar kutusu ve paneli). Liste replace semantiğiyle
 * gelir; iz (trace) `subagent_trace` olayıyla ayrı akar.
 */
export const SubagentRun = z.object({
  id: z.string(),
  label: z.string(),
  kind: SubagentKind,
  status: SubagentRunStatus,
  /** Koşu henüz başlamadıysa (queued) yok; Ajanlar kutusu süreyi buradan sayar. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** Süren koşuda son etkinliğin kısa metni (araç ya da adım adı). */
  activity: z.string().optional(),
  /** Alt adım sayısı; satırda "{{count}} adım" olarak görünür. */
  steps: z.number().int().nonnegative().optional(),
  /** Modelin verdiği görev metni (kısaltılmış); başlığın tooltip'i ve panel üst şeridi. */
  task: z.string().optional(),
  /** Ana transcript'teki araç kartı; karttan alt ajan sekmesine geçiş bu kimlikle kurulur. */
  parentToolCallId: z.string().optional(),
  /** Alt oturumun modeli ve düşünme seviyesi (ana oturumdan devralınır). */
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  /** Koşunun toplam tüketimi; alt tur her bittiğinde birikir. */
  usage: Usage.optional(),
  /** Çıktı token'ı toplamı (usage.output kısayolu). */
  tokens: z.number().nonnegative().optional(),
  /** Son birkaç saniyenin çıktı hızı; ölçülemiyorsa yok. */
  tokensPerSec: z.number().nonnegative().optional(),
});
export type SubagentRun = z.infer<typeof SubagentRun>;

/** Bir alt ajan koşusunun izi (Ajanlar panelindeki adımlar); oturum açılışında geri gelir. */
export const SubagentTrace = z.object({
  runId: z.string(),
  items: z.array(TranscriptItem),
});
export type SubagentTrace = z.infer<typeof SubagentTrace>;

/**
 * Ayrık ajan koşusu durumu. `review` worktree koşusu bitti, kullanıcı incelemesini bekliyor;
 * `waiting` izin ya da karar sorusu bekliyor.
 */
export const WorkerStatus = z.enum([
  "starting",
  "working",
  "waiting",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

/** Koşu raporu: tamamlanan, süren ve kullanıcıyı bekleyen maddeler. */
export const WorkerReport = z.object({
  done: z.array(z.string()),
  active: z.array(z.string()),
  waiting: z.array(z.string()),
});
export type WorkerReport = z.infer<typeof WorkerReport>;

/** Koşu bitiş özeti: sonuç, değişen dosyalar, süre ve tüketim. */
export const WorkerEndInfo = z.object({
  status: z.enum(["done", "failed", "cancelled"]),
  result: z.string(),
  /** Değişen dosyalar (depo-göreli). */
  files: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  usage: Usage.optional(),
});
export type WorkerEndInfo = z.infer<typeof WorkerEndInfo>;

/** Veriyolundan renderer'a akan normalize ajan olayları (PRD §7.4, §7.7). */
/** Bağlam penceresi doluluğu: token, pencere boyutu ve yüzde. */
export const ContextUsage = z.object({
  tokens: z.number().nonnegative(),
  contextWindow: z.number().nonnegative(),
  percent: z.number().min(0),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run_start"), runId: z.string() }),
  /**
   * Kullanıcı mesajı oturuma girdi (Pi `message_end`, rol `user`). `run_start` anında mesaj henüz
   * oturumda değildir; buna bakan tüketici (yanıt akarken başlık üretimi) bu olayı bekler.
   */
  z.object({ ...base, type: z.literal("user_message") }),
  z.object({ ...base, type: z.literal("text_delta"), messageId: z.string(), delta: z.string() }),
  z.object({
    ...base,
    type: z.literal("thinking_delta"),
    messageId: z.string(),
    delta: z.string(),
  }),
  /** Düşünme bloğu kapandı; metin ya da araç çağrısı bundan sonra gelir. */
  z.object({ ...base, type: z.literal("thinking_end"), messageId: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    kind: ToolKind,
    title: z.string(),
    target: z.string().optional(),
    command: z.string().optional(),
  }),
  /**
   * Araç henüz **çalışmaya başlamadan** (model girdisini üretirken) kartı erken açar ve canlı
   * satır değişimini taşır: yazma/düzenleme sayacı böylece akış boyunca artar. Aynı `toolCallId`
   * ile gelen `tool_start` satırı devralır; çağrı hiç çalışmazsa (üretim kesildi) satır düşer.
   */
  z.object({
    ...base,
    type: z.literal("tool_preview"),
    toolCallId: z.string(),
    toolName: z.string(),
    kind: ToolKind,
    title: z.string(),
    target: z.string().optional(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  z.object({ ...base, type: z.literal("tool_update"), toolCallId: z.string(), output: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool_end"),
    toolCallId: z.string(),
    isError: z.boolean(),
    /** Çağrı hiç çalıştırılmadı, izin katmanınca engellendi (plan modu); hata değil. */
    blocked: z.boolean().optional(),
    /** Çağrıyı kullanıcının PreToolUse hook'u (çıkış 2) reddetti; komut hiç çalışmadı. */
    denied: z.boolean().optional(),
    /** Çağrı sürerken kullanıcı Durdur'a bastı; kesilen komut hata değil, durdurulmuş sayılır. */
    stopped: z.boolean().optional(),
    output: z.string().optional(),
    /** `web_search`: aramanın sağlayıcıda mı DuckDuckGo'da mı yapıldığı (kart etiketi). */
    searchBackend: SearchBackend.optional(),
    /** `schedule_task`: dokunulan görevler; sohbetteki görev kartı bunu çizer. */
    schedule: ScheduleToolResult.optional(),
    /** `bash`/`agent` çağrısının komut öncesi/sonrası farkından çıkan değişen dosyalar. */
    changedFiles: z.array(ChangedFile).optional(),
    /**
     * Aracın gerçekte yazdığı mutlak yol; başlangıçtaki ham `target`'ın yerine geçer. `pdf_create`
     * göreli adı Asistan'da çıktı klasörüne göre çözer, arayüz ise çalışma klasörüne göre çözerdi.
     */
    target: z.string().optional(),
    /** `bash` çağrısı macOS korumalı alanında (sandbox-exec) koştu; kart "Korumalı" der. */
    sandboxed: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("message_end"),
    messageId: z.string(),
    text: z.string(),
    thinking: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    stopReason: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("usage"), usage: Usage, model: z.string().optional() }),
  /** Arka plan komutu başladı (`bash_background start`); Ajanlar kutusu canlı satır ekler. */
  z.object({
    ...base,
    type: z.literal("background_start"),
    jobId: z.string(),
    command: z.string(),
    description: z.string().optional(),
  }),
  /** Arka plan komutu bitti; `stopped` kullanıcı durdurması, `error` süreç açılamaması. */
  z.object({
    ...base,
    type: z.literal("background_end"),
    jobId: z.string(),
    status: z.enum(["exited", "stopped", "error"]),
    code: z.number().int().optional(),
  }),
  /**
   * Alt ajan durumu (tam liste, replace): yerli alt ajanlar (keşif, denetim, inceleme) koşu
   * başlığını ve canlı metriklerini buradan yayınlar. Boş dizi koşu kalmadığını bildirir ve
   * satırlar temizlenir.
   */
  z.object({ ...base, type: z.literal("subagents"), runs: z.array(SubagentRun) }),
  /**
   * Yerli alt ajanın canlı izi: alt oturumun araç çağrısı ve asistan metni, ana oturumun
   * transcript öğeleriyle aynı şemada akar (`item`), böylece panel aynı kartları çizer.
   * Append semantiği; aynı `item.id` tekrar gelirse öğe güncellenir.
   */
  z.object({
    ...base,
    type: z.literal("subagent_trace"),
    runId: z.string(),
    item: TranscriptItem,
  }),
  /**
   * Ayrık ajan koşuları (arka plan / worktree). Olay koşuyu başlatan oturumun kimliğiyle akar;
   * koşunun kendi `text_delta`/`tool_*` olayları kendi `sessionId`'siyle ayrıca akar, böylece
   * Ajanlar kutusu delta seliyle boğulmaz.
   */
  z.object({
    ...base,
    type: z.literal("worker_started"),
    workerId: z.string(),
    title: z.string(),
    worktree: z.string(),
    /** Koşunun kendi oturum kimliği; panelden transkriptine geçmek için gerekir. */
    workerSessionId: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("worker_status"),
    workerId: z.string(),
    status: WorkerStatus,
    /** Canlı alt satır: son eylem. */
    activity: z.string().optional(),
    /** Adım sayacı; bilinmiyorsa gönderilmez. */
    stepsDone: z.number().int().nonnegative().optional(),
    stepsTotal: z.number().int().nonnegative().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("worker_report"),
    workerId: z.string(),
    report: WorkerReport,
  }),
  z.object({
    ...base,
    type: z.literal("worker_ended"),
    workerId: z.string(),
    /** Koşu adı: bildirim ana oturum açık değilken de anlamlı olsun diye olayla taşınır. */
    title: z.string(),
    info: WorkerEndInfo,
  }),
  z.object({ ...base, type: z.literal("permission_request"), request: PermissionRequest }),
  /**
   * İzin isteği sonuçlandı (yanıt, iptal ya da oturum kapanışı): kart yalnız bununla kalkar. Durum
   * olayına bağlamak paralel isteklerde yanlış kartı silip kapıyı sonsuza dek bekletiyordu.
   */
  z.object({ ...base, type: z.literal("permission_resolved"), requestId: z.string() }),
  z.object({ ...base, type: z.literal("status"), status: z.enum(["idle", "working", "waiting"]) }),
  /**
   * Kuyrukta bekleyen mesajlar (Pi `queue_update`): `steering` sıradaki LLM çağrısında teslim
   * edilecek yönlendirmeler, `followUp` tur tamamen bitince işlenecek takip mesajları.
   */
  z.object({
    ...base,
    type: z.literal("queue"),
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal("run_end"), runId: z.string(), aborted: z.boolean() }),
  /**
   * Gizli dürtme teslim edildi (turun devamı başlıyor). Transcript'e çizilmeyen bir sınır öğesi
   * düşer: dürtme yanıtı araç çağırsa da önceki asıl rapor katlanmış diziye gömülmez.
   */
  z.object({ ...base, type: z.literal("boundary"), kind: NudgeKind }),
  z.object({
    ...base,
    type: z.literal("error"),
    message: z.string(),
    /**
     * Sabit hata sebebi. Metin değişebilir, sebep değişmez: tanı paketi bu kodlarla sayım
     * yapar ve arayüz gerekirse sebebe göre farklı davranır. Eski kayıtlarda yoktur.
     */
    reason: z
      .enum([
        "rate_limited",
        "quota_exhausted",
        "auth_failed",
        "context_exceeded",
        "request_too_large",
        "provider_overloaded",
        "provider_aborted",
        "network",
        "timeout",
        "unknown",
      ])
      .optional(),
  }),
  /** Pi geçici hatayı yeniden deniyor; hata bandı kalkar, durum "bekliyor". */
  z.object({
    ...base,
    type: z.literal("retry"),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    message: z.string(),
  }),
  /** Tur sonunda bağlam penceresi doluluğu. */
  z.object({ ...base, type: z.literal("context"), ...ContextUsage.shape }),
  /** Model plan onayı istiyor (`plan_exit`); kart cevaplanana dek tur bekler. */
  z.object({ ...base, type: z.literal("plan_review"), review: PlanReview }),
  /** Model kullanıcıya soru soruyor (`question`); kart cevaplanana dek tur bekler. */
  z.object({ ...base, type: z.literal("question_request"), request: QuestionRequest }),
  /** Eklentinin `ctx.ui` isteği (confirm/select/input); cevap `sessions:respondExtensionUi` ile döner. */
  z.object({ ...base, type: z.literal("extension_ui_request"), request: ExtensionUiRequest }),
  /** Eklenti bildirimi (`ctx.ui.notify`); kart beklemez, toast'a düşer. */
  z.object({
    ...base,
    type: z.literal("extension_notify"),
    message: z.string(),
    level: z.enum(["info", "warning", "error"]),
  }),
  /** Eklenti hatası (yükleme ya da çalışma zamanı); `plugin` eklenti adı, eklenti bağlamı
   * yoksa (`ctx.ui` köprüsü) `null`. */
  z.object({
    ...base,
    type: z.literal("extension_error"),
    plugin: z.string().nullable(),
    message: z.string(),
  }),
  /** Bekleyen `ctx.ui` istekleri iptal edildi (tur iptali, oturum kapanışı); kartlar kalkar. */
  z.object({
    ...base,
    type: z.literal("extension_ui_cancelled"),
    requestIds: z.array(z.string()),
  }),
  /** İzin modu model eliyle değişti (`plan_enter`, onaylanan plan); composer çipi güncellenir. */
  z.object({ ...base, type: z.literal("permission_mode"), mode: PermissionMode }),
  /** Tur sonu kontrolleri (Ayarlar > Kod incelemesi); başarısız komut modele geri verilir. */
  z.object({
    ...base,
    type: z.literal("checks"),
    ok: z.boolean(),
    commands: z.array(z.string()),
    failed: z.string().optional(),
  }),
  /**
   * Kod incelemesi (deneysel): "İncele" düğmesiyle başlar, arka planda koşar. Gölge moddadır;
   * bulgular yalnızca arayüze ve kayda gider, modele geri verilmez.
   */
  z.object({
    ...base,
    type: z.literal("review"),
    phase: z.enum(["started", "done"]),
    /** İncelemenin yapıldığı kullanıcı turu (1'den); bulgular o turun altında gösterilir. */
    turn: z.number().int().positive(),
    /** İncelenen dosyalar (depo-göreli); `started` fazında da dolu. */
    files: z.array(z.string()),
    /** `done` fazında doğrulama özeti. */
    counts: ReviewCounts.optional(),
    /** `done` fazında bulgular; bulgu yoksa boş dizi. */
    findings: z.array(ReviewFinding).optional(),
    /** Koşunun toplam tüketimi (denetçi + doğrulayıcı alt oturumları). */
    usage: Usage.optional(),
    /** Koşu tamamlanamadıysa kısa hata metni; "bulgu yok" ile karışmasın diye ayrı alan. */
    error: z.string().optional(),
  }),
  /**
   * Kalıcı hedef durumu değişti (`/goal` komutları, sentinel, maxIter, abort). `goal: null` hedefin
   * bittiğini/temizlendiğini; `note` neden geçi�ş yapıldığını taşır (renderer toast bununla seçilir).
   */
  z.object({
    ...base,
    type: z.literal("goal"),
    goal: GoalState.nullable(),
    note: z.enum(["set", "done", "blocked", "stopped", "max_iter", "paused", "resumed"]),
  }),
  /**
   * Yerel komut sonucu (`/model`, `/mod`, `/düşünme`, `/compact`): sohbete işaret satırı düşer.
   * İşaret hem `sessions/meta.json`'a yazılır hem yayınlanır; yeniden açılan oturumda satırlar
   * snapshot'a meta'dan karıştırılır (ZCode'un oturum kaydından gelen işaretleri gibi).
   */
  z.object({ ...base, type: z.literal("marker"), marker: MarkerItem }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];

/** Union üyelerine dağılan Omit; `AgentEvent & Omit<...>` tek gövdeye çökmesin diye gereklidir. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Üreticilerin yayınladığı gövde: zarf alanları (`seq`, `epoch`) yoktur. Aboneler her zaman zarfı
 * taşıyan `AgentEvent` görür; böylece sıra numarasının tek bir üreticisi kalır.
 */
export type AgentEventInput = DistributiveOmit<AgentEvent, "seq" | "epoch">;
