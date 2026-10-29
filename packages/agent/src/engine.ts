import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  AgentEventInput,
  AgentInfo,
  AppMode,
  AuditStartOptions,
  AuditView,
  BackgroundJob,
  CatalogModel,
  ContextUsage,
  CoverageUnit,
  CredentialRotation,
  ExtensionUiValue,
  GoalState,
  ImageAttachment,
  MarkerItem,
  MarkerKind,
  MemoryScope,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PlanDecision,
  PlanReview,
  ProviderInfo,
  QuestionAnswers,
  QuestionItem,
  QuestionRequest,
  ResolvedHook,
  ReviewCounts,
  ReviewFinding,
  ReviewOutcome,
  ReviewVerdict,
  SessionOptions,
  SessionSearchHit,
  SessionSummary,
  SubagentKind,
  SubagentRun,
  SubagentTrace,
  ThinkingLevel,
  TranscriptItem,
  Usage,
  WebSearchProvider,
  WorkerEndInfo,
  WorkerInfo,
  WorkerReviewDecision,
} from "@codezal/contracts";
import {
  cleanGeneratedTitle,
  collapsePromptMarkup,
  deriveSessionTitle,
  foldQuery,
  itemTime,
  modelLabel,
  promptQuotes,
} from "@codezal/contracts";
import { createI18n, type Locale } from "@codezal/i18n";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AuthInteraction,
  type ImageContent,
  isContextOverflow,
  isRetryableAssistantError,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  type SessionInfo,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ADVISOR_TOOL, advisorTool } from "./advisor.js";
import { canWrite, EXPLORE_AGENT, resolveAgentTools } from "./agents/profile.js";
import { AGENT_RUN_TOOLS, type AgentRunBridge, agentRunTools } from "./agents/run-tools.js";
import { AgentRunManager, type RunIsolation } from "./agents/runs.js";
import { AgentStore } from "./agents/store.js";
import {
  AGENT_TIMEOUT_MS,
  AGENT_TOOL,
  type AgentRunInput,
  type AgentRunner,
  agentTool,
} from "./agents/tool.js";
import type { AuditCandidate } from "./audit/candidates.js";
import { parseHunterOutput, parseVerifierVerdict } from "./audit/parse.js";
import { buildReport } from "./audit/report.js";
import { AuditSession, type AuditSessionDeps, type HuntAssignment } from "./audit/session.js";
import { AUDIT_FILE, AuditStore } from "./audit/store.js";
import {
  AUDIT_START_TOOL,
  AUDIT_TOOLS,
  type AuditHuntResult,
  type AuditRecordResult,
  type AuditReportResult,
  type AuditRunner,
  type AuditStartResult,
  type AuditStatusResult,
  type AuditUnitSummary,
  type AuditVerifyResult,
  auditTools,
  MAX_HUNT_UNITS,
} from "./audit/tools.js";
import {
  BACKGROUND_TOOL,
  BackgroundRunner,
  type BackgroundTask,
  backgroundTool,
  DONE_OUTPUT_TAIL,
  toBackgroundJob,
} from "./background.js";
import { BashCheckpoints, type CheckpointRoute, type FileChange } from "./bash-snapshot.js";
import { BASH_TOOL, bashTool, sandboxedBashTool } from "./bash-tool.js";
import { apiKeyInteraction, catalogSignature, listCatalog, listProviders } from "./catalog.js";
import { fetchCommandCodeModels, registerCommandCode } from "./commandcode.js";
import {
  editedFiles,
  FILE_CREATE_TOOLS,
  FILE_EDIT_TOOLS,
  resolveCreatedFile,
} from "./create-tools.js";
import { CredentialPool } from "./credential-pool.js";
import { DOCX_TOOL, docxCreateTool } from "./docx-create.js";
import { DOCX_EDIT_TOOL, docxEditTool } from "./docx-edit-tool.js";
import { AgentEventBus } from "./event-bus.js";
import { EXPLORE_TOOLS } from "./explore.js";
import { ExtensionUiBridge } from "./extension-ui.js";
import { mergeExtraSystem } from "./extras.js";
import { removeQuietly } from "./fsx.js";
import { analyzeGoalEnd, buildGoalDirective } from "./goal.js";
import { hooksExtension } from "./hooks.js";
import {
  maxImagesPerRequest,
  SESSION_IMAGE_BUDGET_BYTES,
  trimImageHistory,
} from "./image-budget.js";
import { prepareImages } from "./images.js";
import {
  isLimitError,
  isQuotaExhausted,
  parseRetryDelayMs,
  SHORT_LIMIT_COOLDOWN_MS,
} from "./limit.js";
import {
  EventMapper,
  TOOL_STOP_TYPE,
  type ToolStop,
  toolStopsOf,
  toUsage,
  transcriptFromMessages,
} from "./mapping.js";
import { maskSecrets } from "./mask.js";
import { MCP_TOOL_PREFIX, McpManager, TOOL_SEARCH_TOOL } from "./mcp.js";
import { MemoryStore } from "./memory.js";
import { microcompact } from "./microcompact.js";
import { createOutputsGuard } from "./outputs-guard.js";
import { PDF_TOOL, type PdfRenderer, pdfCreateTool } from "./pdf-create.js";
import { PDF_EDIT_TOOL, pdfEditTool } from "./pdf-edit-tool.js";
import { PermissionManager } from "./permission.js";
import {
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  type PlanBridge,
  PlanReviewGate,
  planTools,
} from "./plan-tools.js";
import {
  explainProviderError,
  explainProviderErrorWithReason,
  isTransientProviderError,
} from "./provider-error.js";
import { QUESTION_TOOL, QuestionGate, questionTool } from "./question-tool.js";
import { expandReadPath } from "./read-path.js";
import { readTool } from "./read-tool.js";
import { ResourceCatalog, withoutPackages } from "./resources.js";
import {
  parseReviewerOutput,
  parseValidatorVerdict,
  type ReviewerFinding,
  type ReviewStore,
} from "./review.js";
import { type SandboxDecision, sandboxDecision } from "./sandbox.js";
import { SCHEDULE_TOOL, type ScheduleBridge, scheduleTool } from "./schedule-tool.js";
import { SessionMetaStore } from "./session-meta.js";
import { SessionSearchIndex } from "./session-search.js";
import { agentShell } from "./shell.js";
import { SnapshotStore } from "./snapshots.js";
import { SUBAGENT_RUN_TYPE, SubagentTracker, subagentRecordsOf } from "./subagent-trace.js";
import { environmentText, liveEnvironment, promptExtension } from "./system-prompt.js";
import { TASK_LIST_TOOL, taskListTool } from "./task-list.js";
import { titlePrompt } from "./title.js";
import {
  analyzeTurn,
  NUDGE_TYPE,
  type NudgeKind,
  type TurnNudge,
  turnMessages,
  turnTouchedFiles,
  turnTouchedPaths,
} from "./turn-guard.js";
import { sendUserMessage } from "./user-message.js";
import { webFetchTool } from "./web-fetch.js";
import { type WebSearchOptions, webSearchTool } from "./web-search.js";
import { BRAVE_KEY_ID } from "./web-search-providers.js";
import type { WorkerRuntime, WorkerSession, WorktreeService } from "./worker.js";
import { XLSX_TOOL, xlsxCreateTool } from "./xlsx-create.js";
import { XLSX_EDIT_TOOL, xlsxEditTool } from "./xlsx-edit-tool.js";

export interface EngineConfig {
  /** Pi agentDir: auth.json, models.json, settings.json burada tutulur. */
  agentDir: string;
  /** Oturum JSONL dosyalarının kökü. */
  sessionsDir: string;
  /** Ayarlardan gelen genel talimatlar (Kişiselleştirme). */
  globalInstructions?: () => string | undefined;
  /** Arayüz dili: araç başlıkları ve sistem istemleri bu dilde üretilir. */
  language?: Locale;
  /**
   * Oturum ekleri: ek sistem istemi (asistan proje talimatları, çıktı kuralı) ve çıktı klasörü.
   * `SessionOptions` içinde verilmemişse hem oluştururken hem yeniden açarken buradan üretilir;
   * böylece proje talimatı değişince eski oturumlar da güncel istemi alır.
   */
  sessionExtrasFor?: (meta: {
    mode: AppMode;
    projectId: string | null;
    cwd: string;
  }) => { extraSystem?: string; outputsDir?: string } | undefined;
  /**
   * Denetim run'larının kökü (userData/audits). Verilmezse güvenlik denetimi kapalıdır.
   */
  auditsDir?: string;
  /** Skill paketinin kökü (resources/audit); avcılar paket dosyalarını buradan okur. */
  auditAssetsDir?: string;
  /** Denetim durumu değişti (araç yazımı ya da panel eylemi); main `audit:changed` yayar. */
  onAuditChanged?: (sessionId: string) => void;
  /** Denetim alt ajanı süreleri (ms); yalnız testler kısaltır, verilmezse 5 dk / 4 dk / 90 sn. */
  auditTimeouts?: { huntMs: number; verifyMs: number; graceMs: number };
  /** Dosya tabanlı bellek kökü (userData/memory). */
  memoryDir: string;
  /**
   * Kullanıcı ajan tanımlarının klasörü (userData/agents). Verilmezse `agentDir/agents`
   * kullanılır; proje ajanları her zaman `<proje>/.codezal/agents` altından okunur.
   */
  agentsDir?: string;
  /** Ajanların açma/kapama durumu (userData/agents-state.json); verilmezse `agentsDir` yanında. */
  agentsStateFile?: string;
  /**
   * Git worktree köprüsü (main `git.ts`); motor worktree'yi bunun üzerinden açar. Verilmezse
   * ajan koşuları yalıtılamaz: arka plan koşusu ana klasörde çalışır, açık yalıtım isteği düşer.
   */
  worktrees?: WorktreeService;
  /** Gözetimsiz görevde web özetinin modeli (Ayarlar > Kullanım); boşsa görevin modeli. */
  webSummaryModel?: () => { provider: string; id: string } | null;
  /** `web_search` sağlayıcı seçimi (Ayarlar > Bağlantı > Web araması); verilmezse `auto`. */
  webSearch?: () => { provider: WebSearchProvider; searxngUrl: string };
  /** Danışman modeli (Ayarlar > Kullanım); boşsa `advisor` aracı kaydedilmez. */
  advisorModel?: () => { provider: string; id: string } | null;
  /** Zamanlanmış (gözetimsiz) koşuda danışman açık mı; kapalıyken araç koşu boyunca gizlenir. */
  advisorScheduled?: () => boolean;
  /** Ajan koşusu ayarları (Ayarlar > Ajanlar); her koşuda canlı okunur. */
  agentRuns?: () => { concurrency: number; worktreePermission: PermissionMode };
  /**
   * Plan dosyalarının kökü (userData/plans). Plan modunda sistem istemine oturumun plan dosyası
   * eklenir ve izin kapısı yalnızca bu klasöre yazmayı geçirir; verilmezse özellik kapalıdır.
   */
  plansDir?: string;
  /**
   * Proje-yerel yapılandırma (`.pi/settings.json`, proje becerileri) yüklensin mi. Klonlanan bir
   * depodaki ayar sorulmadan yüklenmesin diye main güven kaydına bakar; verilmezse güvenilir sayılır.
   */
  projectTrusted?: (cwd: string) => boolean;
  /** Zamanlanmış görev deposu köprüsü; verilirse asistan oturumlarına `schedule_task` aracı girer. */
  schedule?: ScheduleBridge;
  /** HTML → PDF çevirici (main `pdf.ts`, Chromium `printToPDF`); verilirse `pdf_create` aracı girer. */
  renderPdf?: PdfRenderer;
  /**
   * `pdf_edit` filigran ve form değerleri için gömülecek Unicode TTF (main `resolvePdfFont` ile
   * sistemden seçer). Yoksa yalnız WinAnsi'ye sığan metin basılır; Türkçe karakter açık hata verir.
   */
  pdfFont?: string | undefined;
  /** Bağlayıcı OAuth girişi için tarayıcı açar; verilmezse giriş yapılamaz. */
  openExternal?: (url: string) => Promise<void> | void;
  /** MCP istemcisinin sunucuya bildirdiği uygulama sürümü. */
  appVersion?: string;
  /** Uygulamayla gelen OAuth istemcileri (`clientGroup` → istemci); kullanıcı kendi projesini açmasın diye. */
  builtInOauthClients?: Record<string, { clientId: string; clientSecret: string }>;
  /**
   * Yerel komut bağlayıcılarının PATH'i: main login kabuğundan çözdüğü PATH'i verir. Agent paketi
   * main'i import etmez; değer buradan geçer. Verilmezse süreç PATH'i kullanılır.
   */
  mcpStdioPath?: () => string | undefined;
  /** Sunucu süre bildirmezse limiti dolan anahtarın ne kadar atlanacağı; Ayarlar'dan canlı okunur. */
  keyCooldownMs?: () => number;
  /** Limit dolunca anahtar değişti; main renderer'a bildirir. */
  credentialRotated?: (event: CredentialRotation) => void;
  /**
   * Tur öncesi dosya yedeklerinin kökü (userData/snapshots). `edit`/`write` çalışmadan önce dosyanın
   * hâli saklanır; tur altındaki "Geri al" buradan döner. Verilmezse geri alma kapalıdır.
   */
  snapshotsDir?: string;
  /**
   * Kodlama turunun sonunda çalışacak kontrol komutları (Ayarlar > Kod incelemesi); boş liste
   * kapalı demektir. Yalnızca dosya değişen turlarda ve `runCheck` verilmişse çalışır.
   */
  turnChecks?: (cwd: string) => string[];
  /** Kontrol komutunu ajan kabuğunda çalıştırır (main `checks.ts`). */
  runCheck?: (cwd: string, command: string) => Promise<{ ok: boolean; output: string }>;
  /**
   * Kod incelemesi (deneysel): "İncele" düğmesi açık mı (Ayarlar > Kod incelemesi). Kapalıysa
   * `startReview` çalışmaz; otomatik tetikleme yoktur, koşuyu kullanıcı başlatır.
   */
  reviewer?: () => boolean;
  /** İnceleme kayıt deposu (userData/reviews); verilmezse inceleme kapalıdır. */
  reviewStore?: ReviewStore;
  /** Arka plan komutlarının kabuğu; verilmezse `agentShell` ile çözülür (Windows'ta Git Bash). */
  shell?: () => string;
  /**
   * Kullanıcı hook'ları (PreToolUse / PostToolUse): genel `hooks.json` ve güvenilen projenin
   * `.codezal/ayarlar*.json` dosyaları; her araç çağrısında okunur. Verilmezse hook çalışmaz.
   */
  hooks?: (cwd: string) => ResolvedHook[];
  /** Hook süreçlerinin ortamı: main'in login kabuk PATH düzeltmesi yapılmış ortamı. */
  hookEnv?: () => NodeJS.ProcessEnv;
  /** Motorun engellemeyen uyarıları (hook süresi, sıfır dışı çıkış) için günlük köprüsü. */
  log?: (level: "info" | "warn", scope: string, message: string) => void;
  /** Bash korumalı alanı açık mı (Ayarlar); her komutta canlı okunur, yalnız macOS'ta etkilidir. */
  bashSandbox?: () => boolean;
  /** Codezal veri kökü (userData); korumalı alan buraya okuma ve yazmayı kapatır. */
  userDataDir?: string;
}

const DEFAULT_KEY_COOLDOWN_MS = 5 * 3_600_000;
/** Denetim alt ajanları: av 5 dk, doğrulama 4 dk; aynı anda en çok 3 oturum. */
const AUDIT_HUNT_TIMEOUT_MS = 5 * 60_000;
const AUDIT_VERIFY_TIMEOUT_MS = 4 * 60_000;
const AUDIT_CONCURRENCY = 3;
/**
 * Süre dolunca alt ajan kesilmeden önce araçsız son söz hakkı: 30-70 araç çağrılık okuma çöpe
 * gitmesin, elindekiyle JSON yazsın. Bu pencerede de bitmezse oturum iptal edilir.
 */
const SUBSESSION_FINALIZE_GRACE_MS = 90_000;
/** Kod incelemesi alt ajanları: denetçi 4 dk, doğrulayıcı 3 dk. */
const REVIEW_TIMEOUT_MS = 4 * 60_000;
const REVIEW_VERIFY_TIMEOUT_MS = 3 * 60_000;
/** İnceleme kapsamı: son bu kadar kullanıcı turu ve en fazla bu kadar dosya (maliyet sınırı). */
const REVIEW_MAX_TURNS = 5;
const REVIEW_MAX_FILES = 10;

/** Sınırlı eşzamanlılıkla eşleme; sonuçlar girdi sırasını korur. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function toUnitSummary(unit: CoverageUnit): AuditUnitSummary {
  return {
    id: unit.id,
    attackClass: unit.attackClass,
    surface: unit.surface,
    files: unit.scopePaths.length,
  };
}

// Kayıtlı olmayan ad (ör. çevirici verilmemişse PDF_TOOL) Pi tarafından sessizce atlanır.
const DEFAULT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  // Web araçları her modda: kodlarken de belge, sürüm notu ve hata mesajı aramak gerekiyor.
  "web_search",
  "web_fetch",
  TASK_LIST_TOOL,
  // Kullanıcı tanımlı ajanlara devir her modda açık: Ajanlar sayfasındaki profiller
  // `subagent_type` ile çağrılır, tanımlı ajan yoksa yalnız gömülü ajanlar listelenir.
  AGENT_TOOL,
  ...AGENT_RUN_TOOLS,
  BACKGROUND_TOOL,
  PDF_TOOL,
  PDF_EDIT_TOOL,
  DOCX_TOOL,
  DOCX_EDIT_TOOL,
  XLSX_TOOL,
  XLSX_EDIT_TOOL,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  // Soru her modda: model plan yazmadan önce netleştirebilsin; plan modunda da serbest.
  QUESTION_TOOL,
  // Danışman yalnız ayarda model seçiliyse kayıtlıdır; kayıtsız ad etkin listede yok sayılır.
  ADVISOR_TOOL,
  // Tetikleyici cümle doğal çalışsın: denetim başlatma her oturumda açıktır; diğer denetim
  // araçları yalnızca run açılınca etkinleşir.
  AUDIT_START_TOOL,
];
/** Asistan modu: kod düzenleme yerine dosya/komut odaklı araç seti. */
const ASSISTANT_TOOLS = [
  "read",
  "bash",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  TASK_LIST_TOOL,
  AGENT_TOOL,
  ...AGENT_RUN_TOOLS,
  BACKGROUND_TOOL,
  SCHEDULE_TOOL,
  PDF_TOOL,
  PDF_EDIT_TOOL,
  DOCX_TOOL,
  DOCX_EDIT_TOOL,
  XLSX_TOOL,
  XLSX_EDIT_TOOL,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  QUESTION_TOOL,
  ADVISOR_TOOL,
];
/** Tur sonu kontrolü aynı turda en fazla bu kadar kez modele geri verilir; sonrası kullanıcıya kalır. */
const MAX_CHECK_NUDGES = 2;
/** Başarısız kontrolün modele gönderilen çıktı kuyruğu. */
const CHECK_OUTPUT_TAIL = 4000;
/** Gönderilmeyen mesaj işaretinde gösterilen baş (karakter); balon yeniden açılışta yok. */
const UNSENT_EXCERPT = 80;
/** Geçici sağlayıcı hatasında (Kimi `finish_reason: error`) tur başına yeniden deneme sayısı ve ilk bekleme. */
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_BASE_DELAY_MS = 2000;
/** Projeden bağlam olarak okunan talimat dosyaları; ikisi de varsa ikisi de eklenir. */
export const CONTEXT_FILES = ["CODEZAL.md", "AGENTS.md"] as const;
/**
 * Motorun Pi'ye ek olarak verdiği dosyalar. AGENTS.md yok: Pi çalışma klasöründen köke kadar
 * AGENTS.override.md → AGENTS.md → CLAUDE.md ailesini zaten yükler; burada da sayılınca dosya
 * isteme iki kez giriyordu.
 */
const EXTRA_CONTEXT_FILES = CONTEXT_FILES.filter((name) => name !== "AGENTS.md");

/** `#open` seçenekleri: yeniden açılışta düşünme seviyesi verilmez, Pi oturumdan geri yükler. */
type OpenOptions = Omit<SessionOptions, "thinking"> & { thinking?: ThinkingLevel };

/** Motorun Pi kuyruğuna koyduğu mesaj; asılı kalırsa görselleriyle yeniden gönderilir. */
interface QueuedMessage {
  kind: "steer" | "followUp";
  /** Kullanıcının yazdığı metin; yeniden gönderimde ve işarette kullanılır. */
  text: string;
  /** Pi'ye verilen metin: Pi kuyruğundaki kayıtla eşleşmek için. */
  body: string;
  images?: ImageAttachment[] | undefined;
}

interface LiveSession {
  session: AgentSession;
  cwd: string;
  permission: PermissionMode;
  /** `plan_enter` öncesi mod; onaylanan planla buna dönülür. Elle girilen plan modunda yoktur. */
  planReturnTo: PermissionMode | undefined;
  unsubscribe: () => void;
  /** Model değişince yeniden deneme bütçesi yeni sağlayıcıya göre güncellenir. */
  settingsManager: SettingsManager;
  /** Oturumun kaynak yükleyicisi; yükleme hataları buradan okunur. */
  resourceLoader: DefaultResourceLoader;
  /** Eklenti `ctx.ui` köprüsü; bekleyen kartlar oturum kapanışında iptal edilir. */
  ui: ExtensionUiBridge;
  /** Pi olaylarını AgentEvent'e çeviren eşleyici; açık turun kimliği snapshot için buradan okunur. */
  mapper: EventMapper;
}

/** Oturumun anahtar geçişi durumu; sürdürme hakkı yalnızca gerçek bir geçişle doğar. */
interface RotationState {
  /** Bu turda yapılan gerçek anahtar geçişi sayısı. */
  count: number;
  /** Son asistan hatası anahtar değiştirdi mi; sürdürme bunu tüketir. */
  resume: boolean;
}

/**
 * Yeniden deneme beklemesi. Sinyal kesilince hemen döner: bekleme kesintisizken Durdur bu
 * aralıkta etkisizdi ve süre dolunca tur kullanıcının iradesine rağmen sürüyordu.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Önden sıkıştırma eşiği (yüzde). Sıkıştırmanın kendisi de bağlam ister (özet isteği); pencereyi
 * tıka basa doldurup sıkıştırmayı imkânsız hâle getirmemek için üstte pay bırakılır.
 */
const AUTO_COMPACT_PERCENT = 85;

/** Üst üste bu kadar sıkıştırma başarısız olursa otomatik deneme durur (tur gecikmesin). */
export const MAX_COMPACT_FAILURES = 3;

/** Sıkıştırma yer açmadıysa bu kadar kez tekrarlanınca otomatik deneme durur. */
export const MAX_RAPID_REFILLS = 3;

/** Sıkıştırma sonrası doluluk bu orandan aşağı inmediyse "yer açmadı" sayılır. */
const RAPID_REFILL_RATIO = 0.9;

/**
 * Sıkıştırma sonucu.
 *
 * `nothing-to-compact` ve `already-compacted` **arıza değil**: Pi sıkıştırılacak eski içerik
 * bulamadığında (`keepRecentTokens` = 20 bin token) ya da son kayıt zaten bir sıkıştırmaysa bunu
 * hata olarak fırlatır. Kullanıcı `/compact` dediğinde bunu "başarısız" diye göstermek yanlış
 * olurdu; ne olduğunu söylemek gerekir.
 */
export type CompactFailureReason =
  | "not-open"
  | "busy"
  | "nothing-to-compact"
  | "already-compacted"
  | "failed";

export interface CompactResult {
  ok: boolean;
  /** Başarısızlık nedeni; arayüz buna göre farklı metin gösterir. */
  reason?: CompactFailureReason;
  /** `failed` durumunda maskelenmiş sebep; kullanıcı ne olduğunu görebilsin. */
  detail?: string;
  /** Sıkıştırma sonrası doluluk (varsa). */
  context?: { tokens: number; contextWindow: number; percent: number };
}

/**
 * Pi'nin "yapacak iş yok" mesajlarını ayrı sebeplere çevirir; eşleşmezse undefined.
 *
 * `compact()` bu iki durumu hata olarak fırlatır ama ikisi de arıza değildir: biri "özetlenecek
 * eski içerik yok" (Pi son 20 bin tokenı korur), öbürü "son kayıt zaten bir özet". Kullanıcı
 * `/compact` dediğinde bunları "başarısız" diye göstermek yanıltıcı olurdu.
 */
export function compactNoopReason(message: string): CompactFailureReason | undefined {
  if (/nothing to compact|session too small/i.test(message)) return "nothing-to-compact";
  if (/already compacted/i.test(message)) return "already-compacted";
  return undefined;
}

/** İnceleme koşusu tüketimini toplamak için boş sayaç. */
function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * Alt oturumun iptal sinyalini bağlar ve **bağlanma anında** sinyal zaten iptal edilmişse hemen
 * tetikler. `addEventListener` geçmiş bir iptali yeniden oynatmaz: alt oturumun kurulumu (kaynak
 * yükleme, oturum açma) birden çok `await` içerdiği için kullanıcının "Durdur"u bu pencereye
 * düşerse dinleyici hiç çalışmıyor ve koşu sonuna kadar (3-10 dk) token harcıyordu.
 */
function abortOn(signal: AbortSignal | undefined, stop: () => void): void {
  if (!signal) return;
  signal.addEventListener("abort", stop);
  if (signal.aborted) stop();
}

/** İki kullanım kaydını toplar (denetçi + doğrulayıcı alt oturumları). */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/**
 * Tur yedeğinin dosya yolu; aracın yazacağı yerle aynı olmalı ki "Geri al" doğru dosyayı döndürsün.
 * Üretim araçları (PDF, Word) göreli adı çıktı klasörüne yazar. Diğerlerinde `~/x` ve `@x` Pi'nin
 * çözdüğü gibi genişletilir: düz `resolve(cwd, "~/x")` yedeği `<cwd>/~/x`e alıyor, gerçek dosya geri
 * alınamıyordu.
 */
export function turnBackupPath(
  tool: string,
  raw: string,
  cwd: string,
  outputsDir?: string,
): string {
  return resolveCreatedFile(tool, raw, cwd, outputsDir) ?? resolve(expandReadPath(raw, cwd));
}

/**
 * Araç sonucuna değişen dosyaları ekler (`details.changedFiles`). Pi `details`'i oturum dosyasına
 * yazdığı için liste yeniden açılışta da gelir. `details` nesne değilse (bilinmeyen biçim)
 * dokunulmaz; aracın kendi alanları korunur.
 */
export function withChangedFiles(
  details: unknown,
  files: readonly FileChange[],
): { details: Record<string, unknown> } | undefined {
  if (details !== undefined && (typeof details !== "object" || details === null)) return undefined;
  if (Array.isArray(details)) return undefined;
  const base = (details ?? {}) as Record<string, unknown>;
  return { details: { ...base, changedFiles: files.map(({ path, kind }) => ({ path, kind })) } };
}

/** Bulgu kimliği: dosya + satır + başlık + açıklamadan türetilir; aynı bulgu aynı kimliği alır. */
function reviewId(candidate: ReviewerFinding): string {
  const key = `${candidate.file}:${candidate.line ?? 0}:${candidate.title}:${candidate.description}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/**
 * Oturum dosyasının ilk satırı (başlık) çalışma klasörünü taşır; eski yola eşitse yenisiyle
 * değiştirilir. Pi `list` başlıktaki cwd'ye göre süzer, `open` çalışma klasörünü oradan alır.
 */
export function rewriteSessionCwd(file: string, from: string, to: string): boolean {
  const text = readFileSync(file, "utf8");
  const nl = text.indexOf("\n");
  const head = nl === -1 ? text : text.slice(0, nl);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(head) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (header.type !== "session" || header.cwd !== from) return false;
  header.cwd = to;
  writeFileSync(file, JSON.stringify(header) + (nl === -1 ? "" : text.slice(nl)), "utf8");
  return true;
}

/**
 * Codezal motoru. Pi'yi sarmalar; oturumları, kataloğu ve izin kapısını yönetir (PRD §7.4, §7.5).
 */
export class CodezalEngine {
  readonly bus = new AgentEventBus();
  readonly config: EngineConfig;
  readonly permissions: PermissionManager;
  /** Plan onayları (`plan_exit`); izin yöneticisinin plan karşılığı. */
  readonly plans: PlanReviewGate;
  /** Kullanıcıya sorular (`question`); plan onayının soru karşılığı. */
  readonly questions: QuestionGate;

  #runtime: ModelRuntime | undefined;
  /** Sürüp giden inceleme koşuları: oturum başına tek; oturum kapanışında durdurulur. */
  readonly #reviews = new Map<string, AbortController>();
  /** Uzak katalog tazelemesi motor ömründe bir kez kendiliğinden başlar. */
  #catalogRefreshStarted = false;
  readonly #catalogListeners = new Set<() => void>();
  #i18n: ReturnType<typeof createI18n>;
  readonly #lang: Locale;
  readonly #live = new Map<string, LiveSession>();
  /** Gözetimsiz koşu için danışmanı gizlenen oturumlar; gözetim bitince araç geri açılır. */
  readonly #advisorHidden = new Set<string>();
  /**
   * Oturum başına alt ajan izleyicisi. Paylaşılır olması şart: `subagents` olayı tam liste
   * (replace) taşır, koşu başına ayrı izleyici son yayınlanan koşuyla diğerlerini ezerdi.
   */
  readonly #tracers = new Map<string, SubagentTracker>();
  /** Ana oturumda sorulan koşu izinleri: istek kimliği → kartın gösterildiği ana oturum. */
  readonly #forwardedAsks = new Map<string, string>();
  /** Oturum başına denetim run'ı; diskten yüklenir ve burada önbelleğe alınır. */
  readonly #audits = new Map<string, AuditSession>();
  readonly #auditStore: AuditStore | undefined;
  readonly #paths = new Map<string, string>();
  /** Oturum içeriği araması (⌘K): dosya başına metin dizini, dosya değişince yenilenir. */
  readonly #searchIndex = new SessionSearchIndex();
  /** Aramada bilinmeyen kimlik için son liste tazelemesi; her tuş vuruşunda listelenmesin. */
  #searchListedAt = 0;
  readonly #meta: SessionMetaStore;
  readonly memory: MemoryStore;
  /** Beceri, şablon ve paket kataloğu; Pi ayar dosyasını (agentDir/settings.json) yönetir. */
  readonly resources: ResourceCatalog;
  /** Alt ajan tanımları: gömülü ajanlar + kullanıcı/proje Markdown dosyaları. */
  readonly agents: AgentStore;
  /** Uzak MCP bağlayıcıları; belirteçler agentDir/mcp.json içinde kalır. */
  readonly mcp: McpManager;
  /** MCP araç kümesi değişince açık oturumları tazeleyen abonelik; dispose'da bırakılır. */
  readonly #mcpToolsUnsub: () => void;
  /** Sağlayıcı başına anahtar havuzu (agentDir/keys.json); Pi kimliği buradan okur. */
  readonly keys: CredentialPool;
  /** Oturum başına anahtar geçişi durumu; Pi yeniden denemezse turu biz sürdürürüz. */
  readonly #rotations = new Map<string, RotationState>();
  /** Sürdürme döngüsü çalışan oturumlar; olay dinleyicisi araya girmesin. */
  readonly #resuming = new Set<string>();
  /** Oturum başına son yayınlanan bağlam tokenı; aynı sayı tekrar gönderilmez. */
  readonly #lastContext = new Map<string, number>();
  /** Tanınmayan widget (başka eklentinin TUI bileşeni) uyarısı oturum başına bir kez verilir. */
  readonly #widgetWarned = new Set<string>();
  /** Otomatik başlığı üretilmekte olan oturumlar; aynı tur için ikinci çağrıyı keser. */
  readonly #titling = new Set<string>();
  /**
   * Rotasyon yüzünden kullanıcıya gösterilmeyen sağlayıcı hatası. Tur gerçekten sürdürülürse
   * atılır; sürdürme herhangi bir nedenle vazgeçerse yayınlanır, yoksa tur sessizce dururdu.
   */
  readonly #heldError = new Map<string, AgentEventInput>();
  /**
   * Hiç çalışmadan durdurulan çağrılar: plan modu engeli "blocked", kullanıcının PreToolUse hook'u
   * "denied". `tool_end` bunları hata yerine ilgili duruma çevirir.
   */
  readonly #blockedTools = new Map<string, Map<string, "blocked" | "denied">>();
  /** Korumalı alanda koşan `bash` çağrıları; sonuçları `sandboxed` ayrıntısıyla işaretlenir. */
  readonly #sandboxedCalls = new Set<string>();
  /** Tur öncesi dosya yedekleri; `snapshotsDir` verilmemişse kapalı. */
  readonly #snapshots: SnapshotStore | undefined;
  /** Terminal komutlarının öncesi/sonrası ölçümü; yedekler `#snapshots`'a yazılır. */
  readonly #bashCheckpoints: BashCheckpoints | undefined;
  /**
   * Yalıtımsız ayrık ajan koşusu → yedeğin yazılacağı ana oturum ve koşunun açıldığı tur. Ana
   * turdaki "Geri al" koşunun aynı klasörde yaptığı değişiklikleri de döndürür. Worktree koşusu
   * burada yoktur: değişiklikleri ayrı klasörde kalır, inceleme kararıyla uygulanır.
   */
  readonly #checkpointRoutes = new Map<string, CheckpointRoute>();
  /**
   * Bekletilen alt ajanın (`#agentRun`) değiştirdiği dosyalar, ana oturumdaki `agent` çağrı
   * kimliğine göre. Çağrı sonuçlanınca karta iliştirilir: tur dosya listesi bunları da gösterir.
   */
  readonly #subagentFiles = new Map<string, Map<string, FileChange>>();
  /** Oturumun çıktı klasörü (Asistan); alt ajanın terminal taraması da bu klasörü atlar. */
  readonly #outputsDirs = new Map<string, string>();
  /** Oturum başına bu turdaki geçici sağlayıcı hatası yeniden deneme sayısı. */
  /**
   * Oturum başına koşan önden sıkıştırma. Üst üste binmesi engellenir: Pi `compact()` başında
   * `abort()` çağırdığı için ikinci çağrı birincisini iptal ederdi.
   */
  readonly #compacting = new Map<
    string,
    Promise<{ ok: boolean; reason?: CompactFailureReason; detail?: string }>
  >();
  /** Oturum başına ardışık sıkıştırma hatası; `MAX_COMPACT_FAILURES`ta denenmez olur. */
  readonly #compactFailures = new Map<string, number>();
  /** Oturum başına "sıkıştırma yer açmadı" sayısı; `MAX_RAPID_REFILLS`ta denenmez olur. */
  readonly #rapidRefills = new Map<string, number>();
  /**
   * **Tur dışında** yayılmış "çalışıyor" durumu (şu an tek kaynak: sıkıştırma). Tur içindeki
   * durumu `mapping` yönetir ve `run_end` ile kapatır; tur dışında yayılanı kapatacak kimse
   * yoktur, bu yüzden defteri burada tutulur.
   *
   * Neden gerekli: sıkıştırma "çalışıyor" yayıp hiç "boşta" yaymadığında arayüz sonsuza kadar
   * süren bir tur gösteriyordu; Durdur'a basmak da işe yaramıyordu çünkü ortada durdurulacak bir
   * koşu yoktu — kullanıcı ne olduğunu anlamadan kilitli kalıyordu.
   */
  readonly #outsideRunBusy = new Set<string>();
  /**
   * Oturum başına Durdur sayacı. `prompt` gönderimi tur oturana kadar bekletebilir; bu arada
   * Durdur'a basıldıysa sayaç değişmiştir ve bekleyen mesaj tur başlatmaz.
   */
  readonly #stops = new Map<string, number>();
  /** Motorun Pi kuyruğuna koyduğu mesajlar, görselleriyle; Pi kuyruğu yalnız metni tutar. */
  readonly #queued = new Map<string, QueuedMessage[]>();
  /** Kuyruğa koyması süren `steer`/`followUp` çağrıları (görsel hazırlığı, Pi girdi işleyicileri). */
  readonly #queueInflight = new Map<string, number>();
  /** Kuyruk bekçisi çalışan oturumlar. */
  readonly #queueWatch = new Set<string>();
  readonly #transient = new Map<string, number>();
  /** Geçici hatayla biten ve sürdürülecek oturumlar; hata bandı sürdürme vazgeçene kadar tutulur. */
  readonly #transientPending = new Set<string>();
  /** Süren sürdürme döngüsünün kesicisi; `abort()` beklemeyi keser, döngü `continue()` çağırmaz. */
  readonly #resumeAborts = new Map<string, AbortController>();
  /** Arka plan komutları; bittiklerinde oturumu dürtmek için motoru geri çağırırlar. */
  readonly #background: BackgroundRunner;
  /**
   * Oturum başına Pi uzantı API'si. Tur bittikten sonra oturuma mesaj göndermenin tek yolu bu;
   * arka plan görevi bittiğinde dürtme buradan gider.
   */
  readonly #pi = new Map<string, ExtensionAPI>();
  /** Ayrık ajan koşuları (arka plan / worktree); `agent` aracı ve `agentRuns:*` kanalları. */
  readonly runs: AgentRunManager;
  /** Oturum başına bekletilen (bellekteki) alt ajan koşularını durdurma; `subagents:stop`. */
  readonly #subagentStops = new Map<string, Map<string, () => void>>();
  /** Oturum başına çalışan, yazabilen bekletilen alt ajan sayısı; ikincisi worktree'ye alınır. */
  readonly #writingSubagents = new Map<string, number>();

  constructor(config: EngineConfig) {
    this.config = config;
    this.#background = new BackgroundRunner({
      onExit: (task) => this.#onBackgroundExit(task),
      ...(config.shell ? { shell: config.shell } : {}),
    });
    this.#snapshots = config.snapshotsDir ? new SnapshotStore(config.snapshotsDir) : undefined;
    this.#bashCheckpoints = this.#snapshots ? new BashCheckpoints(this.#snapshots) : undefined;
    this.#auditStore = config.auditsDir ? new AuditStore(config.auditsDir) : undefined;
    this.#lang = config.language ?? "tr";
    this.#i18n = createI18n(this.#lang);
    this.keys = new CredentialPool(
      join(config.agentDir, "keys.json"),
      join(config.agentDir, "auth.json"),
    );
    this.#meta = new SessionMetaStore(join(config.sessionsDir, "meta.json"));
    this.memory = new MemoryStore(config.memoryDir, this.#lang);
    this.resources = new ResourceCatalog(config.agentDir, this.#lang, config.projectTrusted);
    const agentsDir = config.agentsDir ?? join(config.agentDir, "agents");
    this.agents = new AgentStore({
      userDir: agentsDir,
      statePath: config.agentsStateFile ?? join(dirname(agentsDir), "agents-state.json"),
      lang: this.#lang,
      // Güven kapısı: güvenilmeyen depodaki `.codezal/agents` okunmaz (bkz. `AgentStoreOptions`).
      ...(config.projectTrusted ? { projectTrusted: config.projectTrusted } : {}),
    });
    this.runs = new AgentRunManager({
      runtime: this.#workerRuntime(),
      worktrees: config.worktrees ?? null,
      emit: (event) => this.bus.emit(event),
      buildPrompt: (task, isolated) => this.#runPrompt(task, isolated),
      worktreeError: (title) => this.#i18n.t("errors.agentWorktreeFailed", { title }),
      interruptedError: () => this.#i18n.t("errors.agentRunInterrupted"),
      concurrency: () => this.#agentRunSettings().concurrency,
      permission: ({ parentSessionId, isolated }) =>
        isolated
          ? this.#agentRunSettings().worktreePermission
          : (this.#live.get(parentSessionId)?.permission ?? "ask"),
      onEnded: (run, info) => this.#onAgentRunEnded(run, info),
      store: {
        load: () => this.#meta.agentRuns(),
        save: (parentSessionId, runs) => this.#meta.setAgentRuns(parentSessionId, runs),
      },
    });
    this.mcp = new McpManager({
      storePath: join(config.agentDir, "mcp.json"),
      openExternal: config.openExternal ?? (() => {}),
      language: this.#lang,
      ...(config.appVersion ? { appVersion: config.appVersion } : {}),
      ...(config.builtInOauthClients ? { builtInClients: config.builtInOauthClients } : {}),
      ...(config.mcpStdioPath ? { stdioPath: config.mcpStdioPath } : {}),
    });
    // MCP araç kümesi değişince (servis eklendi/kaldırıldı, list_changed) açık oturumlar tazelensin.
    this.#mcpToolsUnsub = this.mcp.onToolsChanged(() => void this.reloadLiveSessions());
    // Bellek ve plan klasörlerine yazmak sorulmadan serbest: hafıza tutmak ve plan modunda plan
    // yazmak izin diyaloğu açmasın.
    this.plans = new PlanReviewGate((review) =>
      this.bus.emit({ type: "plan_review", sessionId: review.sessionId, at: Date.now(), review }),
    );
    this.questions = new QuestionGate((request) =>
      this.bus.emit({
        type: "question_request",
        sessionId: request.sessionId,
        at: Date.now(),
        request,
      }),
    );
    this.permissions = new PermissionManager(
      (raw) => {
        // Ayrık ajan koşusunun izni ana oturumda sorulur: kullanıcı koşu oturumunu açmadan kartı
        // görür. Karar yine koşunun kendi izin moduna göre verilir (kapı koşu kimliğiyle çalışır).
        // Kart koşuya aittir (`run`): ana oturumun durumu değişmez, yoksa ana oturumun tek
        // bekleyen isteği ezilir ve sonraki durum olayı kartı silerdi.
        const run = this.runs.runOf(raw.sessionId);
        if (run) {
          this.runs.markWaiting(raw.sessionId, true);
          this.#forwardedAsks.set(raw.requestId, run.parentSessionId);
          const request = {
            ...raw,
            sessionId: run.parentSessionId,
            run: { id: run.id, title: run.title },
          };
          this.bus.emit({
            type: "permission_request",
            sessionId: request.sessionId,
            at: Date.now(),
            request,
          });
          return;
        }
        const request = raw;
        this.bus.emit({
          type: "permission_request",
          sessionId: request.sessionId,
          at: Date.now(),
          request,
        });
        this.bus.emit({
          type: "status",
          sessionId: request.sessionId,
          at: Date.now(),
          status: "waiting",
        });
      },
      [config.memoryDir, ...(config.plansDir ? [config.plansDir] : [])],
      this.#lang,
      // Servisler sayfasındaki araç izni (Otomatik/Sor/Kapalı) kapıda her çağrıda okunur.
      (toolName) => this.mcp.toolPolicy(toolName),
      (request) => {
        // Kart, isteğin yayınlandığı oturumda kalkar (koşunun isteği ana oturumda).
        const sessionId = this.#forwardedAsks.get(request.requestId) ?? request.sessionId;
        this.#forwardedAsks.delete(request.requestId);
        this.bus.emit({
          type: "permission_resolved",
          sessionId,
          at: Date.now(),
          requestId: request.requestId,
        });
      },
      // Kimlik dosyaları: okuma araçları her modda serbest olsa da bunlara hiçbir modda dokunulmaz.
      ["keys.json", "auth.json", "mcp.json"].map((name) => join(config.agentDir, name)),
    );
  }

  // ---------- katalog ve kimlik ----------

  async runtime(): Promise<ModelRuntime> {
    if (!this.#runtime) {
      // `allowModelNetwork` verilmez: create ağ isteğini bekletir, ilk model listesi gecikirdi.
      // Uzak katalog aşağıda arka planda çekilir.
      this.#runtime = await ModelRuntime.create({
        credentials: this.keys,
        authPath: join(this.config.agentDir, "auth.json"),
        modelsPath: join(this.config.agentDir, "models.json"),
        modelsStorePath: join(this.config.agentDir, "models-store.json"),
      });
      // Command Code Pi'nin yerleşik kataloğunda yok; sağlayıcıyı runtime'a biz ekliyoruz.
      registerCommandCode(this.#runtime);
    }
    if (!this.#catalogRefreshStarted) {
      this.#catalogRefreshStarted = true;
      void this.refreshCatalog();
    }
    return this.#runtime;
  }

  /** Uzak katalog tazelenip liste değişince haber verir; arayüz kataloğu yeniden çeker. */
  onCatalogChange(listener: () => void): () => void {
    this.#catalogListeners.add(listener);
    return () => this.#catalogListeners.delete(listener);
  }

  /**
   * Uzak model kataloğunu çeker (Pi, models.dev verisini pi.dev üzerinden yayınlar). Gömülü liste
   * Pi sürümüyle donduğu için yeni modeller ancak böyle görünür; ağ yoksa sessizce gömülü katalogla
   * devam edilir. `force` Pi'nin dört saatlik tazelik penceresini atlar (kullanıcı "Yenile" dedi).
   */
  async refreshCatalog(force = false): Promise<CatalogModel[]> {
    // Elle tazeleme kendiliğinden olanın yerine geçer; `runtime()` ikinci bir tazeleme başlatmasın.
    this.#catalogRefreshStarted = true;
    const rt = await this.runtime();
    const before = catalogSignature(listCatalog(rt));
    // PI_OFFLINE Pi'nin çevrimdışı bayrağı; ağ kapalıyken tazeleme yalnızca models.json'u okur.
    const allowNetwork = process.env.PI_OFFLINE === undefined;
    // Command Code Pi kataloğunda olmadığından listesi kendi ucundan, Pi tazelemesiyle paralel.
    const commandCode = allowNetwork
      ? fetchCommandCodeModels(AbortSignal.timeout(15_000))
      : Promise.resolve(undefined);
    try {
      await rt.refresh({ allowNetwork, force });
    } catch {
      // Ağ, bozuk models.json ya da sağlayıcı hatası: gömülü katalog geçerli kalır.
    }
    const commandCodeModels = await commandCode;
    if (commandCodeModels) registerCommandCode(rt, commandCodeModels);
    const after = listCatalog(rt);
    if (catalogSignature(after) !== before) for (const l of this.#catalogListeners) l();
    return after;
  }

  async providers(): Promise<ProviderInfo[]> {
    return listProviders(await this.runtime(), this.keys);
  }

  /**
   * Kota sorgusu için aktif yuvanın çözülmüş ham anahtarı. Değer yalnız main süreçte kalır:
   * IPC sözleşmesinde yoktur, renderer'a gönderilmez. OAuth kimliği anahtar taşımadığı için
   * `undefined` döner (kota uçlarının hiçbiri OAuth ile çalışmıyor).
   */
  async apiKeyFor(providerId: string): Promise<string | undefined> {
    const credential = await this.keys.read(providerId);
    if (credential?.type !== "api_key") return undefined;
    return credential.key;
  }

  async catalog(): Promise<CatalogModel[]> {
    return listCatalog(await this.runtime());
  }

  /** Anahtar ekler; sağlayıcıda zaten anahtar varsa havuza yedek olarak girer. */
  async setApiKey(providerId: string, apiKey: string, label?: string): Promise<void> {
    const rt = await this.runtime();
    // Etiket havuzda bekler; Pi login → modify ile ekler ve sağlayıcı durumunu eşitler.
    this.keys.add(providerId, label);
    await rt.login(providerId, "api_key", apiKeyInteraction(apiKey));
  }

  /** Tüm anahtarları kaldırır. */
  async logout(providerId: string): Promise<void> {
    const rt = await this.runtime();
    await rt.logout(providerId);
  }

  async removeApiKey(providerId: string, keyId: string): Promise<void> {
    const { remaining } = this.keys.remove(providerId, keyId);
    // Son anahtar gitti: Pi'nin sağlayıcı durumunu "bağlı değil"e çekmesi için çıkış yapılır.
    if (remaining === 0) await this.logout(providerId);
  }

  activateApiKey(providerId: string, keyId: string): void {
    this.keys.activate(providerId, keyId);
  }

  // ---------- web araması ----------

  /** Arama aracının sağlayıcı seçimi ve Brave anahtarı okuyucusu; ayar her çağrıda canlı okunur. */
  #webSearchOptions(): Pick<WebSearchOptions, "provider" | "braveKey"> {
    return {
      provider: () => this.config.webSearch?.() ?? { provider: "auto", searxngUrl: "" },
      braveKey: async () => {
        const credential = await this.keys.read(BRAVE_KEY_ID);
        return credential?.type === "api_key" ? credential.key : undefined;
      },
    };
  }

  /** Brave Search API anahtarı kayıtlı mı; renderer yalnız bunu görür. */
  hasBraveKey(): boolean {
    return this.keys.slotCount(BRAVE_KEY_ID) > 0;
  }

  /** Brave anahtarını değiştirir: tek yuva tutulur, eski anahtar silinir. */
  async setBraveKey(apiKey: string): Promise<void> {
    const key = apiKey.trim();
    if (!key) throw new Error(this.#i18n.t("errors.braveKeyMissing"));
    await this.keys.delete(BRAVE_KEY_ID);
    await this.keys.modify(BRAVE_KEY_ID, async () => ({ type: "api_key", key }));
  }

  async clearBraveKey(): Promise<void> {
    await this.keys.delete(BRAVE_KEY_ID);
  }

  // ---------- oturumlar ----------

  #sessionDir(cwd: string): string {
    return join(this.config.sessionsDir, encodeCwd(cwd));
  }

  /** Oturumun plan dosyası: plansDir/<proje>/<oturum>.md; plansDir yoksa özellik kapalı. */
  planPath(sessionId: string, cwd = this.#live.get(sessionId)?.cwd): string | undefined {
    if (!this.config.plansDir || !cwd) return undefined;
    return join(this.config.plansDir, encodeCwd(cwd), `${sessionId}.md`);
  }

  /**
   * Taşınmış proje: oturum, bellek ve plan klasörleri yeni yolun slug'ına taşınır, oturum
   * başlıklarındaki `cwd` güncellenir. Hedef klasör zaten varsa o kapsam olduğu gibi kalır.
   */
  relocateProject(from: string, to: string): { sessions: number } {
    const moves: Array<[string, string]> = [
      [this.#sessionDir(from), this.#sessionDir(to)],
      [
        this.memory.dirFor({ kind: "proje", cwd: from }),
        this.memory.dirFor({ kind: "proje", cwd: to }),
      ],
    ];
    if (this.config.plansDir) {
      const plans = this.config.plansDir;
      moves.push([join(plans, encodeCwd(from)), join(plans, encodeCwd(to))]);
    }
    for (const [src, dst] of moves) {
      if (!existsSync(src) || existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
    }
    let sessions = 0;
    const dir = this.#sessionDir(to);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".jsonl") && rewriteSessionCwd(join(dir, file), from, to)) sessions++;
      }
    }
    // Yol önbelleği eski klasörü gösterir; listeleme yeniden doldurur.
    this.#paths.clear();
    return { sessions };
  }

  #summarize(info: SessionInfo): SessionSummary {
    const meta = this.#meta.get(info.id);
    this.#paths.set(info.id, info.path);
    // Açık oturumun adı bellekten: Pi `session_info` kaydını ilk yanıt diske yazılana dek bellekte
    // tutar, yanıt akarken üretilen başlık diskten okunsa ancak tur bitince görünürdü.
    const name =
      this.#live.get(info.id)?.session.sessionManager.getSessionName()?.trim() ||
      info.name?.trim() ||
      deriveSessionTitle(info.firstMessage, this.#i18n.t("session.newTask"));
    return {
      id: info.id,
      path: info.path,
      cwd: info.cwd,
      name,
      mode: meta.mode,
      createdAt: info.created.getTime(),
      modifiedAt: info.modified.getTime(),
      messageCount: info.messageCount,
      pinned: meta.pinned,
      archived: meta.archived,
      live: this.#live.has(info.id),
      projectId: meta.projectId,
      auditRunId: meta.audit?.runId ?? null,
      parentSessionId: meta.parentSessionId,
      sideOf: meta.sideOf,
    };
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const infos = cwd
      ? await SessionManager.list(cwd, this.#sessionDir(cwd))
      : await this.#listAll();
    const summaries = infos.map((i) => this.#summarize(i));
    // Pi dosyayı ilk yanıttan sonra yazar; açık ama henüz diske düşmemiş oturum (ör. main'in
    // kurduğu koordinatör) yoksa liste tazelenince özetini kaybeder ve başlık "Oturum"a döner.
    const listed = new Set(summaries.map((summary) => summary.id));
    for (const [id, live] of this.#live) {
      if (listed.has(id) || (cwd && live.cwd !== cwd)) continue;
      summaries.push({ ...(await this.#fallbackSummary(id, live.cwd)), live: true });
    }
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /**
   * Oturum içeriğinde tam metin arama. Kimlikler verilen sırayla (yeniden eskiye) taranır;
   * `limit` isabete ya da `budgetMs` süresine ulaşınca durulur ve `truncated` döner.
   *
   * Yol main'in kendi kaydından çözülür (renderer yol göndermez). Bilinmeyen kimlik için liste
   * en çok dakikada bir tazelenir: Pi'nin listelemesi her dosyayı baştan okur, her tuş vuruşunda
   * çağrılırsa arama dosyaları iki kez okumuş olurdu. Yan sohbetler ve ajan koşusu oturumları
   * kenar çubuğunda görünmediği için aranmaz (renderer de süzer; bu ikinci savunma).
   */
  async searchSessions(
    ids: readonly string[],
    query: string,
    options: { limit?: number; budgetMs?: number } = {},
  ): Promise<{ hits: SessionSearchHit[]; truncated: boolean }> {
    const needle = foldQuery(query);
    if (!needle) return { hits: [], truncated: false };
    const limit = options.limit ?? 20;
    const deadline = Date.now() + (options.budgetMs ?? 1500);
    if (ids.some((id) => !this.#paths.has(id)) && Date.now() - this.#searchListedAt > 60_000) {
      this.#searchListedAt = Date.now();
      await this.listSessions();
    }
    const hits: SessionSearchHit[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (hits.length >= limit || Date.now() > deadline) return { hits, truncated: true };
      const id = ids[i] ?? "";
      const meta = this.#meta.get(id);
      if (meta.sideOf || meta.parentSessionId) continue;
      const path = this.#paths.get(id);
      if (!path) continue;
      const hit = await this.#searchIndex.search(path, needle);
      if (hit) hits.push({ id, ...hit });
    }
    return { hits, truncated: false };
  }

  /**
   * Pi'nin `listAll(dir)` çağrısı verilen klasörü düz tarar; bizim oturumlar ise proje başına alt
   * klasörde durur (`sessionsDir/<cwd>/`). Bu yüzden alt klasörleri tek tek tararız.
   */
  async #listAll(): Promise<SessionInfo[]> {
    const root = this.config.sessionsDir;
    if (!existsSync(root)) return [];
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
    const lists = await Promise.all(dirs.map((d) => SessionManager.listAll(d)));
    return lists.flat();
  }

  /** Oturumu markdown olarak dışa aktarır. */
  async exportSession(id: string): Promise<string> {
    const { summary, transcript } = await this.openSession(id);
    const t = this.#i18n.t;
    const lines: string[] = [
      `# ${summary.name}`,
      "",
      t("session.exportProject", { path: summary.cwd }),
      "",
    ];
    for (const item of transcript) {
      // Kullanıcı mesajı yazıldığı gibi aktarılır: gizli talimat ve okuma listesi blokları düşer.
      // "Yanıtla" alıntıları metnin önüne markdown alıntısı olarak yazılır.
      if (item.type === "user") {
        const quotes = promptQuotes(item.text).map((q) => `> ${q.replace(/\n/g, "\n> ")}`);
        lines.push(`## ${t("session.you")}`, "", ...quotes.flatMap((q) => [q, ""]));
        lines.push(collapsePromptMarkup(item.text), "");
      } else if (item.type === "assistant") lines.push("## Codezal", "", item.text, "");
      else if (item.type === "tool")
        lines.push(`> ${item.title}: ${item.target ?? item.command ?? ""}`, "");
      // `boundary`: yalnızca katlama ölçütü, dışa aktarımda satır üretmez.
    }
    return lines.join("\n");
  }

  /**
   * Tek seferlik tamamlama (commit mesajı önerisi, oturum başlığı). Araç kullanmaz.
   *
   * - `sessionId` her çağrıya verilir: OpenCode / OpenCode Go istekleri `x-opencode-session`
   *   başlığı olmadan 400 döner (Pi başlığı `sessionId`'den ekler). Eskiden verilmiyordu; bu
   *   sağlayıcılarda başlık üretimi ve commit önerisi hep boş kalıyordu.
   * - Düşünen modelde düşünme en düşük seviyede: kısa bir metin için uzun düşünme hem gecikme
   *   hem maliyet (DeepSeek varsayılanda başlık için yüzlerce token düşünüyordu).
   * - Pi hatayı fırlatmaz, `stopReason: "error"` ile boş içerik döner; burada fırlatılır ki
   *   çağıran günlüğe yazabilsin ve sessiz boş yanıt "model bir şey demedi" gibi görünmesin.
   */
  async complete(ref: ModelRef, system: string, prompt: string): Promise<string> {
    const runtime = await this.runtime();
    const model = runtime.getModel(ref.provider, ref.id) as Model<Api> | undefined;
    if (!model)
      throw new Error(this.#i18n.t("errors.modelNotFound", { ref: `${ref.provider}/${ref.id}` }));
    const msg = await runtime.completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      { sessionId: randomUUID(), ...(model.reasoning ? { reasoning: "minimal" as const } : {}) },
    );
    if (msg.stopReason === "error" || msg.stopReason === "aborted")
      throw new Error(msg.errorMessage || `${ref.provider}/${ref.id}: ${msg.stopReason}`);
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
  }

  /** OAuth / cihaz kodu ile giriş. Akış olayları `interaction.notify` ile dışarı aktarılır. */
  async oauthLogin(providerId: string, interaction: AuthInteraction): Promise<void> {
    const rt = await this.runtime();
    await rt.login(providerId, "oauth", interaction);
  }

  #contextFiles(cwd: string): Array<{ path: string; content: string }> {
    const out: Array<{ path: string; content: string }> = [];
    for (const name of EXTRA_CONTEXT_FILES) {
      const p = join(cwd, name);
      if (existsSync(p)) out.push({ path: p, content: readFileSync(p, "utf8") });
    }
    return out;
  }

  /** `codezal-prompt` uzantısı: Codezal kimliği ve her turda tazelenen ortam bölümü. */
  #promptExtension(
    cwd: string,
    identity: "prompt.identity" | "prompt.identityReadOnly" = "prompt.identity",
  ) {
    return promptExtension({
      identity: () => this.#i18n.t(identity),
      environment: (model) =>
        environmentText(
          liveEnvironment({
            cwd,
            locale: this.#lang,
            shell: this.config.shell?.() ?? agentShell().shell,
            model,
          }),
          this.#i18n,
        ),
    });
  }

  /** Moda özgü sistem istemi; EN arayüzde model İngilizce yanıt verir. */
  #modeSystem(mode: AppMode): string {
    // Asistan: betik yazıp bırakmak yerine çıktıyı üretip doğrulama kuralı da eklenir.
    if (mode === "asistan")
      return `${this.#i18n.t("prompt.asistanSystem")}\n\n${this.#i18n.t("prompt.asistanVerify")}`;
    // Kodlama: araçlar arasında kısa durum notları yazılsın; kullanıcı "başladı–bitti" yerine işin
    // akışını görsün (ZCode'daki iletişim kuralının karşılığı).
    return this.#i18n.t("prompt.workUpdates");
  }

  /**
   * Bash korumalı alanı kararı: ayar her çağrıda okunur ki anahtar açık oturumlara da yansısın.
   * Profil çalışma klasörünü, çıktı klasörünü ve veri kökünü içerir.
   */
  #sandbox(cwd: string, outputsDir?: string): SandboxDecision {
    return sandboxDecision(this.config.bashSandbox?.() ?? false, {
      cwd,
      outputsDir,
      userDataDir: this.config.userDataDir,
    });
  }

  /**
   * `codezal-hooks`: kullanıcının PreToolUse / PostToolUse komutları (bkz. `hooks.ts`). Reddedilen
   * çağrı `sessionId` (alt ajanda ana oturum) ile işaretlenir: ana oturumda `tool_end` akışı, alt
   * ajanda iz izleyicisi (`#tracerFor`) işareti tüketir.
   */
  #hooksExtension(sessionId: string, cwd: string) {
    const hooks = this.config.hooks;
    const env = this.config.hookEnv;
    const shell = this.config.shell;
    return hooksExtension(
      sessionId,
      cwd,
      {
        hooks: (c) => hooks?.(c) ?? [],
        ...(env ? { env } : {}),
        ...(shell ? { shell } : {}),
        warn: (message) => this.config.log?.("warn", "hooks", message),
        onDeny: (toolCallId: string) => this.#markBlocked(sessionId, toolCallId, "denied"),
      },
      this.#lang,
    );
  }

  /** Asistan: çıktı klasörü dışına yazma ilk denemede engellenir, doğru klasör modele söylenir. */
  #outputsExtension(cwd: string, outputsDir: string) {
    const guard = createOutputsGuard(cwd, outputsDir, this.#lang);
    return (pi: ExtensionAPI) => {
      pi.on("tool_call", (event) => {
        const reason = guard(event.toolName, event.input as Record<string, unknown>);
        return reason ? { block: true, reason } : undefined;
      });
    };
  }

  /**
   * Görsel bütçesi: Pi her LLM çağrısından önce geçmişin bir kopyasını `context` kancasına verir;
   * sınırı aşan en eski görseller o kopyada yer tutucuya çevrilir. Bayt bütçesi ağ geçidinin gövde
   * sınırı içindir (aşılınca açıklamasız 400), sayı sınırı sağlayıcının kuralıdır (DeepSeek 4).
   * Kanca tur ortasında da çalıştığından PDF sayfası gibi araç sonucuyla gelen görseller de sayılır;
   * `prompt()` anında yapılan kırpma bunları göremiyordu. Oturum dosyası ve bellekteki geçmiş
   * değişmez, geri sarma ve model değişikliği görselleri hâlâ bulur.
   */
  #imageBudgetExtension() {
    return (pi: ExtensionAPI) => {
      pi.on("context", (event, ctx) => {
        // Ucuz bağlam kademesi önce: eski araç sonuçları düşürülür, görsellere dokunulmaz.
        const saved = microcompact(event.messages, (tool) =>
          this.#i18n.t("prompt.toolOutputDropped", { tool }),
        );
        const count = maxImagesPerRequest(ctx.model);
        const dropped = trimImageHistory(
          event.messages,
          count === undefined
            ? { bytes: SESSION_IMAGE_BUDGET_BYTES }
            : { bytes: SESSION_IMAGE_BUDGET_BYTES, count },
          (reason) =>
            reason === "count"
              ? this.#i18n.t("prompt.imageLimit", { n: count ?? 0 })
              : this.#i18n.t("prompt.imageDropped"),
        );
        return saved > 0 || dropped > 0 ? { messages: event.messages } : undefined;
      });
    };
  }

  /**
   * PDF okuma: Pi'nin `read` aracı PDF'i tanımaz, ham baytları utf-8 metin sanıp sessizce çöp
   * döndürür. Sonuç burada gerçek içerikle değiştirilir; böylece modelin ayrı bir araç bilmesi
   * gerekmez, PDF'i `read` ile açar. Metinsiz (taranmış) sayfalar görüntü olarak eklenir.
   */
  /**
   * Plan modu: her turun sistem istemine oturumun plan dosyası `plan` bölümü olarak eklenir
   * (Claude Code'un plan dosyası modeli). İzin modu tur ortasında değişebildiği için oturum
   * açılışında değil turda bakılır. Bölüm adlıdır: plan modundan çıkınca Pi onu yamayla kaldırır;
   * `systemPrompt` döndürmek istemin tamamını o turluk sabitliyor ve bölüm yamasını atlıyordu.
   */
  #planExtension(sessionId: string, cwd: string) {
    return (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        if (this.#live.get(sessionId)?.permission !== "plan") return undefined;
        const path = this.planPath(sessionId, cwd);
        if (!path) return undefined;
        mkdirSync(dirname(path), { recursive: true });
        event.systemPromptOptions.sections.plan = this.#i18n.t("prompt.planFile", { path });
        return undefined;
      });
    };
  }

  /** Oturumun kendi tur anahtarı: daldaki kullanıcı mesajı sayısı (renderer aynı kuralla sayar). */
  #ownRoute(sessionId: string): CheckpointRoute | undefined {
    const live = this.#live.get(sessionId);
    if (!live) return undefined;
    return { sessionId, turn: live.session.messages.filter((m) => m.role === "user").length };
  }

  /**
   * Tur yedeği kancaları. `edit`/`write` çalışmadan önce dosyanın tur öncesi hâli, `bash`
   * çalışmadan önce de klasör dizini (+ gerekli kopyalar) alınır; komut sonucu gelince fark tur
   * yedeğine yazılır ve değişen dosyalar araç sonucunun `details.changedFiles` alanına eklenir
   * (tur dosya listesi bunları da gösterir). `route` yedeğin yazılacağı oturum/turu verir.
   * `collect` verilirse değişen dosyalar ona da bildirilir (alt ajanın dosyaları ana oturumdaki
   * `agent` kartına iliştirilir; `attachSubagentFiles` ana oturumda bunu yapar).
   */
  #checkpointHooks(
    pi: ExtensionAPI,
    options: {
      cwd: string;
      outputsDir?: string;
      route: () => CheckpointRoute | undefined;
      collect?: (changes: FileChange[]) => void;
      attachSubagentFiles?: boolean;
    },
  ): void {
    const store = this.#snapshots;
    const checkpoints = this.#bashCheckpoints;
    if (!store || !checkpoints) return;
    const { cwd, outputsDir } = options;
    // Yazma aracının çağrı anındaki hükmü (oluşturma/düzenleme); başarılı sonuçla listeye düşer.
    const writes = new Map<string, FileChange[]>();
    const bashCalls = new Set<string>();
    pi.on("tool_call", async (event) => {
      const tool = event.toolName;
      const route = options.route();
      if (!route) return undefined;
      if (tool === BASH_TOOL) {
        bashCalls.add(event.toolCallId);
        // Çıktı klasörü taranmaz: üretilen teslimler tur yedeğinin konusu değil.
        await checkpoints.begin(event.toolCallId, route, cwd, outputsDir ? [outputsDir] : []);
        return undefined;
      }
      const isWrite =
        tool === "edit" ||
        tool === "write" ||
        FILE_EDIT_TOOLS.has(tool) ||
        FILE_CREATE_TOOLS.has(tool);
      if (!isWrite) return undefined;
      const input = event.input as Record<string, unknown>;
      const raw = input.path;
      if (typeof raw !== "string" || !raw) return undefined;
      // Belge düzenlemesi `output` verilince başka dosyaya yazar; yedek yazılan dosyanın olmalı.
      // `pdf_edit` bölmede birden çok parça yazar, alan listelemede hiç yazmaz.
      const paths = FILE_EDIT_TOOLS.has(tool)
        ? editedFiles(tool, input, cwd)
        : [turnBackupPath(tool, raw, cwd, outputsDir)];
      if (options.collect && paths.length > 0) {
        writes.set(
          event.toolCallId,
          paths.map((path) => ({ path, kind: existsSync(path) ? "edit" : "create" })),
        );
      }
      for (const path of paths) {
        try {
          store.record(route.sessionId, route.turn, path);
        } catch {
          // Yedek alınamadıysa araç yine çalışır; geri alma o dosyayı atlar.
        }
      }
      return undefined;
    });
    pi.on("tool_result", async (event) => {
      if (bashCalls.delete(event.toolCallId)) {
        // Komut hata koduyla bitse de dosyalar değişmiş olabilir: fark her durumda ölçülür.
        const changes = await checkpoints.finish(event.toolCallId);
        if (changes.length === 0) return undefined;
        options.collect?.(changes);
        return withChangedFiles(event.details, changes);
      }
      const write = writes.get(event.toolCallId);
      if (write) {
        writes.delete(event.toolCallId);
        if (!event.isError) options.collect?.(write);
        return undefined;
      }
      if (options.attachSubagentFiles) {
        const files = this.#subagentFiles.get(event.toolCallId);
        if (!files) return undefined;
        this.#subagentFiles.delete(event.toolCallId);
        return withChangedFiles(event.details, [...files.values()]);
      }
      return undefined;
    });
    pi.on("agent_end", () => {
      // Sonucu gelmeyen komut (kesilen tur) bekleyen ölçüm bırakmasın.
      for (const id of bashCalls) checkpoints.drop(id);
      bashCalls.clear();
      writes.clear();
    });
  }

  /**
   * Tur kancaları. (1) `edit`/`write`/`bash` değişikliklerinin tur öncesi hâli yedeklenir
   * (`#checkpointHooks`); tur altındaki "Geri al" buradan döner. (2) Tur sonunda boş yanıt ya da (Asistan) çalıştırılmamış
   * betik varsa modele gizli bir dürtme gider; Pi `agent_end` içinde kuyruğa giren mesajı aynı
   * turun devamı olarak işler, kullanıcı "devam" yazmak zorunda kalmaz. (3) Kodlama'da dosya değişen
   * turun sonunda kontrol komutları çalışır; başarısız olan çıktısıyla modele geri verilir.
   * Dürtmeler tur başına türde bir kezdir (kontrol için en fazla MAX_CHECK_NUDGES); döngü olmaz.
   */
  #turnExtension(sessionId: string, cwd: string, mode: AppMode, outputsDir?: string) {
    return (pi: ExtensionAPI) => {
      // Tur bittikten sonra oturuma mesaj göndermek için saklanır (arka plan görevi bitişi).
      this.#pi.set(sessionId, pi);
      // Korumalı alanda koşan `bash` sonucu işaretlenir. Sıfır dışı çıkışta Pi hata fırlattığı için
      // araç ayrıntıyı kendisi yazamaz; Pi `details`'i oturum dosyasına da yazar, yeniden açılışta kalır.
      pi.on("tool_result", (event) => {
        if (!this.#sandboxedCalls.delete(event.toolCallId)) return undefined;
        const details =
          typeof event.details === "object" && event.details !== null ? event.details : {};
        return { details: { ...details, sandboxed: true } };
      });
      if (outputsDir) this.#outputsDirs.set(sessionId, outputsDir);
      this.#checkpointHooks(pi, {
        cwd,
        ...(outputsDir ? { outputsDir } : {}),
        // Yalıtımsız ajan koşusu ana oturumun turuna yazar; diğer oturumlar kendi turuna.
        route: () => this.#checkpointRoutes.get(sessionId) ?? this.#ownRoute(sessionId),
        attachSubagentFiles: true,
      });
      pi.on("agent_end", async (event) => {
        const nudge = analyzeTurn(event.messages, { mode });
        // Dürtme sırası: (1) boş yanıt turun boşa gittiğini söyler, (2) tur sonu kontrolleri
        // başarısızsa önce hata düzeltilir, (3) kalan dürtmeler (çalıştırılmamış betik, açık adım).
        if (nudge?.kind !== "empty-response") {
          const checked =
            mode !== "asistan" && (await this.#runTurnChecks(sessionId, cwd, event.messages, pi));
          if (checked) return;
        }
        if (nudge) {
          this.#nudge(pi, nudge.kind, this.#nudgeText(nudge));
        }
      });
    };
  }

  /**
   * Kalıcı hedef döngüsü (`/goal`): tur bitiminde son asistan mesajındaki sentinel aranır.
   * `codezal-turn`'den sonra kaydedilir ki kontrol dürtmeleri goal devamından önce kuyruğa girsin;
   * iki dürtme sıralı turlar olarak işler (Pi followUp kuyruğu sıralıdır).
   * Sayaç her tur değiştiği için direktif sistem promptuna değil, gizli kullanıcı mesajına konur:
   * konuşmanın kuyruğu yeniden değerlendirilir, önbelleğin büyük bölümü korunur.
   */
  #goalExtension(sessionId: string) {
    return (pi: ExtensionAPI) => {
      pi.on("agent_end", (event) => {
        void this.#onGoalTurnEnd(sessionId, event.messages, pi);
      });
    };
  }

  async #onGoalTurnEnd(
    sessionId: string,
    messages: readonly AgentMessage[],
    pi: ExtensionAPI,
  ): Promise<void> {
    const goal = this.#meta.get(sessionId).goal;
    if (!goal || goal.paused) return;
    const last = messages[messages.length - 1];
    const stop = last?.role === "assistant" ? (last as AssistantMessage).stopReason : undefined;
    if (stop === "error") return; // Toparlanma #resumeAfterError'da; başarıdan sonra yeniden bakılır.
    if (stop === "aborted") {
      // Kullanıcı turu kesti: kontrol kullanıcıya döner, hedef temizlenir (legacy davranışı).
      this.#clearGoal(sessionId, "stopped");
      return;
    }
    const sentinel = analyzeGoalEnd(messages);
    if (sentinel) {
      this.#clearGoal(sessionId, sentinel);
      return;
    }
    if (goal.iter + 1 >= goal.maxIter) {
      this.#clearGoal(sessionId, "max_iter");
      return;
    }
    const iter = goal.iter + 1;
    this.#meta.set(sessionId, { goal: { ...goal, iter } });
    this.#nudge(pi, "goal", this.#goalContinueText(goal.text, iter, goal.maxIter));
  }

  /** Devam dürtmesi: güncel sayaçlı direktif + kısa "Continue."; kullanıcıya görünmez. */
  #goalContinueText(text: string, iter: number, maxIter: number): string {
    return `${buildGoalDirective({ text, iter, maxIter })}\n\n${this.#i18n.t("prompt.goalContinue")}`;
  }

  /** Hedefi meta'dan siler ve durum geçişini yayınlar; hedef yoksa sessizce çıkar. */
  #clearGoal(id: string, note: "done" | "blocked" | "stopped" | "max_iter"): void {
    const goal = this.#meta.get(id).goal;
    if (!goal) return;
    this.#meta.set(id, { goal: undefined });
    this.bus.emit({ type: "goal", sessionId: id, at: Date.now(), goal: null, note });
  }

  /** Yayınlanabilir hedef durumu (createdAt meta içinde kalır). */
  #goalOf(id: string): GoalState | undefined {
    const goal = this.#meta.get(id).goal;
    return goal
      ? { text: goal.text, iter: goal.iter, maxIter: goal.maxIter, paused: goal.paused }
      : undefined;
  }

  /** Dürtme türüne göre i18n metni; tür ayrımı tek yerde kalsın. */
  #nudgeText(nudge: TurnNudge): string {
    switch (nudge.kind) {
      case "empty-response":
        return this.#i18n.t("prompt.nudgeEmpty");
      case "unrun-script":
        return this.#i18n.t("prompt.nudgeRunScript", { path: nudge.path ?? "" });
      case "open-steps":
        return this.#i18n.t("prompt.nudgeOpenSteps", {
          steps: (nudge.open ?? []).map((s) => `- ${s}`).join("\n"),
        });
    }
  }

  /** Gizli dürtme: kullanıcıya görünmez, modele kullanıcı mesajı olarak gider, tur sürer. */
  #nudge(pi: ExtensionAPI, kind: NudgeKind | "background" | "goal", text: string): void {
    try {
      pi.sendMessage(
        { customType: NUDGE_TYPE, content: text, display: false, details: { kind } },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // Oturum reload/kapanış penceresinde eski extension API'si geçersiz olabilir; dürtme
      // kaybolur ama uygulama çökmez (reload sonrası yeni turda tazelenir).
    }
  }

  /**
   * Arka plan komutu bitti: oturum hâlâ açıksa model gizli bir mesajla uyandırılır ve sonucu
   * kullanıcıya kendisi bildirir (tur çoktan bitmiş olabilir; Pi boştaysa yeni tur başlatır).
   * Oturum kapandıysa süreç zaten `stopSession` ile durdurulmuştur, dürtecek kimse yoktur.
   */
  #onBackgroundExit(task: BackgroundTask): void {
    // Ön plan penceresinde başlayıp pencere içinde biten komut arka plan işi değildir: sonucu
    // araç sonucu olarak modele döndü, ne olay ne dürtme gerekir.
    if (!task.backgrounded) return;
    const pi = this.#pi.get(task.sessionId);
    // Durdurulan görev dahil sonunu Ajanlar kutusuna bildiririz; dürtme yalnızca haberi olan
    // görevler için (kullanıcının durdurduğu sonucu zaten biliyor).
    this.bus.emit({
      sessionId: task.sessionId,
      at: Date.now(),
      type: "background_end",
      jobId: task.id,
      status: task.status === "running" ? "exited" : task.status,
      ...(task.code === undefined ? {} : { code: task.code }),
    });
    if (!pi || !this.#live.has(task.sessionId)) return;
    // Kullanıcının durdurduğu görev haber gerektirmez; sonucu zaten kendisi istedi.
    if (task.status === "stopped") return;
    // Görev başladıktan sonra dosyalar değiştiyse sonuç eskimiş olabilir: modele söylenmezse
    // eski çıktıdaki hatayı taze sanıp gereksiz bir doğrulama koşusu başlatıyor. Yollar oturum
    // köküne göreli verilir (mutlak yol bildirimi gereksiz şişiriyor).
    const cwd = this.#live.get(task.sessionId)?.cwd;
    const changed = (this.#snapshots?.changedSince(task.sessionId, task.startedAt) ?? []).map(
      (p) => {
        if (!cwd) return p;
        const rel = relative(cwd, p);
        return rel && !rel.startsWith("..") ? rel : p;
      },
    );
    const edited = changed.slice(0, 10).join(", ");
    // Bildirime eklenen notlar: kırpma (sessiz kalmasın), süre dolması, eskimiş çıktı.
    const notes: string[] = [];
    if (task.outputChars > DONE_OUTPUT_TAIL) {
      notes.push(
        this.#i18n.t("prompt.backgroundTruncated", {
          id: task.id,
          total: String(task.outputChars),
          shown: String(DONE_OUTPUT_TAIL),
        }),
      );
    }
    if (task.timedOut) notes.push(this.#i18n.t("prompt.backgroundTimedOut"));
    if (changed.length > 0) {
      notes.push(
        this.#i18n.t("prompt.backgroundDoneStale", {
          files: changed.length > 10 ? `${edited} … (+${changed.length - 10})` : edited,
        }),
      );
    }
    const text = this.#i18n.t("prompt.backgroundDone", {
      id: task.id,
      command: task.command,
      code: String(task.code ?? -1),
      output: task.output.slice(-DONE_OUTPUT_TAIL) || "-",
    });
    this.#nudge(pi, "background", notes.length === 0 ? text : `${text}\n\n${notes.join("\n")}`);
  }

  /**
   * Tur sonu kontrolleri: dosya değişen Kodlama turunda ayarlardaki komutlar sırayla çalışır.
   * İlk başarısız komutun çıktı kuyruğu modele döner ve tur sürer; aynı turda ikinci başarısızlıktan
   * sonra yalnızca sonuç yayınlanır, karar kullanıcıya kalır. Sonuç `checks` olayıyla arayüze gider.
   */
  async #runTurnChecks(
    sessionId: string,
    cwd: string,
    messages: readonly AgentMessage[],
    pi: ExtensionAPI,
  ): Promise<boolean> {
    const commands = this.config.turnChecks?.(cwd) ?? [];
    const run = this.config.runCheck;
    if (commands.length === 0 || !run) return false;
    const turn = turnMessages(messages);
    if (!turnTouchedFiles(turn)) return false;
    const prior = turn.filter(
      (m) =>
        (m as { role: string }).role === "custom" &&
        (m as { customType?: string }).customType === NUDGE_TYPE &&
        ((m as { details?: { kind?: string } }).details?.kind ?? "") === "checks",
    ).length;
    const at = Date.now();
    for (const command of commands) {
      let result: { ok: boolean; output: string };
      try {
        result = await run(cwd, command);
      } catch (error) {
        result = { ok: false, output: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) continue;
      this.bus.emit({ type: "checks", sessionId, at, ok: false, commands, failed: command });
      if (prior >= MAX_CHECK_NUDGES) return false;
      const output = result.output.slice(-CHECK_OUTPUT_TAIL);
      this.#nudge(pi, "checks", this.#i18n.t("prompt.nudgeChecks", { command, output }));
      return true;
    }
    this.bus.emit({ type: "checks", sessionId, at, ok: true, commands });
    return false;
  }

  // ---------- kod incelemesi (deneysel) ----------

  /**
   * "İncele" düğmesi: son değişiklikleri ayrı bir denetçiyle inceler. Hemen döner; koşu arka
   * planda sürer, sonuç `review` olayıyla gelir. Gölge moddadır: bulgular yalnızca raporlanır,
   * modele geri verilmez. Otomatik tetikleme yoktur; koşuyu kullanıcı başlatır.
   */
  startReview(sessionId: string): {
    started: boolean;
    reason?: "no-changes" | "busy" | "disabled";
  } {
    const live = this.#live.get(sessionId);
    const store = this.config.reviewStore;
    if (!live || !store || !(this.config.reviewer?.() ?? false)) {
      return { started: false, reason: "disabled" };
    }
    if (this.#reviews.has(sessionId)) return { started: false, reason: "busy" };
    const files = this.#reviewFiles(sessionId, live.cwd);
    if (files.length === 0) return { started: false, reason: "no-changes" };
    // Bulgular ait olduğu turun altında görünsün diye kullanıcı turu numarası olaya konur;
    // renderer tur kapanış mesajlarını aynı numarayla eşler.
    const turn = live.session.messages.filter((m) => m.role === "user").length;
    const controller = new AbortController();
    this.#reviews.set(sessionId, controller);
    this.bus.emit({
      type: "review",
      sessionId,
      at: Date.now(),
      phase: "started",
      turn,
      files,
    });
    void this.#runReview(sessionId, live.cwd, files, controller.signal, turn).finally(() => {
      if (this.#reviews.get(sessionId) === controller) this.#reviews.delete(sessionId);
    });
    return { started: true };
  }

  /** Bulgu işareti (ölçüm): gerçek / yanlış pozitif; kayda ayrı satır olarak yazılır. */
  markReviewFinding(sessionId: string, findingId: string, outcome: ReviewOutcome): void {
    const live = this.#live.get(sessionId);
    const store = this.config.reviewStore;
    if (!live || !store) return;
    store.mark(live.cwd, sessionId, findingId, outcome);
  }

  /** İnceleme kayıt klasörü; depo kapalıysa null. */
  reviewDir(sessionId: string): string | null {
    const live = this.#live.get(sessionId);
    const store = this.config.reviewStore;
    if (!live || !store) return null;
    return dirname(store.fileFor(live.cwd, sessionId));
  }

  /** Sürüp giden incelemeyi durdurur (oturum kapanışı). */
  #abortReview(sessionId: string): void {
    const controller = this.#reviews.get(sessionId);
    if (!controller) return;
    controller.abort();
    this.#reviews.delete(sessionId);
  }

  /** İncelenecek dosyalar: son kullanıcı turlarında `edit`/`write` ile değişenler. */
  #reviewFiles(sessionId: string, cwd: string): string[] {
    const live = this.#live.get(sessionId);
    if (!live) return [];
    const messages = live.session.messages;
    // En yeni turdan geriye: dosya sınırı dolduğunda son değişiklikler önce alınmış olur.
    const starts: number[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== "user") continue;
      starts.push(i);
      if (starts.length >= REVIEW_MAX_TURNS) break;
    }
    const out = new Set<string>();
    for (let i = 0; i < starts.length; i += 1) {
      const from = (starts[i] ?? 0) + 1;
      const to = i === 0 ? messages.length : (starts[i - 1] ?? messages.length);
      for (const path of turnTouchedPaths(messages.slice(from, to), cwd)) {
        out.add(path);
        if (out.size >= REVIEW_MAX_FILES) return [...out];
      }
    }
    return [...out];
  }

  /**
   * Denetçi + doğrulayıcı turlarını koşturur; bulguları kaydeder ve `review` olayıyla yayınlar.
   * Doğrulama yalnızca `bug` sınıfına uygulanır (risk/nit doğrulama turu yakmaz); sağlayıcı ya
   * da süre hatası incelemeyi düşürür ama sonuç yine "boş" olarak yayınlanır.
   */
  async #runReview(
    sessionId: string,
    cwd: string,
    files: string[],
    signal: AbortSignal,
    turn: number,
  ): Promise<void> {
    const store = this.config.reviewStore;
    if (!store) return;
    const at = Date.now();
    let usage = emptyUsage();
    let error: string | undefined;
    const findings: ReviewFinding[] = [];
    try {
      const reviewer = await this.#readOnlySubSession({
        cwd,
        parentId: sessionId,
        system: this.#i18n.t("prompt.reviewerSystem"),
        // Dosya adları depodan gelir; satır sonu içeren bir ad görev bloğuna talimat olarak
        // girebilir. Her ad JSON dizesi olarak yazılır (tek satır, tırnaklı).
        task: this.#i18n.t("prompt.reviewerTask", {
          files: files.map((f) => JSON.stringify(f)).join("\n"),
        }),
        thinking: "low",
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal,
        run: { kind: "review", label: this.#i18n.t("agents.review") },
      });
      usage = addUsage(usage, reviewer.usage);
      const parsed = parseReviewerOutput(reviewer.text);
      const candidates = parsed.ok ? parsed.value.findings : [];
      for (const candidate of candidates) {
        if (signal.aborted) break;
        if (candidate.class !== "bug") {
          // Maliyet sınırı: risk/nit doğrulama turu yakmaz, doğrulanmamış olarak kayda geçer.
          findings.push(
            this.#reviewFinding(
              candidate,
              { verdict: "inconclusive", reason: this.#i18n.t("prompt.reviewUnverified") },
              at,
            ),
          );
          continue;
        }
        const verifier = await this.#readOnlySubSession({
          cwd,
          parentId: sessionId,
          system: this.#i18n.t("prompt.reviewVerifierSystem"),
          task: this.#i18n.t("prompt.reviewVerifierTask", {
            finding: JSON.stringify(candidate),
          }),
          thinking: "high",
          timeoutMs: REVIEW_VERIFY_TIMEOUT_MS,
          signal,
          run: { kind: "review-verifier", label: this.#i18n.t("agents.reviewVerifier") },
        });
        usage = addUsage(usage, verifier.usage);
        const verdict = parseValidatorVerdict(verifier.text);
        findings.push(
          this.#reviewFinding(
            candidate,
            verdict.ok
              ? verdict.value
              : { verdict: "inconclusive", reason: this.#i18n.t("prompt.reviewUnverified") },
            at,
          ),
        );
      }
    } catch {
      // Sağlayıcı/süre hatası: elde kalan bulgular yine raporlanır; "bulgu yok"dan ayrılsın diye
      // sonuca hata notu düşer (boş liste tek başına "temiz" demek değildir).
      error = this.#i18n.t("prompt.reviewFailed");
    }
    // Oturum kapanışında iptal edilen koşu ne kayda ne arayüze düşer: boş "temiz" sonuç yazmasın.
    if (signal.aborted) return;
    const counts = this.#reviewCounts(findings);
    try {
      store.record(cwd, sessionId, { at, files, counts, findings });
    } catch {
      // Kayıt yazılamazsa bulgular yine arayüze gider; ölçüm verisi kaybolur, inceleme değil.
    }
    this.bus.emit({
      type: "review",
      sessionId,
      at: Date.now(),
      phase: "done",
      turn,
      files,
      counts,
      findings,
      ...(error ? { error } : {}),
      usage,
    });
  }

  /** Adayı kayıt şemasına çevirir; kimlik içerikten türetilir, aynı bulgu aynı kimliği alır. */
  #reviewFinding(
    candidate: ReviewerFinding,
    verdict: { verdict: ReviewVerdict; reason: string },
    at: number,
  ): ReviewFinding {
    return {
      id: reviewId(candidate),
      at,
      class: candidate.class,
      title: candidate.title,
      description: candidate.description,
      file: candidate.file,
      ...(candidate.line === undefined ? {} : { line: candidate.line }),
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
      evidence: candidate.evidence,
      outcome: "pending",
    };
  }

  #reviewCounts(findings: ReviewFinding[]): ReviewCounts {
    const counts: ReviewCounts = { confirmed: 0, rejected: 0, inconclusive: 0 };
    for (const finding of findings) counts[finding.verdict] += 1;
    return counts;
  }

  /** `agent`: bellekteki alt ajanın adı; ana oturumun kapısında sorulan kartta etiket olur. */
  #permissionExtension(sessionId: string, agent?: string) {
    return (pi: ExtensionAPI) => {
      pi.on("tool_call", async (event, ctx) => {
        const live = this.#live.get(sessionId);
        const mode = live?.permission ?? "ask";
        // Göreli yol, aracın kendisinin çözdüğü klasöre göre değerlendirilir (alt ajanın cwd'si
        // ana oturumunkinden farklı olabilir).
        const result = await this.permissions.gate(
          sessionId,
          mode,
          event.toolName,
          event.input as Record<string, unknown>,
          agent,
          ctx.cwd || live?.cwd,
        );
        // Koşunun bekleyen son onayı yanıtlandı: satır "seni bekliyor"dan çıkar. Paralel araç
        // çağrılarında biri yanıtlanınca diğerleri hâlâ bekler.
        if (this.permissions.pendingFor(sessionId).length === 0) {
          this.runs.markWaiting(sessionId, false);
        }
        if (result.allowed) {
          this.bus.emit({ type: "status", sessionId, at: Date.now(), status: "working" });
          return undefined;
        }
        if (result.planBlocked) this.#markBlocked(sessionId, event.toolCallId);
        return { block: true, reason: result.reason ?? this.#i18n.t("permission.blocked") };
      });
    };
  }

  #markBlocked(
    sessionId: string,
    toolCallId: string,
    reason: "blocked" | "denied" = "blocked",
  ): void {
    let calls = this.#blockedTools.get(sessionId);
    if (!calls) {
      calls = new Map();
      this.#blockedTools.set(sessionId, calls);
    }
    calls.set(toolCallId, reason);
  }

  /** İşareti bir kez tüketir; kayıt boşalınca oturum kaydı da silinir. */
  #takeBlocked(sessionId: string, toolCallId: string): "blocked" | "denied" | undefined {
    const calls = this.#blockedTools.get(sessionId);
    const reason = calls?.get(toolCallId);
    if (!calls || !reason) return undefined;
    calls.delete(toolCallId);
    if (calls.size === 0) this.#blockedTools.delete(sessionId);
    return reason;
  }

  async #attach(
    session: AgentSession,
    cwd: string,
    permission: PermissionMode,
    settingsManager: SettingsManager,
    resources: { resourceLoader: DefaultResourceLoader },
  ): Promise<void> {
    const id = session.sessionId;
    // Kuyrukta bekleyen mesaj varsa (dürtme, yönlendirme) Pi turu kendiliğinden sürdürür; dizi o
    // yüzden kapanmaz ve arayüz boşta görünmez.
    const mapper = new EventMapper(id, this.#lang, () => session.pendingMessageCount > 0);
    const unsubscribe = session.subscribe((ev) => {
      // Sıra önemli: anahtar kararı hata olayından önce verilir.
      if (ev.type === "message_end" && ev.message.role === "assistant")
        this.#trackLimit(id, ev.message);
      // Anahtar dönüyorsa tur kendiliğinden sürecek. Kota hatası kullanıcıya kırmızı bant olarak
      // düşmez; geçilecek anahtar yoksa `resume` zaten false kalır ve hata görünür. Yutulan hata
      // saklanır: sürdürme vazgeçerse (#resumeAfterRotation) yayınlanır.
      const rotating = this.#rotations.get(id)?.resume === true || this.#transientPending.has(id);
      for (const mapped of mapper.map(ev)) {
        if (rotating && mapped.type === "error") {
          this.#heldError.set(id, mapped);
          continue;
        }
        // Çağrı izin katmanınca engellendiyse "hata" değil "engellendi", hook reddettiyse
        // "reddedildi" olarak yayınlanır.
        const stopped =
          mapped.type === "tool_end" ? this.#takeBlocked(id, mapped.toolCallId) : undefined;
        if (mapped.type === "tool_end" && stopped) {
          this.bus.emit({ ...mapped, [stopped]: true });
          this.#recordStop(session, mapped.toolCallId, stopped);
          continue;
        }
        // Durdur'un kestiği çağrı oturum dosyasına yazılır: yeniden açılışta da "durduruldu".
        if (mapped.type === "tool_end" && mapped.stopped)
          this.#recordStop(session, mapped.toolCallId, "stopped");
        this.bus.emit(mapped);
        // Ayrık koşu oturumuysa son eylem Ajanlar kutusundaki satıra taşınır. İzin beklemesi ayrı
        // yoldan bildirilir: izin isteği Pi olayı değil, motorun kendi kapısından çıkar.
        if (mapped.type === "tool_start") this.runs.noteActivity(id, mapped.title);
      }
      if (ev.type === "agent_end" && !ev.willRetry) void this.#resumeAfterError(id);
      /*
       * Bağlam doluluğu ("bağlam %N") tur içinde de canlanır: Pi doluluğu son yanıtın
       * kullanımı + sonrasına eklenen mesajların tahmininden hesaplar, yani her model
       * yanıtı ve her araç sonucu sayıyı değiştirir. Yalnız tur sonunda yayınlamak
       * halkayı uzun turlar boyunca donuk bırakıyordu.
       *
       * `compaction_end` listede yok: Pi sıkıştırmadan sonraki ilk model yanıtına kadar
       * doluluğu `null` döndürür (agent-session `getContextUsage`), yayın hiç oluşmazdı.
       * Bunun yerine tekrar süzgeci sıfırlanır ki sıkıştırma sonrası ilk gerçek değer,
       * sayı tesadüfen aynı çıksa bile halkaya ulaşsın.
       */
      if (ev.type === "compaction_end") this.#lastContext.delete(id);
      if (ev.type === "message_end" || ev.type === "tool_execution_end" || ev.type === "agent_end")
        this.#emitContext(id, session);
    });
    const ui = new ExtensionUiBridge(id, {
      onRequest: (request) => {
        this.bus.emit({ sessionId: id, at: Date.now(), type: "extension_ui_request", request });
      },
      onNotify: (message, level) => {
        this.bus.emit({ sessionId: id, at: Date.now(), type: "extension_notify", message, level });
      },
      onUnsupported: (method) => {
        // Hangi eklentinin çağırdığı köprüde bilinmez (Pi `ctx.ui`'yi eklenti başına ayırmıyor).
        this.bus.emit({
          sessionId: id,
          at: Date.now(),
          type: "extension_error",
          plugin: null,
          message: this.#i18n.t("errors.extensionUiUnsupported", { method }),
        });
      },
      onWidget: (_key, lines) => {
        // Masaüstünde TUI widget yüzeyi yok ve kullanıcı eklentisi yüklenmiyor: motor-içi
        // fabrikalar widget göndermez. Yine de gelirse oturum başına bir kez bildirilir.
        if (!lines || lines.length === 0 || this.#widgetWarned.has(id)) return;
        this.#widgetWarned.add(id);
        this.bus.emit({
          sessionId: id,
          at: Date.now(),
          type: "extension_error",
          plugin: null,
          message: this.#i18n.t("errors.extensionUiUnsupported", { method: "setWidget" }),
        });
      },
      onCancelled: (requestIds) => {
        this.bus.emit({
          sessionId: id,
          at: Date.now(),
          type: "extension_ui_cancelled",
          requestIds,
        });
      },
    });
    this.#live.set(id, {
      session,
      cwd,
      permission,
      planReturnTo: undefined,
      unsubscribe,
      settingsManager,
      resourceLoader: resources.resourceLoader,
      ui,
      mapper,
    });
    if (session.sessionFile) this.#paths.set(id, session.sessionFile);
    // Dosyadaki biten alt ajan koşuları izleyiciye yüklenir (diskten açılış, dallanma): sonra
    // başlayan koşunun yayını listeyi baştan yazdığında eskiler kaybolmasın. Geri sarılmış dal
    // okunmaz; yeni oturumda kayıt yoktur, izleyici kurulmaz.
    const records = subagentRecordsOf(session.sessionManager.getBranch());
    if (records.length > 0) this.#tracerFor(id).restore(records);
    // Eklenti `ctx.ui` istekleri karta/toast'a düşsün. Bağlama hatası oturumu açmaktan
    // vazgeçirmesin: bozuk bir eklenti yüzünden sohbet hiç açılmaz kalırdı.
    try {
      await session.bindExtensions({
        uiContext: ui.create(),
        mode: "rpc",
        onError: (error) => {
          this.bus.emit({
            sessionId: id,
            at: Date.now(),
            type: "extension_error",
            plugin: basename(error.extensionPath),
            message: error.error,
          });
        },
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          // Oturum değiştirme komutları masaüstünde engine dışından yönetilir: eklenti
          // komutları çağırırsa iptal döner, yanlış oturuma geçilmez.
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: () => session.reload(),
        },
      });
    } catch (error) {
      this.#emitError(id, error);
    }
  }

  /**
   * Pi'nin yeniden deneme bütçesi. Sunucunun istediği uzun beklemeyi yalnızca o sağlayıcının
   * birden fazla anahtarı varsa kısa keser (beklemek yerine sıradaki anahtara geçmek için);
   * tek anahtarlı sağlayıcıda Pi'nin varsayılanı korunur, yoksa beklenerek düzelen bir sınır
   * hataya dönüşürdü.
   */
  #applyRetrySettings(settingsManager: SettingsManager, providerId: string | undefined): void {
    const slots = providerId ? this.keys.slotCount(providerId) : 0;
    settingsManager.applyOverrides({
      retry: {
        maxRetries: Math.max(3, slots + 2),
        baseDelayMs: slots > 1 ? 1000 : 2000,
        provider: { maxRetryDelayMs: slots > 1 ? 5000 : 60000 },
      },
    });
  }

  /**
   * Limit hatasında aktif anahtarı soğutur (rotasyon); başarılı yanıtta soğumayı temizler.
   * Pi'nin yeniden deneme desenine değil hata metnine bakılır: Opencode Go gibi "yeniden denenmez"
   * sayılan kota hataları da rotasyon gerektirir. Turu sürdürme hakkı (`resume`) yalnızca gerçekten
   * başka bir anahtara geçildiyse doğar; aksi hâlde sürdürme sonsuz döngüye girerdi.
   */
  #trackLimit(sessionId: string, message: AssistantMessage): void {
    const state = this.#rotations.get(sessionId);
    if (message.stopReason === "aborted") {
      if (state) state.resume = false;
      this.#transientPending.delete(sessionId);
      // Kullanıcı durdurdu: gizlenen limit hatası bant olarak gösterilmez.
      this.#heldError.delete(sessionId);
      return;
    }
    if (message.stopReason === "error") {
      if (!isLimitError(message.errorMessage)) {
        // Limitle ilgisi olmayan hata: sürdürme hakkı da bütçe de sıfırlanır. Yeni hata zaten
        // yayınlandığı için gizlenen eski limit hatası düşer, iki bant görünmesin.
        this.#rotations.delete(sessionId);
        this.#heldError.delete(sessionId);
        // Geçici sağlayıcı kesmesi: bütçe varsa tur sürdürülür, hata bandı o zamana dek tutulur.
        if (
          isTransientProviderError(message.errorMessage) &&
          (this.#transient.get(sessionId) ?? 0) < MAX_TRANSIENT_RETRIES
        )
          this.#transientPending.add(sessionId);
        return;
      }
      // Sunucu süre bildirdiyse o kullanılır. Bildirmediyse kota tükenmesi uzun soğuma ister,
      // düz hız sınırı ise kısa: aksi halde tek anahtar geçici bir 429 yüzünden saatlerce dolu görünür.
      const cooldownMs =
        parseRetryDelayMs(message.errorMessage) ??
        (isQuotaExhausted(message.errorMessage)
          ? (this.config.keyCooldownMs?.() ?? DEFAULT_KEY_COOLDOWN_MS)
          : SHORT_LIMIT_COOLDOWN_MS);
      const result = this.keys.markLimited(message.provider, cooldownMs);
      if (!result) {
        if (state) state.resume = false;
        return;
      }
      this.config.credentialRotated?.({ sessionId, provider: message.provider, ...result });
      if (!result.to || result.to.id === result.from.id) {
        // Geçilecek uygun anahtar yok: tur sürdürülmez, hata kullanıcıya kalır.
        if (state) state.resume = false;
        return;
      }
      const next = state ?? { count: 0, resume: false };
      next.count += 1;
      next.resume = true;
      this.#rotations.set(sessionId, next);
      return;
    }
    this.keys.markHealthy(message.provider);
    this.#rotations.delete(sessionId);
    this.#transient.delete(sessionId);
    this.#transientPending.delete(sessionId);
    // Yanıt geldi: Pi kendi yeniden denemesiyle toparlamış olabilir, gizlenen hata artık geçersiz.
    this.#heldError.delete(sessionId);
  }

  /**
   * Hatayla biten turu sürdürür. İki giriş var: (a) limit hatasında anahtar geçişi (`resume`
   * hakkı, `#trackLimit`); (b) Pi'nin yeniden denenebilir saymadığı geçici sağlayıcı kesmesi
   * (Kimi K3'ün `finish_reason: error`'ı; `isTransientProviderError`), tur başına
   * MAX_TRANSIENT_RETRIES kez, artan beklemeyle. Her iki yolda da Pi'nin retry yolundaki gibi son hata
   * mesajı ajan durumundan düşer ve tur kaldığı yerden devam eder; kullanıcı "devam" yazmaz.
   *
   * `agent.continue()` Pi'nin `_runAgentPrompt` döngüsünün dışında çalıştığı için o döngünün
   * sürdürdüğümüz tura düşen iki işi (bağlam taşmasında sıkıştırma, geçici hatada yeniden deneme)
   * burada Pi'nin kendi sınıflandırıcılarıyla tekrarlanır.
   */
  async #resumeAfterError(sessionId: string): Promise<void> {
    // Sürdürme sürerken gelen agent_end olayları araya girmesin; bayrağı döngü kendisi tüketir.
    if (this.#resuming.has(sessionId)) return;
    const state = this.#rotations.get(sessionId);
    const rotation = state?.resume === true;
    const transient = this.#transientPending.delete(sessionId);
    if (!rotation && !transient) {
      this.#flushHeldError(sessionId);
      return;
    }
    if (state) state.resume = false;
    const live = this.#live.get(sessionId);
    const provider = live?.session.model?.provider;
    if (!live || !provider || (rotation && state && state.count > this.keys.slotCount(provider))) {
      // Sürdürülemiyor: gizlenen hata kullanıcıya gösterilir.
      this.#flushHeldError(sessionId);
      return;
    }

    const { session } = live;
    const retry = live.settingsManager.getRetrySettings();
    this.#resuming.add(sessionId);
    const stop = new AbortController();
    this.#resumeAborts.set(sessionId, stop);
    try {
      let step = 0;
      let backoff = 0;
      let compactions = 0;
      for (;;) {
        await session.waitForIdle();
        // Oturum kapandıysa, kullanıcı durdurduysa ya da yeni bir tur başlattıysa karışma.
        if (stop.signal.aborted || this.#live.get(sessionId) !== live || session.isStreaming)
          return;
        const messages = session.agent.state.messages;
        const last = messages[messages.length - 1];
        if (last?.role !== "assistant" || last.stopReason !== "error") return;
        const overflow = isContextOverflow(last, session.model?.contextWindow ?? 0);

        // İlk adım rotasyon hakkıyla geldiyse beklemesiz sürer; diğer her adım bir gerekçe ister:
        // yeni bir anahtar geçişi, bir kerelik sıkıştırma, geçici kesme bütçesi ya da Pi'nin
        // geçici hata bütçesi. Hiçbiri yoksa hata kullanıcıya kalır.
        if (step > 0 || !rotation) {
          const used = this.#transient.get(sessionId) ?? 0;
          if (state?.resume) {
            state.resume = false;
            if (state.count > this.keys.slotCount(provider)) return;
          } else if (overflow) {
            if (compactions > 0) return;
          } else if (isTransientProviderError(last.errorMessage) && used < MAX_TRANSIENT_RETRIES) {
            const attempt = used + 1;
            this.#transient.set(sessionId, attempt);
            const delayMs = TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1);
            // Arayüz "bekliyor"a geçer, hata bandı kalkar; deneme tükenirse bant finally'de döner.
            this.bus.emit({
              type: "retry",
              sessionId,
              at: Date.now(),
              attempt,
              maxAttempts: MAX_TRANSIENT_RETRIES,
              delayMs,
              message: maskSecrets(last.errorMessage ?? ""),
            });
            await delay(delayMs, stop.signal);
          } else if (
            retry.enabled &&
            backoff < retry.maxRetries &&
            isRetryableAssistantError(last)
          ) {
            backoff += 1;
            await delay(retry.baseDelayMs * 2 ** (backoff - 1), stop.signal);
          } else return;
          // Bekleme sırasında Durdur'a basıldı: tur sürdürülmez.
          if (stop.signal.aborted) return;
        }
        step += 1;

        if (overflow) {
          compactions += 1;
          await session.compact();
          if (stop.signal.aborted) return;
        }
        // Hata mesajı bağlamdan düşer, oturum dosyasında geçmiş olarak kalır. Pi 0.87'den beri
        // bağlam `SessionManager`dan gelir: ajan durumuna atama sağlayıcıya gideni değiştirmiyordu;
        // bağlam düzeltmesi (Pi'nin kendi yeniden denemesi de böyle yapar) gerekir.
        const leaf = session.sessionManager.getLeafEntry();
        if (
          leaf?.type === "message" &&
          leaf.message.role === "assistant" &&
          leaf.message.stopReason === "error"
        ) {
          session.sessionManager.appendContextEdit(leaf.id, null);
          session.refreshContext();
        }
        // Tur gerçekten sürüyor: gizlenen hata artık gösterilmez.
        this.#heldError.delete(sessionId);
        await session.agent.continue();
      }
    } catch (error) {
      this.#heldError.delete(sessionId);
      if (!stop.signal.aborted) this.#emitError(sessionId, error);
    } finally {
      this.#resuming.delete(sessionId);
      if (this.#resumeAborts.get(sessionId) === stop) this.#resumeAborts.delete(sessionId);
      // Döngü sürdüremeden çıktıysa (bütçe bitti, oturum değişti) hata burada yüzeye çıkar.
      this.#flushHeldError(sessionId);
    }
  }

  /**
   * `thinking` verilirse Pi'ye geçirilir. Yeniden açılan oturumda seviye Codezal meta'sından gelir:
   * Pi seviyeyi oturum dosyasında tutmaz (`SessionManager.open().thinkingLevel` boş döner), bu
   * yüzden verilmezse Pi varsayılanına düşer ve kullanıcının seçimi her açılışta kaybolur.
   */
  async #open(cwd: string, sessionManager: SessionManager, options: OpenOptions) {
    const runtime = await this.runtime();
    // Paket listesi boş görünür: Pi eksik paketi sormadan kurar. Yükleyici de oturum da aynı
    // görünümü alır; ayar yazmaları gerçek yöneticiye gider.
    const settingsManager = withoutPackages(
      SettingsManager.create(cwd, this.config.agentDir, {
        projectTrusted: this.config.projectTrusted?.(cwd) ?? true,
      }),
    );
    const globalInstructions = this.config.globalInstructions?.();
    const extras =
      this.config.sessionExtrasFor?.({
        mode: options.mode,
        projectId: options.projectId ?? null,
        cwd,
      }) ?? {};
    // İkisi de varsa birleşir: create çağrısının ek istemi + mode ekleri (Asistan talimatları,
    // çıktı kuralı). Öncelik ezmesi yok.
    const extraSystem = mergeExtraSystem(options.extraSystem, extras.extraSystem);
    const outputsDir = options.outputsDir ?? extras.outputsDir;
    // Bellek kapsamları: genel her oturumda; Kodlama'da çalışma klasörü, Asistan'da proje.
    const memoryScopes: MemoryScope[] = [{ kind: "genel" }];
    if (options.mode === "asistan") {
      if (options.projectId) memoryScopes.push({ kind: "asistan", projectId: options.projectId });
    } else memoryScopes.push({ kind: "proje", cwd });
    const appendSystemPrompt = [
      this.#modeSystem(options.mode),
      this.#i18n.t("prompt.languageMatch"),
      this.#i18n.t("prompt.reportOutcomes"),
      this.#i18n.t("prompt.workHabits"),
      this.#i18n.t("prompt.untrustedContent"),
      // PDF `read` ile okunur (bkz. read-tool.ts); söylenmezse model PDF'i okunamaz sanıp
      // terminalde pdftoppm/pymupdf ile görüntüye çevirmeye çalışıyor.
      this.#i18n.t("prompt.pdfRead"),
      // Arama hız sınırı: söylenmezse model sorguyu değiştirip yeniden arıyor ya da terminalde
      // `sleep` ile bekliyor; ikisi de sınırı besliyor.
      this.#i18n.t("prompt.searchRateLimit"),
      globalInstructions ?? "",
      extraSystem ?? "",
      this.memory.systemPrompt(memoryScopes),
    ].filter((s) => s.trim().length > 0);
    // Geçici kimlik: extension oturum kimliğini oturum oluşturulduktan sonra alır.
    const sessionIdBox = { id: sessionManager.getSessionId() };

    // Kullanıcı eklentisi yüzeyi kaldırıldı: ek eklenti yolu verilmez (`noExtensions` zaten açık).
    // Motor-içi fabrikalar (`codezal-*`) aşağıdaki `extensionFactories` ile yüklenir.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.config.agentDir,
      settingsManager,
      noExtensions: true,
      // Prompt şablonu yüzeyi kaldırıldı; `.pi/prompts` ve ayardaki şablon yolları okunmaz.
      noPromptTemplates: true,
      noThemes: true,
      // Kullanıcı eklentisi yok: Pi'nin otomatik keşfi (`.pi/extensions`, paketler) devreye girmez.
      additionalExtensionPaths: [],
      extensionFactories: [
        // Kimlik ve ortam ilk sırada: sonraki uzantılar işlenmiş istemi görür.
        { name: "codezal-prompt", factory: this.#promptExtension(cwd), hidden: true },
        // Hook'lar izin kapısından önce: Claude Code'daki gibi PreToolUse onay sorulmadan çalışır,
        // engellediği çağrı için kullanıcıya boşuna sorulmaz. Yedek (codezal-turn) en sonda kalır.
        ...(this.config.hooks
          ? [
              {
                name: "codezal-hooks",
                factory: this.#hooksExtension(sessionIdBox.id, cwd),
                hidden: true,
              },
            ]
          : []),
        {
          name: "codezal-permissions",
          factory: this.#permissionExtension(sessionIdBox.id),
          hidden: true,
        },
        { name: "codezal-plan", factory: this.#planExtension(sessionIdBox.id, cwd), hidden: true },
        // Alt ajan dağıtımı fabrikadan kaydedilir: `session.reload()` fabrikaları yeniden çalıştırır,
        // böylece Ajanlar sayfasındaki değişiklik açık oturumun araç tanımına da yansır (özel araç
        // listesi yalnızca oturum açılışında kurulur ve tazelemede yeniden üretilmez).
        {
          name: "codezal-agents",
          factory: this.#agentsExtension(cwd, sessionIdBox.id),
          hidden: true,
        },
        { name: "codezal-images", factory: this.#imageBudgetExtension(), hidden: true },
        // Danışman fabrikadan kaydedilir: ayar değişince `reloadLiveSessions` aracı ekler ya da düşürür.
        {
          name: "codezal-advisor",
          factory: this.#advisorExtension(sessionIdBox.id),
          hidden: true,
        },
        // Bağlı MCP araçları; izin uzantısından sonra gelir ki tool_call kapısı bunlara da uygulansın.
        // Oturum kimliği verilir: kapanışta abonelik bırakılabilsin (`dispose` session_shutdown yaymaz).
        { name: "codezal-mcp", factory: this.mcp.extension(sessionIdBox.id), hidden: true },
        ...(outputsDir
          ? [
              {
                name: "codezal-outputs",
                factory: this.#outputsExtension(cwd, outputsDir),
                hidden: true,
              },
            ]
          : []),
        // En sonda: yedek yalnızca izin ve çıktı kapısını geçen çağrılar için alınır.
        {
          name: "codezal-turn",
          factory: this.#turnExtension(sessionIdBox.id, cwd, options.mode, outputsDir),
          hidden: true,
        },
        // Goal döngüsü turn'den sonra: kontrol dürtmeleri goal devamından önce kuyruğa girer.
        { name: "codezal-goal", factory: this.#goalExtension(sessionIdBox.id), hidden: true },
      ],
      agentsFilesOverride: (base) => ({
        agentsFiles: [...base.agentsFiles, ...this.#contextFiles(cwd)],
      }),
      ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
    });
    await resourceLoader.reload();

    const model = options.model
      ? runtime.getModel(options.model.provider, options.model.id)
      : undefined;
    this.#applyRetrySettings(settingsManager, model?.provider);
    // PDF ve Word üretimi her modda: Asistan raporu çıktı klasörüne, Kodlama belgeyi çalışma
    // klasörüne yazar. Word Electron gerektirmez; PDF main sürecin çeviricisine bağlıdır.
    const pdfTools = this.config.renderPdf
      ? [
          pdfCreateTool(this.config.renderPdf, {
            lang: this.#lang,
            cwd,
            ...(outputsDir ? { outputsDir } : {}),
          }),
        ]
      : [];
    // Plan moduna giriş/çıkış: model kendi kararıyla plana geçer, onay kartıyla çıkar (plansDir şart).
    const planBridge: PlanBridge = {
      mode: () => this.#live.get(sessionIdBox.id)?.permission ?? options.permission,
      planPath: () => this.planPath(sessionIdBox.id, cwd),
      enter: () => this.#enterPlan(sessionIdBox.id, cwd),
      review: (plan, path) => this.#reviewPlan(sessionIdBox.id, plan, path),
    };
    const planToolset = this.config.plansDir ? planTools(planBridge, this.#lang) : [];
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.config.agentDir,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
      // `tools` Pi'de izin listesi gibi çalışır ve uzantı araçlarını (mcp_*) eler; bu yüzden
      // yalnızca istenmeyen yerleşik dışlanır, aktif küme aşağıda kurulur.
      ...(options.mode === "asistan" ? { excludeTools: ["edit"] } : {}),
      // Özel araçlar her modda kayıtlıdır; hangisinin etkin olacağını `#activateTools` seçer.
      customTools: [
        // Aynı adlı sarmalayıcı yerleşik `read`in yerine geçer: PDF ve `render` desteği.
        readTool(cwd, this.#lang),
        // Aynı adlı sarmalayıcı yerleşik `bash`in yerine geçer: eşiği aşan komut arka plana alınır.
        bashTool(
          cwd,
          {
            unattended: () => this.permissions.isUnattended(sessionIdBox.id),
            // Ön plan penceresindeki görev baştan duyurulmaz: arka plana alınırsa aşağıdaki
            // `detach` yayınlar, pencere içinde biterse hiç görünmez.
            start: (command, opts) =>
              this.#background.start(sessionIdBox.id, opts.cwd, command, {
                backgrounded: false,
                ...(opts.env ? { env: opts.env } : {}),
                ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
                onData: opts.onData,
              }),
            detach: (id) => {
              const task = this.#background.get(id);
              if (task?.sessionId !== sessionIdBox.id) return undefined;
              const backgrounded = this.#background.markBackgrounded(id);
              // Alındığı anda duyurulur: Ajanlar kutusu ve başlık çipi bundan beslenir.
              if (backgrounded) {
                this.bus.emit({
                  sessionId: backgrounded.sessionId,
                  at: Date.now(),
                  type: "background_start",
                  jobId: backgrounded.id,
                  command: backgrounded.command,
                });
              }
              return backgrounded;
            },
            timeout: (id) => {
              const task = this.#background.get(id);
              if (task?.sessionId === sessionIdBox.id) this.#background.timeout(id);
            },
            stop: (id) => {
              const task = this.#background.get(id);
              if (task?.sessionId === sessionIdBox.id) this.#background.stop(id);
            },
            wait: (id) => this.#background.waitFor(id),
          },
          this.#lang,
          {
            sandbox: {
              decide: (runCwd) => this.#sandbox(runCwd, outputsDir),
              onSandboxed: (toolCallId) => this.#sandboxedCalls.add(toolCallId),
            },
          },
        ),
        // Gözetimsiz görevde arama sonuçları ve sayfa ana ajana verilmez, ayrı modelle özetlenir.
        webSearchTool(this.#lang, {
          quarantine: () => this.permissions.isUnattended(sessionIdBox.id),
          summaryModel: () => this.config.webSummaryModel?.() ?? null,
          ...this.#webSearchOptions(),
        }),
        webFetchTool(
          this.#lang,
          {},
          {
            quarantine: () => this.permissions.isUnattended(sessionIdBox.id),
            summaryModel: () => this.config.webSummaryModel?.() ?? null,
          },
        ),
        taskListTool(this.#lang),
        ...agentRunTools(this.#runBridge(sessionIdBox.id), this.#lang),
        ...(this.#auditStore ? auditTools(this.#auditRunner(sessionIdBox.id), this.#lang) : []),
        ...(options.mode === "asistan" && this.config.schedule
          ? [scheduleTool(this.config.schedule, this.#lang, options.projectId ?? null)]
          : []),
        backgroundTool(
          {
            // Zamanlanmış (gözetimsiz) oturumda başlatılmaz: tur bitince dürtme yeni bir tur
            // açardı ve sonucu kimse görmezdi.
            start: (command, description) => {
              if (this.permissions.isUnattended(sessionIdBox.id)) return undefined;
              // Arka plan görevi de korumalı alana girer; yoksa `bash` kapısı bununla aşılırdı.
              const sandbox = this.#sandbox(cwd, outputsDir);
              const task = this.#background.start(sessionIdBox.id, cwd, command, {
                ...(description ? { description } : {}),
                ...(sandbox.kind === "on" ? { sandbox: sandbox.profile } : {}),
              });
              // Başlangıcı canlı yayınla: Ajanlar kutusu tur beklemeden satır açar.
              this.bus.emit({
                sessionId: task.sessionId,
                at: Date.now(),
                type: "background_start",
                jobId: task.id,
                command: task.command,
                ...(task.description ? { description: task.description } : {}),
              });
              return task;
            },
            // Görev kimlikleri sıralı ve tahmin edilebilir (`bg-1`, `bg-2`…); okuma ve durdurma
            // oturum sahipliğine bağlanır. Aksi hâlde bir oturumun modeli başka oturumun
            // görev çıktısını (sır taşıyabilir) okuyabiliyor ya da sürecini öldürebiliyordu.
            get: (id) => {
              const task = this.#background.get(id);
              return task?.sessionId === sessionIdBox.id ? task : undefined;
            },
            list: () => this.#background.listBackgrounded(sessionIdBox.id),
            stop: (id) => {
              const task = this.#background.get(id);
              if (task?.sessionId !== sessionIdBox.id) return false;
              return this.#background.stop(id);
            },
          },
          this.#lang,
        ),
        ...pdfTools,
        // PDF düzenleme Chromium'a bağlı değil (pdf-lib); çevirici olmasa da her modda kayıtlı.
        pdfEditTool({
          lang: this.#lang,
          cwd,
          ...(this.config.pdfFont ? { fontPath: this.config.pdfFont } : {}),
        }),
        docxCreateTool({ lang: this.#lang, cwd, ...(outputsDir ? { outputsDir } : {}) }),
        docxEditTool({ lang: this.#lang, cwd }),
        xlsxCreateTool({ lang: this.#lang, cwd, ...(outputsDir ? { outputsDir } : {}) }),
        xlsxEditTool({ lang: this.#lang, cwd }),
        ...planToolset,
        // Soru aracı plansDir'e bağlı değil: her oturumda soru sorulabilmeli.
        questionTool(
          { ask: (questions) => this.#askQuestions(sessionIdBox.id, questions) },
          this.#lang,
        ),
      ],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    // Model oturum dosyasından geri yüklendiyse yeniden deneme ayarı o sağlayıcıya göre kurulur.
    if (!model) this.#applyRetrySettings(settingsManager, session.model?.provider);
    this.#activateTools(session, options.mode === "asistan" ? ASSISTANT_TOOLS : DEFAULT_TOOLS);
    // Yeniden açılan denetim oturumu araçlarını geri alır (meta'da run kaydı varsa).
    if (this.#meta.get(sessionIdBox.id).audit) {
      const live = this.#live.get(sessionIdBox.id);
      if (live) this.#activateTools(live.session, [...DEFAULT_TOOLS, ...AUDIT_TOOLS]);
    }
    await this.#attach(session, cwd, options.permission, settingsManager, {
      resourceLoader,
    });
    return session;
  }

  /** Oturumun o anki modeli, renderer çipi için. */
  #modelRefOf(session: AgentSession): ModelRef | undefined {
    const m = session.model;
    return m ? { provider: m.provider, id: m.id } : undefined;
  }

  /**
   * Pi'nin yedi kademeli düşünme seviyesi üç kademeli arayüz seviyesine indirilir. Arayüzün "max"ı
   * Pi'ye olduğu gibi (`max`) gider; geri okumada eşlenmezse "low" dönüyor, çip ve işaretler yanlış
   * seviyeyi gösteriyordu.
   */
  #thinkingOf(session: AgentSession): ThinkingLevel {
    switch (session.thinkingLevel) {
      case "max":
      case "xhigh":
        return "max";
      case "high":
      case "medium":
        return "high";
      default:
        return "low";
    }
  }

  /**
   * Moda göre temel araçlar + bağlayıcı araçları + `tool_search` + eklenti araçları etkinleştirilir.
   * Eklenti araçları Pi'nin doğal davranışında hep aktiftir; moda göre daraltma onları düşürmesin
   * diye burada açıkça eklenir (eklenti kendi `session_start`'ında geri eklemek zorunda kalmasın).
   */
  #activateTools(session: AgentSession, base: string[]): void {
    const extras = session
      .getAllTools()
      .filter(
        (t) =>
          t.name.startsWith(MCP_TOOL_PREFIX) ||
          t.name === TOOL_SEARCH_TOOL ||
          t.sourceInfo?.source === "extension",
      )
      .map((t) => t.name);
    session.setActiveToolsByName([...new Set([...base, ...extras])]);
  }

  /** Canlı oturumun aktif araç adları (test ve tanı için). */
  activeToolNames(id: string): string[] {
    return this.#live.get(id)?.session.getActiveToolNames() ?? [];
  }

  // ---------- ayrık ajan koşuları (arka plan / worktree) ----------

  /**
   * Oturumda yanıt bekleyen izinler: kendi (bellekteki alt ajanlarınki dahil) ve ayrık
   * koşularının ana oturumda sorduğu istekler, yayınlandıkları biçimde.
   */
  #pendingAsks(id: string): PermissionRequest[] {
    const own = this.permissions.pendingFor(id);
    const forwarded = this.runs.list(id).flatMap((run) =>
      run.sessionId && run.status === "waiting"
        ? this.permissions.pendingFor(run.sessionId).map((request) => ({
            ...request,
            sessionId: id,
            run: { id: run.id, title: run.title },
          }))
        : [],
    );
    return [...own, ...forwarded];
  }

  /** Ana oturumun ayrık koşuları (eskiden yeniye); Ajanlar kutusu ve `agent_list` bunu okur. */
  listAgentRuns(sessionId: string): WorkerInfo[] {
    return this.runs.list(sessionId);
  }

  stopAgentRun(sessionId: string, runId: string): boolean {
    return this.runs.stop(sessionId, runId);
  }

  steerAgentRun(sessionId: string, runId: string, message: string): boolean {
    return this.runs.steer(sessionId, runId, message);
  }

  reviewAgentRun(sessionId: string, runId: string, decision: WorkerReviewDecision): Promise<void> {
    return this.runs.review(sessionId, runId, decision);
  }

  /** İnceleme ekranı için koşunun worktree diff'i; worktree yoksa boş dize. */
  agentRunDiff(sessionId: string, runId: string): Promise<string> {
    return this.runs.diff(sessionId, runId);
  }

  /** Bekletilen (bellekteki) alt ajan koşusunu durdurur; ana tur kısmi sonuçla sürer. */
  stopSubagent(sessionId: string, runId: string): boolean {
    const stop = this.#subagentStops.get(sessionId)?.get(runId);
    if (!stop) return false;
    stop();
    return true;
  }

  /**
   * Oturumun arka plan görevleri (bitenler dahil, runner'ın sakladığı kadar): Arka plan
   * sekmesi biten komutun çıktısını da gösterebilsin. Ön plan penceresindeki komut listelenmez.
   */
  listBackground(sessionId: string): BackgroundJob[] {
    return this.#background.listBackgrounded(sessionId).map(toBackgroundJob);
  }

  /** Arka plan görevinin saklanan çıktı kuyruğu; başka oturumun görevi sorulamaz. */
  backgroundOutput(
    sessionId: string,
    jobId: string,
  ): { job: BackgroundJob; output: string; truncated: boolean } | null {
    const task = this.#background.get(jobId);
    if (!task || task.sessionId !== sessionId || !task.backgrounded) return null;
    return {
      job: toBackgroundJob(task),
      output: task.output,
      truncated: task.outputChars > task.output.length,
    };
  }

  /**
   * Kullanıcı arka plan görevini durdurur. Görev "stopped" kapanır; `#onBackgroundExit` bu
   * durumda modeli dürtmez, sonucu isteyen kullanıcının kendisidir.
   */
  stopBackground(sessionId: string, jobId: string): boolean {
    const task = this.#background.get(jobId);
    if (!task || task.sessionId !== sessionId) return false;
    return this.#background.stop(jobId);
  }

  #agentRunSettings(): { concurrency: number; worktreePermission: PermissionMode } {
    return this.config.agentRuns?.() ?? { concurrency: 3, worktreePermission: "auto-edit" };
  }

  /**
   * Ayrık koşuların motor karşılığı: koşu tam bir oturumdur; izin kapısı, transkript ve maliyet
   * sayacı bu yüzden kendiliğinden çalışır. Model, düşünme seviyesi, sistem istemi ve araç kümesi
   * ajan tanımından gelir; verilmeyen alanlar ana oturumdan devralınır.
   */
  #workerRuntime(): WorkerRuntime {
    return {
      open: async ({ cwd, title, profile, parentSessionId, permission }) => {
        const parentLive = this.#live.get(parentSessionId);
        const parent = parentLive?.session;
        // Ana klasörde (worktree'siz) çalışan koşunun yedeği ana oturumun koşuyu açtığı tura
        // yazılır. Tur açılışta sabitlenir: arka plan koşusu sonraki turlarda yazsa da onu başlatan
        // turun "Geri al"ı döndürür. Koşu sırada beklediyse açılış anındaki tur kullanılır.
        const parentRoute =
          parentLive && resolve(parentLive.cwd) === resolve(cwd)
            ? this.#ownRoute(parentSessionId)
            : undefined;
        const model =
          profile.model ??
          (parent?.model ? { provider: parent.model.provider, id: parent.model.id } : undefined);
        const summary = await this.createSession({
          cwd,
          mode: "kodlama",
          permission,
          name: title,
          thinking: profile.thinking ?? (parent ? this.#thinkingOf(parent) : "low"),
          ...(model ? { model } : {}),
          location: "local",
          projectId: null,
          extraSystem: [profile.systemPrompt, this.#i18n.t("prompt.languageMatch")]
            .filter((part) => part.trim().length > 0)
            .join("\n\n"),
          parentSessionId,
        });
        // Koşu yalnız ajanın araçlarını görür: iç içe ajan, plan ve koşu yönetimi araçları elenir.
        this.#live.get(summary.id)?.session.setActiveToolsByName(resolveAgentTools(profile));
        if (parentRoute) this.#checkpointRoutes.set(summary.id, parentRoute);
        return summary.id;
      },
      describe: (sessionId) => {
        const session = this.#live.get(sessionId)?.session;
        if (!session) return {};
        const model = this.#modelRefOf(session);
        return {
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
          thinking: this.#thinkingOf(session),
        };
      },
      run: (sessionId, prompt) => this.promptAndWait(sessionId, prompt),
      abort: (sessionId) => {
        // Oturum bu arada kapandıysa `#require` fırlatır; yakalanmayan red süreci uyarıyla doldurur.
        this.abort(sessionId).catch(() => undefined);
      },
      usage: (sessionId) => {
        const live = this.#live.get(sessionId);
        return live
          ? this.#usageOf(live.session)
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      },
      lastText: (sessionId) => this.#lastAssistantText(sessionId),
      close: (sessionId) => this.closeSession(sessionId),
    };
  }

  /** Koşu yönetim araçlarının köprüsü; koşular çağıran oturuma bağlıdır. */
  #runBridge(sessionId: string): AgentRunBridge {
    return {
      list: () => this.runs.list(sessionId),
      message: (runId, message) => this.runs.steer(sessionId, runId, message),
      stop: (runId) => this.runs.stop(sessionId, runId),
    };
  }

  /** Koşu istemi: yalıtımlı koşu kendi dalında çalıştığını ve birleştirmeyi bilir. */
  #runPrompt(task: string, isolated: boolean): string {
    return isolated ? `${this.#i18n.t("prompt.agentRunWorktree")}\n\n${task}` : task;
  }

  /**
   * Arka plan koşusu bitti: ana oturum gizli bir mesajla uyandırılır ve sonucu kullanıcıya
   * kendisi bildirir. Kullanıcının durdurduğu koşu haber gerektirmez; ana oturum kapandıysa
   * dürtecek kimse yoktur (sonuç Ajanlar kutusunda durur).
   */
  #onAgentRunEnded(run: WorkerSession, info: WorkerEndInfo): void {
    if (!run.background || info.status === "cancelled") return;
    const pi = this.#pi.get(run.parentSessionId);
    if (!pi || !this.#live.has(run.parentSessionId)) return;
    this.#nudge(pi, "background", this.#runSummary(run, info));
  }

  /** Koşu sonucunun modele dönen metni: özet + değişen dosyalar + inceleme notu. */
  #runSummary(run: WorkerSession, info: WorkerEndInfo): string {
    const t = this.#i18n.t;
    // Arka plan sonucu ayrı bir mesajla gelir: model hangi koşunun bittiğini başlıktan anlar.
    // Bekletilen koşunun sonucu zaten kendi araç çağrısına döner, başlık gereksizdir.
    const head = run.background
      ? [t("prompt.agentRunDone", { id: run.id, name: run.profile.name, title: run.title })]
      : [];
    if (info.status === "failed") {
      return [...head, t("prompt.agentRunFailed", { error: run.info().error ?? "" })].join("\n");
    }
    const parts = [...head, info.result.trim() || t("prompt.agentEmpty")];
    if (run.status === "review") {
      const files = info.files.slice(0, 20).join(", ");
      parts.push(
        t("prompt.agentRunReview", {
          count: info.files.length,
          files: info.files.length > 20 ? `${files} … (+${info.files.length - 20})` : files,
        }),
      );
    }
    return parts.join("\n\n");
  }

  /** Koşunun son asistan metni; ana oturuma dönen özet bundan alınır. */
  #lastAssistantText(sessionId: string): string {
    const live = this.#live.get(sessionId);
    if (!live) return "";
    const items = transcriptFromMessages(live.session.messages, this.#lang);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item?.type === "assistant" && item.text.trim().length > 0) return item.text;
    }
    return "";
  }

  /** Eklentinin `ctx.ui` isteğine cevap; bekleyen kart çözülür. */
  respondExtensionUi(sessionId: string, requestId: string, value: ExtensionUiValue): boolean {
    return this.#live.get(sessionId)?.ui.respond(requestId, value) ?? false;
  }

  /**
   * Kaynaklar (beceri/şablon/paket) değişti: açık oturumları yeni listeyle tazeler.
   * `session.reload()` extension'ları yeniden bağlar; kaynak listesi ve sistem istemi sonraki turda
   * yeni hâliyle kurulur. Çalışan oturumlar atlanır (aktif akışta reload riskli); hata tek oturumu
   * düşürmez, `error` olayıyla bildirilir. Tazelenen oturum sayısı döner.
   */
  async reloadLiveSessions(): Promise<number> {
    let reloaded = 0;
    for (const [sessionId, live] of this.#live) {
      if (live.session.isStreaming) continue;
      // Ajan koşusu oturumu tazelenmez: tazeleme uzantı araçlarını (ör. `agent`) yeniden etkin
      // kılar ve koşunun ajan tanımıyla daraltılmış araç kümesi bozulurdu.
      if (this.runs.parentOf(sessionId)) continue;
      try {
        await live.session.reload();
        reloaded++;
      } catch (error) {
        this.#emitError(sessionId, error);
      }
    }
    return reloaded;
  }

  /** Etkin araçların ad ve açıklaması; sarmalayıcının yerleşikin yerine geçtiği buradan görülür. */
  activeTools(id: string): Array<{ name: string; description: string }> {
    const session = this.#live.get(id)?.session;
    if (!session) return [];
    const active = new Set(session.getActiveToolNames());
    return session
      .getAllTools()
      .filter((t) => active.has(t.name))
      .map(({ name, description }) => ({ name, description }));
  }

  /** Açılış snapshot'ının alt ajan kısmı: koşu başlıkları ve izleri. */
  #subagentsOf(id: string): { subagents: SubagentRun[]; subagentTraces: SubagentTrace[] } {
    const tracker = this.#tracers.get(id);
    return { subagents: tracker?.runs ?? [], subagentTraces: tracker?.traces() ?? [] };
  }

  /**
   * Oturumun alt ajan izleyicisi (varsa oluşturur). Aynı ana oturumun bütün alt koşuları bu
   * izleyiciyi paylaşır; böylece paralel çalışan avcılar birbirinin satırını ezmez.
   */
  #tracerFor(sessionId: string): SubagentTracker {
    let tracker = this.#tracers.get(sessionId);
    if (!tracker) {
      tracker = new SubagentTracker(this.bus, sessionId, this.#lang, Date.now, {
        // Alt ajanların izin/hook işaretleri ana oturum kimliğiyle düşer; iz kartı burada tüketir.
        stopOf: (toolCallId) => this.#takeBlocked(sessionId, toolCallId),
        // Biten koşu ana oturumun dosyasına yazılır: Ajanlar paneli yeniden açılışta dolu gelir.
        onFinish: (record) => {
          const live = this.#live.get(sessionId);
          if (!live) return;
          try {
            live.session.sessionManager.appendCustomEntry(SUBAGENT_RUN_TYPE, record);
          } catch (error) {
            this.config.log?.("warn", "engine", `alt ajan kaydı yazılamadı: ${String(error)}`);
          }
        },
      });
      this.#tracers.set(sessionId, tracker);
    }
    return tracker;
  }

  /**
   * Kullanıcı tanımlı ajan koşusu (`agent` aracının köprüsü). Profil; sistem istemini, modeli,
   * düşünme seviyesini ve araç kümesini belirler; verilmeyen alanlar ana oturumdan devralınır.
   *
   * Oturum bellekte açılır (oturum listesine düşmez). Araç kümesi salt okuma ile sınırlı
   * olmadığı için izin kapısı ana oturumun kimliğiyle bağlanır: alt ajanın yazma/shell çağrıları
   * kullanıcıya ana oturumda sorulur, karar ana oturumun izin moduna göre verilir. Koşu Ajanlar
   * panelinde `agent` türüyle izlenir; tüketim ana oturumun kimliğiyle yayınlanır.
   */
  async #agentRun(input: {
    cwd: string;
    parentId: string;
    profile: AgentInfo;
    prompt: string;
    description?: string;
    callId?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    if (input.signal?.aborted) return "";
    const profile = input.profile;
    const runtime = await this.runtime();
    const parent = this.#live.get(input.parentId);
    // Alt ajan ana oturumun klasöründe yazar: yedeği ana oturumun **bu** turuna gider, ana turu
    // "Geri al" alt ajanın değişikliklerini de döndürür. Tur, ajan başlarken sabitlenir.
    const parentRoute = this.#ownRoute(input.parentId);
    const callId = input.callId;
    const outputsDir = this.#outputsDirs.get(input.parentId);
    const settingsManager = withoutPackages(
      SettingsManager.create(input.cwd, this.config.agentDir, {
        projectTrusted: this.config.projectTrusted?.(input.cwd) ?? true,
      }),
    );
    // Profil istemezse proje talimat dosyaları verilmez: dar kapsamlı ajanlar bağlamı şişirmesin.
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: this.config.agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [],
      extensionFactories: [
        { name: "codezal-prompt", factory: this.#promptExtension(input.cwd), hidden: true },
        // Alt ajanın çağrıları da kullanıcının hook'larından geçer (Claude Code ile aynı).
        ...(this.config.hooks
          ? [
              {
                name: "codezal-hooks",
                factory: this.#hooksExtension(input.parentId, input.cwd),
                hidden: true,
              },
            ]
          : []),
        {
          name: "codezal-permissions",
          // Etiket ayrık koşunun başlığıyla aynı kuralla: iş adı, yoksa ajan adı.
          factory: this.#permissionExtension(input.parentId, input.description || profile.name),
          hidden: true,
        },
        // En sonda: yedek yalnız izin kapısını geçen çağrılar için alınır.
        {
          name: "codezal-turn",
          factory: (pi: ExtensionAPI) =>
            this.#checkpointHooks(pi, {
              cwd: input.cwd,
              ...(outputsDir ? { outputsDir } : {}),
              route: () => parentRoute,
              collect: (changes) => {
                if (!callId) return;
                let files = this.#subagentFiles.get(callId);
                if (!files) {
                  files = new Map();
                  this.#subagentFiles.set(callId, files);
                }
                // Dosya başına net işlem: oluşturulup düzenlenen "oluşturuldu", oluşturulup
                // silinen hiç listelenmez; diğerlerinde son işlem geçerlidir.
                for (const change of changes) {
                  const prev = files.get(change.path);
                  if (prev?.kind !== "create") files.set(change.path, change);
                  else if (change.kind === "delete") files.delete(change.path);
                }
              },
            }),
          hidden: true,
        },
      ],
      // `noContextFiles`: Pi AGENTS.md ailesini kendiliğinden yükler; kapatılmazsa dar kapsamlı
      // ajan (explore) da proje talimatlarını alıyordu.
      ...(profile.injectAgentsMd
        ? {
            agentsFilesOverride: (base) => ({
              agentsFiles: [...base.agentsFiles, ...this.#contextFiles(input.cwd)],
            }),
          }
        : { noContextFiles: true }),
      // Alt ajan da dosya ve web okur: dış içerik kuralı ona da verilir.
      appendSystemPrompt: [
        profile.systemPrompt,
        this.#i18n.t("prompt.languageMatch"),
        this.#i18n.t("prompt.untrustedContent"),
      ].filter((s) => s.trim().length > 0),
    });
    await resourceLoader.reload();
    const model = profile.model
      ? runtime.getModel(profile.model.provider, profile.model.id)
      : parent?.session.model;
    if (profile.model && !model)
      throw new Error(
        this.#i18n.t("errors.modelNotFound", {
          ref: `${profile.model.provider}/${profile.model.id}`,
        }),
      );
    const thinkingLevel = profile.thinking ?? parent?.session.thinkingLevel;
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.config.agentDir,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // Araç kümesi profilden çözülür (`tools` boşsa alt ajan araçlarının tamamı). Web araçları
      // yerleşik değil: özel araç olarak kaydedilir, aksi halde izin listesinde adı boş kalırdı.
      tools: resolveAgentTools(profile),
      customTools: [
        readTool(input.cwd, this.#lang),
        // Yerleşik `bash` aynı adlı tanımla değişir: korumalı alan açıksa alt ajanın komutu da
        // `sandbox-exec` altında koşar (karar her komutta verilir), kapalıyken davranış aynıdır.
        sandboxedBashTool(input.cwd, (runCwd) => this.#sandbox(runCwd)),
        // Alt ajan ana oturumun kapısından geçer; görev koşusundaysa arama ve sayfa yine özetlenir.
        webSearchTool(this.#lang, {
          quarantine: () => this.permissions.isUnattended(input.parentId),
          summaryModel: () => this.config.webSummaryModel?.() ?? null,
          ...this.#webSearchOptions(),
        }),
        webFetchTool(
          this.#lang,
          {},
          {
            quarantine: () => this.permissions.isUnattended(input.parentId),
            summaryModel: () => this.config.webSummaryModel?.() ?? null,
          },
        ),
      ],
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
      resourceLoader,
    });
    const task = (input.description ?? input.prompt).split("\n")[0]?.trim().slice(0, 200) ?? "";
    // Keşif ajanı Ajanlar kutusunda kendi türüyle görünür: satır adı ajan değil, görevdir.
    const explore = profile.name === EXPLORE_AGENT;
    const handle = this.#tracerFor(input.parentId).begin({
      kind: explore ? "explore" : "agent",
      label: explore ? task.slice(0, 120) || this.#i18n.t("env.agentExplore") : profile.name,
      task,
      ...(input.callId ? { parentToolCallId: input.callId } : {}),
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    const unsubscribe = session.subscribe((event) => {
      handle.process(event);
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message as AssistantMessage;
      this.bus.emit({
        type: "usage",
        sessionId: input.parentId,
        at: Date.now(),
        usage: toUsage(message.usage),
        model: message.model,
      });
    });
    let timedOut = false;
    let stopped = false;
    const stop = () => {
      stopped = true;
      void session.abort();
    };
    abortOn(input.signal, stop);
    // Kullanıcı tek bir alt ajanı Ajanlar kutusundan durdurabilir; ana tur kısmi sonuçla sürer.
    let stops = this.#subagentStops.get(input.parentId);
    if (!stops) {
      stops = new Map();
      this.#subagentStops.set(input.parentId, stops);
    }
    stops.set(handle.id, stop);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, AGENT_TIMEOUT_MS);
    try {
      // Kurulum sırasında düşen iptal: tur hiç başlatılmaz, boşa token harcanmaz.
      if (stopped) return "";
      await session.prompt(input.prompt, { expandPromptTemplates: false });
      const items = transcriptFromMessages(session.messages, this.#lang);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item?.type === "assistant" && item.text.trim().length > 0) return item.text;
      }
      // Süre dolduysa model bunu bilmeli: aksi halde boş sonucu "iş yapılmadı" sanır.
      return timedOut ? this.#i18n.t("prompt.agentTimeout") : "";
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      handle.end("error");
      throw new Error(explainProviderError(raw, this.#lang));
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
      stops.delete(handle.id);
      if (stops.size === 0) this.#subagentStops.delete(input.parentId);
      unsubscribe();
      handle.end(stopped ? "stopped" : "done");
      session.dispose();
    }
  }

  /**
   * `agent` aracını oturuma kaydeden fabrika. Araç listesi fabrika gövdesinde okunur: `reload()`
   * fabrikayı yeniden çalıştırdığı için Ajanlar sayfasındaki ekleme/silme/kapatma açık oturumun
   * araç tanımına da yansır (özel araç listesi tazelemede yeniden üretilmez).
   */
  /** Gözetimsiz koşuda danışman yalnız ayar açıksa kullanılır. */
  #advisorAllowed(sessionId: string): boolean {
    return !this.permissions.isUnattended(sessionId) || (this.config.advisorScheduled?.() ?? false);
  }

  /**
   * Danışmanı tur başında gözetim durumuna göre gizler ya da geri açar. Gözetimsiz işareti oturum
   * açıldıktan sonra konduğu için açılıştaki araç listesi bunu bilemez. Yalnız burada gizlenen
   * geri eklenir: ajan koşusu gibi daraltılmış araç kümelerine danışman sızmaz.
   */
  #syncAdvisor(id: string, session: AgentSession): void {
    const active = session.getActiveToolNames();
    const allowed = this.#advisorAllowed(id);
    if (!allowed && active.includes(ADVISOR_TOOL)) {
      session.setActiveToolsByName(active.filter((name) => name !== ADVISOR_TOOL));
      this.#advisorHidden.add(id);
    } else if (allowed && this.#advisorHidden.delete(id)) {
      if (session.getAllTools().some((t) => t.name === ADVISOR_TOOL))
        session.setActiveToolsByName([...active, ADVISOR_TOOL]);
    }
  }

  /** Danışman aracı yalnız model seçiliyken kaydedilir; kapalıyken modele hiç görünmez. */
  #advisorExtension(sessionId: string) {
    return (pi: ExtensionAPI) => {
      if (!this.config.advisorModel?.()) return;
      pi.registerTool(
        advisorTool(
          {
            model: () => this.config.advisorModel?.(),
            allowed: () => this.#advisorAllowed(sessionId),
            // Kullanım sayacı `sağlayıcı/model` bekler; Pi mesajındaki ad yalnız model kimliğidir.
            onUsage: (message, model) =>
              this.bus.emit({
                type: "usage",
                sessionId,
                at: Date.now(),
                usage: toUsage(message.usage),
                model,
              }),
          },
          this.#lang,
        ),
      );
    };
  }

  #agentsExtension(cwd: string, parentId: string) {
    return (pi: ExtensionAPI) => {
      pi.registerTool(
        agentTool(this.#agentBridge(cwd, parentId), this.agents.runnable(cwd), this.#lang),
      );
    };
  }

  /**
   * `agent` aracının köprüsü: profili bulur ve koşunun biçimine karar verir.
   *
   * - Bekletilen, yalıtımsız koşu bellekte çalışır (`#agentRun`); izni ana oturumdan sorulur.
   * - Arka plan ya da worktree koşusu tam bir oturumdur (`AgentRunManager`): arka plan koşusu
   *   hemen döner ve bitince ana oturumu dürter, bekletilen worktree koşusu bitişini bekler.
   * - Yazabilen ajan arka planda ya da başka bir yazan ajanla paralel çalışırken kendiliğinden
   *   worktree'ye alınır: aynı klasörde iki ajan birbirinin dosyasını ezmesin.
   */
  #agentBridge(cwd: string, parentId: string): AgentRunner {
    return async (input) => {
      // İç içe devir yok: koşunun araç kümesi `agent`ı zaten eler; bu kapı kümenin sonradan
      // genişlediği durumlara karşıdır (sonsuz devir ve kontrolsüz maliyet).
      if (this.runs.parentOf(parentId)) throw new Error(this.#i18n.t("prompt.agentNested"));
      const profile = this.agents.find(cwd, input.agentType);
      if (!profile?.enabled || profile.diagnostic) {
        const names = this.agents
          .runnable(cwd)
          .map((a) => a.name)
          .join(", ");
        throw new Error(
          this.#i18n.t("prompt.agentUnknown", { name: input.agentType, list: names }),
        );
      }
      const writes = canWrite(profile);
      const planning = this.#live.get(parentId)?.permission === "plan";
      // Gözetimsiz oturumda (zamanlanmış görev) arka plan koşusu açılmaz: dürtme yeni bir tur
      // açardı ve sonucu kimse görmezdi. Koşu bekletilir.
      const background =
        (input.background ?? profile.background) && !this.permissions.isUnattended(parentId);
      let isolation = this.#isolationFor(parentId, profile, input, background, writes);
      // Otomatik yalıtım kirli ağaçta yapılmaz: worktree HEAD'den açılır, ajan commit'lenmemiş
      // değişiklikleri görmeden eski dosyalar üstünde çalışırdı.
      if (isolation === "preferred" && (await this.runs.dirty(cwd))) isolation = "none";
      // Plan modunda yazan ajan ayrık çalışamaz: ayrık koşunun izni kendi modundan gelir ve plan
      // kapısını aşardı. Bellekteki koşu ana oturumun (plan) kapısından geçer.
      if (planning && writes && (background || isolation === "required")) {
        throw new Error(this.#i18n.t("prompt.agentPlanBlocked", { name: profile.name }));
      }
      if (background || (isolation !== "none" && !planning)) {
        return this.#detachedRun(cwd, parentId, profile, input, background, isolation);
      }
      if (writes) this.#writingSubagents.set(parentId, this.#writingOf(parentId) + 1);
      try {
        // Yuvalar ayrık koşularla ortaktır: eşzamanlı ajan sınırı ikisinin toplamıdır.
        return await this.runs.slots.run(
          () =>
            this.#agentRun({
              cwd,
              parentId,
              profile,
              prompt: input.prompt,
              ...(input.description ? { description: input.description } : {}),
              ...(input.callId ? { callId: input.callId } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            }),
          input.signal,
        );
      } catch (error) {
        // Sırada beklerken iptal edilen koşu hiç başlamadı; modele boş sonuç döner.
        if (input.signal?.aborted) return "";
        throw error;
      } finally {
        if (writes) {
          const left = this.#writingOf(parentId) - 1;
          if (left > 0) this.#writingSubagents.set(parentId, left);
          else this.#writingSubagents.delete(parentId);
        }
      }
    };
  }

  #writingOf(parentId: string): number {
    return this.#writingSubagents.get(parentId) ?? 0;
  }

  /**
   * Koşunun yalıtımı. Çağrı ya da ajan tanımı açıkça worktree istiyorsa `required`. Aksi hâlde
   * yazan ajan arka planda ya da o an çalışan başka bir yazan ajanla birlikte `preferred` (git
   * deposu değilse kökte sürer), diğerleri `none`. Model yalıtımı kapatamaz: onay adımından
   * kaçmak için `none` seçiyordu.
   */
  #isolationFor(
    parentId: string,
    profile: AgentInfo,
    input: AgentRunInput,
    background: boolean,
    writes: boolean,
  ): RunIsolation {
    if (input.isolation === "worktree") return "required";
    if (profile.isolation === "worktree") return writes ? "required" : "none";
    if (!writes) return "none";
    return background || this.#writingOf(parentId) > 0 ? "preferred" : "none";
  }

  /** Ayrık koşu: arka plandaysa kimliği hemen döner, değilse bitişini bekleyip özeti döndürür. */
  async #detachedRun(
    cwd: string,
    parentId: string,
    profile: AgentInfo,
    input: AgentRunInput,
    background: boolean,
    isolation: RunIsolation,
  ): Promise<string> {
    const title = (input.description ?? input.prompt).split("\n")[0]?.trim().slice(0, 120);
    const run = this.runs.start({
      parentSessionId: parentId,
      cwd,
      profile,
      title: title || profile.name,
      task: input.prompt,
      background,
      isolation,
    });
    if (background) {
      if (run.status === "failed") throw new Error(run.info().error ?? "");
      return this.#i18n.t("prompt.agentRunStarted", { id: run.id, name: profile.name });
    }
    // Bekletilen koşu ana turun iptaline ve süre sınırına bağlıdır; arka plan koşusu değildir.
    // Süre koşu başlayınca sayılır: sırada beklenen süre koşunun süresi değildir.
    const stop = () => run.stop();
    abortOn(input.signal, stop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    void run.started.then(() => {
      if (settled) return;
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, AGENT_TIMEOUT_MS);
    });
    try {
      await run.ended;
    } finally {
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
    }
    const info = run.info();
    if (info.status === "failed") throw new Error(info.error ?? "");
    // Süre dolduysa model bunu bilmeli: boş sonuç "iş yapılmadı" sanılır.
    if (info.status === "cancelled") return timedOut ? this.#i18n.t("prompt.agentTimeout") : "";
    return this.#runSummary(run, {
      status: "done",
      result: info.result ?? "",
      files: [...run.files],
      durationMs: (info.endedAt ?? Date.now()) - (info.startedAt ?? info.createdAt),
    });
  }

  // ---------- güvenlik denetimi ----------

  /** Denetim deposu yapılandırılmış mı; değilse araçlar run açamaz. */
  #auditDeps(cwd: string): AuditSessionDeps {
    const store = this.#auditStore;
    if (!store) throw new Error(this.#i18n.t("prompt.auditNoRun"));
    return {
      store,
      cwd,
      repo: basename(cwd),
      assetsDir: this.config.auditAssetsDir ?? null,
      lang: this.#lang,
    };
  }

  /** Canlı oturumun denetim run'ı; meta'da kayıt varsa diskten yüklenir ve önbelleğe alınır. */
  #auditSession(id: string): AuditSession | null {
    const cached = this.#audits.get(id);
    if (cached) return cached;
    const live = this.#live.get(id);
    const runId = this.#meta.get(id).audit?.runId;
    if (!live || !runId || !this.#auditStore) return null;
    const loaded = AuditSession.load(this.#auditDeps(live.cwd), runId);
    if (!loaded) return null;
    this.#audits.set(id, loaded);
    return loaded;
  }

  #requireAudit(id: string): AuditSession {
    const session = this.#auditSession(id);
    if (!session) throw new Error(this.#i18n.t("prompt.auditNoRun"));
    return session;
  }

  /** Panelin veri kaynağı; run yoksa null. */
  auditView(id: string): AuditView | null {
    return this.#auditSession(id)?.view() ?? null;
  }

  /** PDF dışa aktarımı için rapor HTML'i (main `renderPdf`e verir). */
  auditReportHtml(id: string): string | null {
    const session = this.#auditSession(id);
    if (!session) return null;
    return buildReport(this.#reportInput(session), this.#lang).html;
  }

  /** PDF'in yazılacağı yol; main dosyayı buraya bırakır. */
  auditPdfPath(id: string): string | null {
    const session = this.#auditSession(id);
    return session ? session.store.paths(session.cwd, session.runId).pdf : null;
  }

  /** Run klasörü; panel "Finder'da aç" için kullanır. */
  auditRunDir(id: string): string | null {
    const session = this.#auditSession(id);
    return session ? session.store.paths(session.cwd, session.runId).dir : null;
  }

  #reportInput(session: AuditSession) {
    return { meta: session.meta, ledger: session.ledger, findings: session.findings };
  }

  /**
   * Denetim run'ı başlatır. Oturum plan iznine çekilir: güvenilmeyen depo içeriğinden gelen
   * bulgular hedef koda yazıya dönüşemez (K5). Denetim araçları plan modunda da serbesttir.
   */
  startAudit(id: string, options: AuditStartOptions): AuditView {
    const live = this.#require(id);
    if (this.permissions.isUnattended(id)) throw new Error(this.#i18n.t("permission.unattended"));
    const existing = this.#auditSession(id);
    if (existing) return existing.view();
    const session = AuditSession.start(this.#auditDeps(live.cwd), options);
    this.#audits.set(id, session);
    this.#meta.set(id, { audit: { runId: session.runId } });
    if (live.permission !== "plan") {
      live.planReturnTo = live.permission;
      this.#switchPermission(id, "plan");
    }
    this.#activateTools(live.session, [...DEFAULT_TOOLS, ...AUDIT_TOOLS]);
    this.config.onAuditChanged?.(id);
    return session.view();
  }

  #auditRunner(id: string): AuditRunner {
    return {
      start: async (options) => this.#auditStartResult(id, options),
      hunt: (units, signal, onProgress) => this.#auditHunt(id, units, signal, onProgress),
      verify: (candidates, signal, onProgress) =>
        this.#auditVerify(id, candidates, signal, onProgress),
      record: async (candidates) => this.#auditRecord(id, candidates),
      status: async () => this.#auditStatus(id),
      report: async () => this.#auditReport(id),
    };
  }

  async #auditStartResult(id: string, options: AuditStartOptions): Promise<AuditStartResult> {
    const view = this.startAudit(id, options);
    const session = this.#requireAudit(id);
    session.setPhase("recon");
    this.config.onAuditChanged?.(id);
    return {
      runId: session.runId,
      profile: session.meta.profile,
      units: view.counts.units,
      packs: session.meta.packs,
      budget: session.meta.budget.agentCalls,
      nextUnits: session.nextUnits(MAX_HUNT_UNITS).map(toUnitSummary),
      message: this.#i18n.t("prompt.auditSystem"),
    };
  }

  /** Bir av dalgası: her birim izole, salt-okunur bir alt oturumda taranır. */
  async #auditHunt(
    id: string,
    unitIds: string[],
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ): Promise<AuditHuntResult[]> {
    const session = this.#requireAudit(id);
    const live = this.#require(id);
    session.setPhase("hunting");
    const { assignments, errors } = session.assign(unitIds);
    const total = unitIds.length;
    // Kart avcılar çalışırken sessiz beklemesin: ne yapıldığı ve ilerleme tek satırda akar.
    let done = errors.length;
    let candidates = 0;
    if (total > 0) onProgress?.(this.#i18n.t("tool.auditHuntStart", { total }));
    const results: AuditHuntResult[] = errors.map(({ unitId, error }) => ({
      unit: unitId,
      attackClass: "",
      candidates: [],
      error,
    }));

    const runOne = async (assignment: HuntAssignment): Promise<AuditHuntResult> => {
      const base = { unit: assignment.unitId, attackClass: assignment.attackClass };
      // Tur durdurulduysa yeni av başlatılmaz; birim planlı kalır, bütçe harcanmaz.
      if (signal?.aborted) return { ...base, candidates: [], error: "durduruldu" };
      if (!session.spend(1)) {
        session.markUnit(assignment.unitId, "deferred", "ajan bütçesi doldu");
        return { ...base, candidates: [], error: this.#i18n.t("prompt.auditBudgetExhausted") };
      }
      const system = this.#i18n.t("prompt.auditHunterSystem");
      const task = this.#huntTask(assignment);
      try {
        const first = await this.#readOnlySubSession({
          cwd: live.cwd,
          parentId: id,
          system,
          task,
          thinking: "low",
          timeoutMs: this.config.auditTimeouts?.huntMs ?? AUDIT_HUNT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          run: {
            kind: "audit-hunter",
            label: `${this.#i18n.t("agents.hunter")} · ${assignment.unitId}`,
          },
          finalize: this.#i18n.t("prompt.auditHunterFinalize"),
          // Onarım **ikinci bir model çağrısıdır** ve bütçeden düşmelidir; aksi hâlde sayaç
          // gerçekte yapılan çağrıdan az gösterir ve "bütçe doldu" kararı yanlış olur.
          repair: (text) => {
            const check = parseHunterOutput(text);
            if (check.ok || !session.spend(1)) return null;
            return this.#i18n.t("prompt.auditRepair").replace("{{error}}", check.error);
          },
        });
        const parsed = parseHunterOutput(first.text);
        if (!parsed.ok) {
          if (first.timedOut) {
            // `planned`a dönerse ana ajan aynı birimi tekrar tekrar avlatıp bütçeyi yakıyordu;
            // ertelenen birim raporda "kapsanmadı" olarak görünür.
            session.markUnit(assignment.unitId, "deferred", "avcı süre sınırında sonuç vermedi");
            this.config.onAuditChanged?.(id);
            return { ...base, candidates: [], error: this.#i18n.t("prompt.auditHunterTimeout") };
          }
          session.addParseFailure(assignment.unitId, first.sessionId, parsed.error);
          this.config.onAuditChanged?.(id);
          return { ...base, candidates: [], parseError: parsed.error };
        }
        const added = session.addCandidates(
          assignment.unitId,
          assignment.attackClass,
          first.sessionId,
          parsed.value.candidates,
          { partial: first.timedOut },
        );
        this.config.onAuditChanged?.(id);
        return {
          ...base,
          ...(first.timedOut ? { partial: true } : {}),
          candidates: added.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            evidence: `${candidate.evidence[0]?.file ?? "?"}:${candidate.evidence[0]?.line ?? 0}`,
            confidence: candidate.confidence?.score ?? null,
          })),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.markUnit(assignment.unitId, "planned", `avcı hatası: ${message.slice(0, 180)}`);
        return { ...base, candidates: [], error: message };
      }
    };

    const hunted = await mapLimit(assignments, AUDIT_CONCURRENCY, async (assignment) => {
      const result = await runOne(assignment);
      done += 1;
      candidates += result.candidates.length;
      onProgress?.(this.#i18n.t("tool.auditHuntProgress", { done, total, candidates }));
      return result;
    });
    this.config.onAuditChanged?.(id);
    return [...results, ...hunted];
  }

  #huntTask(assignment: HuntAssignment): string {
    const lines = [
      `${this.#i18n.t("prompt.auditUnitLabel")}: ${assignment.unitId} (${assignment.attackClass})`,
    ];
    if (assignment.packPath)
      lines.push(`${this.#i18n.t("prompt.auditPackLabel")}: ${assignment.packPath}`);
    lines.push(`${this.#i18n.t("prompt.auditScopeLabel")}:`);
    // Dosya adları depodan gelir ve POSIX'te satır sonu içerebilir: ham yazılırsa bir dosya adı
    // görev bloğunun ortasına talimat satırı olarak girer (`git ls-files -z` NUL ile böler, ad
    // geçerlidir). Denetim metni JSON dizesi olarak yazılır, böylece ad tek satırda ve tırnaklı
    // kalır; satır sonları kaçışla gösterilir.
    for (const file of assignment.scopePaths.slice(0, 300)) lines.push(`- ${JSON.stringify(file)}`);
    if (assignment.scopePaths.length > 300)
      lines.push(`- … (+${assignment.scopePaths.length - 300})`);
    return lines.join("\n");
  }

  /** Adayın iddiası BAŞKA bir alt oturumda çürütülmeye çalışılır (K4). */
  async #auditVerify(
    id: string,
    candidateIds: string[],
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ): Promise<AuditVerifyResult[]> {
    const session = this.#requireAudit(id);
    const live = this.#require(id);
    session.setPhase("validation");
    const pending = session.pendingVerification(candidateIds);
    const total = pending.length;
    let done = 0;
    if (total > 0) onProgress?.(this.#i18n.t("tool.auditVerifyStart", { total }));

    const runOne = async (candidate: AuditCandidate): Promise<AuditVerifyResult> => {
      if (signal?.aborted) return { id: candidate.id, verdict: "pending", reason: "durduruldu" };
      if (!session.spend(1))
        return {
          id: candidate.id,
          verdict: "pending",
          reason: this.#i18n.t("prompt.auditBudgetExhausted"),
        };
      const system = this.#i18n.t("prompt.auditVerifierSystem");
      const task = [
        `${this.#i18n.t("prompt.auditUnitLabel")}: ${candidate.unit} (${candidate.attackClass})`,
        `${this.#i18n.t("prompt.auditCandidateLabel")}:`,
        JSON.stringify(
          {
            title: candidate.title,
            description: candidate.description,
            claimed_root_cause: candidate.claimed_root_cause,
            ...(candidate.intended_behavior
              ? { intended_behavior: candidate.intended_behavior }
              : {}),
            trace: candidate.trace,
            evidence: candidate.evidence,
            conditions: candidate.conditions,
            ...(candidate.confidence ? { confidence: candidate.confidence } : {}),
          },
          null,
          2,
        ),
      ].join("\n");
      try {
        const first = await this.#readOnlySubSession({
          cwd: live.cwd,
          parentId: id,
          system,
          task,
          thinking: "high",
          timeoutMs: this.config.auditTimeouts?.verifyMs ?? AUDIT_VERIFY_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          run: {
            kind: "audit-verifier",
            label: `${this.#i18n.t("agents.verifier")} · ${candidate.title}`,
          },
          finalize: this.#i18n.t("prompt.auditVerifierFinalize"),
          // Onarım turu da bütçeden düşer (bkz. avcı tarafındaki not). Aynı oturumda yapılır:
          // adayı görmeyen yeni bir oturum yanlış bir kararı şemaya uydurabilir.
          repair: (text) => {
            const check = parseVerifierVerdict(text);
            if (check.ok || !session.spend(1)) return null;
            return this.#i18n.t("prompt.auditRepair").replace("{{error}}", check.error);
          },
        });
        const parsed = parseVerifierVerdict(first.text);
        if (!parsed.ok) {
          // Yapısal çıktı yoksa aday doğrulanmamış kalır; uydurma bir karar kaydedilmez.
          const reason = first.timedOut
            ? this.#i18n.t("prompt.auditVerifierTimeout")
            : `${this.#i18n.t("prompt.auditVerifierParseFailed")} (${parsed.error})`;
          this.config.onAuditChanged?.(id);
          return { id: candidate.id, verdict: "pending", reason };
        }
        session.applyVerification(candidate.id, first.sessionId, parsed.value);
        this.config.onAuditChanged?.(id);
        return { id: candidate.id, verdict: parsed.value.verdict, reason: parsed.value.reason };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id: candidate.id, verdict: "pending", reason: message };
      }
    };

    const verified = await mapLimit(pending, AUDIT_CONCURRENCY, async (candidate) => {
      const result = await runOne(candidate);
      done += 1;
      onProgress?.(this.#i18n.t("tool.auditVerifyProgress", { done, total }));
      return result;
    });
    this.config.onAuditChanged?.(id);
    return verified;
  }

  /** Doğrulanmış adayları kayda geçirir; şema ve bağımsızlık `AuditSession.record`ta zorlanır. */
  async #auditRecord(id: string, candidateIds: string[]): Promise<AuditRecordResult> {
    const session = this.#requireAudit(id);
    session.setPhase("recording");
    const result = session.record(candidateIds);
    if (result.recorded.length > 0) session.setPhase("verification");
    this.config.onAuditChanged?.(id);
    return {
      recorded: result.recorded.map((finding) => ({
        id: finding.fingerprint,
        verdict: finding.verdict,
        severity: finding.verdict === "confirmed" ? finding.severity.overall_severity : null,
      })),
      errors: result.errors,
    };
  }

  async #auditStatus(id: string): Promise<AuditStatusResult> {
    const session = this.#requireAudit(id);
    const view = session.view();
    return {
      runId: session.runId,
      profile: view.profile,
      phase: view.phase,
      status: view.status,
      packs: session.meta.packs,
      executionPolicy: session.meta.executionPolicy,
      counts: view.counts,
      budget: view.budget,
      nextUnits: session.nextUnits(MAX_HUNT_UNITS).map(toUnitSummary),
      pendingVerification: session.pendingVerification([]).map((candidate) => candidate.id),
      findings: view.findings.map((finding) => ({
        id: finding.fingerprint,
        verdict: finding.verdict,
        severity: finding.severity,
        title: finding.title,
      })),
      incompleteReason: view.incompleteReason,
    };
  }

  /**
   * Raporları üretir ve run'ı kapatır. Eksik iş (planlı birim ya da doğrulanmamış aday) varsa
   * run `incomplete` işaretlenir; bu, raporda görünür kalır (skill'in iki terminal durumu).
   */
  async #auditReport(id: string): Promise<AuditReportResult> {
    const session = this.#requireAudit(id);
    session.setPhase("reporting");
    const pendingWork =
      session.nextUnits(1).length > 0 || session.pendingVerification([]).length > 0;
    if (session.budgetExhausted) session.setStatus("incomplete", "agent_budget_exhausted");
    else if (pendingWork) session.setStatus("incomplete", "pending_units");
    // Süre sınırında ertelenen birim taranmamıştır: run "complete" görünüp sessizce seyrelmesin.
    else if (session.unhuntedDeferred().length > 0)
      session.setStatus("incomplete", "deferred_units");
    else session.setStatus("complete");

    const report = buildReport(this.#reportInput(session), this.#lang);
    const paths = session.store.paths(session.cwd, session.runId);
    session.store.writeMarkdown(session.cwd, session.runId, AUDIT_FILE.report, report.report);
    session.store.writeMarkdown(session.cwd, session.runId, AUDIT_FILE.detail, report.detail);
    session.store.writeMarkdown(
      session.cwd,
      session.runId,
      AUDIT_FILE.needsValidation,
      report.needsValidation,
    );
    // Run kapandı: oturum denetim öncesi izin moduna döner.
    const live = this.#live.get(id);
    if (live?.planReturnTo) {
      const back = live.planReturnTo;
      live.planReturnTo = undefined;
      this.#switchPermission(id, back);
    }
    this.config.onAuditChanged?.(id);
    return {
      reportPath: paths.report,
      detailPath: paths.detail,
      needsValidationPath: paths.needsValidation,
      status: session.meta.status,
      counts: session.view().counts,
    };
  }

  /**
   * Salt-okuma alt oturumu: ana oturumun modeliyle, yalnızca okuma araçlarıyla, bellekte çalışır.
   * Hedef kod çalıştırılmaz (K3); uzantılar yüklenmez, izin kapısı gerekmez. Güvenlik denetimi
   * avcı/doğrulayıcıları ve kod incelemesi bu oturumu kullanır; tüketim toplanıp döndürülür.
   */
  async #readOnlySubSession(input: {
    cwd: string;
    parentId: string;
    system: string;
    task: string;
    thinking: "low" | "high";
    timeoutMs: number;
    signal?: AbortSignal;
    /**
     * Verilirse bu alt oturum Ajanlar panelinde canlı izlenir: tür, etiket ve ana
     * transcript'teki araç çağrısı bağlantısı. Denetim avcı/doğrulayıcı ile inceleme turları
     * geçirir; çağrı sahibi izlemek istemiyorsa alan boş kalır.
     */
    run?: { kind: SubagentKind; label: string; parentToolCallId?: string };
    /**
     * Verilirse süre dolunca oturum hemen kesilmez: araçlar kapanır, bu metin yönlendirme olarak
     * gider ve model `SUBSESSION_FINALIZE_GRACE_MS` içinde elindekiyle yanıt yazar. Sonuç
     * `timedOut: true` döner; çağıran onu kısmi sayar.
     */
    finalize?: string;
    /**
     * Yanıt şemaya uymazsa onarım istemi döndürür (null: onarım yok). Onarım AYNI oturumda,
     * araçsız yapılır: yeni oturum önceki yanıtı ve görevi görmez, sıfırdan avlanmaya başlar.
     */
    repair?: (text: string) => string | null;
  }): Promise<{ sessionId: string; text: string; timedOut: boolean; usage: Usage }> {
    if (input.signal?.aborted) {
      return { sessionId: "", text: "", timedOut: false, usage: emptyUsage() };
    }
    const runtime = await this.runtime();
    const settingsManager = withoutPackages(
      SettingsManager.create(input.cwd, this.config.agentDir, {
        projectTrusted: this.config.projectTrusted?.(input.cwd) ?? true,
      }),
    );
    // Kullanıcı eklentisi yüklenmez; yalnız kimlik/ortam fabrikası. İncelenen kod ve web içeriği
    // talimat taşıyabilir (denetim avcısı tam da bunu okur): dış içerik kuralı burada da verilir.
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: this.config.agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        {
          name: "codezal-prompt",
          factory: this.#promptExtension(input.cwd, "prompt.identityReadOnly"),
          hidden: true,
        },
      ],
      appendSystemPrompt: [this.#i18n.t("prompt.untrustedContent")],
    });
    await resourceLoader.reload();
    const model = this.#live.get(input.parentId)?.session.model;
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.config.agentDir,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      thinkingLevel: input.thinking,
      tools: EXPLORE_TOOLS,
      customTools: [readTool(input.cwd, this.#lang)],
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
      resourceLoader,
    });
    // İzleyici kurulumdan sonra bağlanır: alt oturum açılamazsa ortada kalan koşu satırı olmaz;
    // izleyici oturum başına tektir, paralel avcılar aynı listeyi paylaşır.
    const handle = input.run
      ? this.#tracerFor(input.parentId).begin({
          kind: input.run.kind,
          label: input.run.label,
          task: input.task.split("\n")[0]?.trim().slice(0, 200) ?? "",
          thinkingLevel: input.thinking,
          ...(input.run.parentToolCallId ? { parentToolCallId: input.run.parentToolCallId } : {}),
        })
      : null;
    let usage = emptyUsage();
    const unsubscribe = session.subscribe((event) => {
      handle?.process(event);
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message as AssistantMessage;
      const messageUsage = toUsage(message.usage);
      usage = addUsage(usage, messageUsage);
      this.bus.emit({
        type: "usage",
        sessionId: input.parentId,
        at: Date.now(),
        usage: messageUsage,
        model: message.model,
      });
    });
    let timedOut = false;
    let stopped = false;
    const stop = () => {
      stopped = true;
      void session.abort();
    };
    abortOn(input.signal, stop);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (input.finalize === undefined) {
        stop();
        return;
      }
      // Pi araç listesini her model çağrısından önce yeniden okur; yönlendirme de o çağrıdan
      // önce teslim edilir. Böylece sıradaki tur araçsız, yalnız yanıt yazar.
      session.setActiveToolsByName([]);
      if (session.isStreaming) void session.steer(input.finalize).catch(() => undefined);
      graceTimer = setTimeout(
        stop,
        this.config.auditTimeouts?.graceMs ?? SUBSESSION_FINALIZE_GRACE_MS,
      );
    }, input.timeoutMs);
    const lastText = (): string => {
      const items = transcriptFromMessages(session.messages, this.#lang);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item?.type === "assistant" && item.text.trim().length > 0) return item.text;
      }
      return "";
    };
    try {
      // Kurulum sırasında düşen iptal: tur hiç başlatılmaz, boşa token harcanmaz.
      if (stopped) return { sessionId: session.sessionId, text: "", timedOut: false, usage };
      await session.prompt(`${input.system}\n\n${input.task}`, { expandPromptTemplates: false });
      let text = lastText();
      const repair = !stopped && input.repair ? input.repair(text) : null;
      if (repair) {
        session.setActiveToolsByName([]);
        await session.prompt(repair, { expandPromptTemplates: false });
        text = lastText();
      }
      return { sessionId: session.sessionId, text, timedOut, usage };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      handle?.end("error");
      throw new Error(explainProviderError(raw, this.#lang));
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      input.signal?.removeEventListener("abort", stop);
      unsubscribe();
      handle?.end(stopped ? "stopped" : "done");
      session.dispose();
    }
  }

  /**
   * `parentSessionId` IPC'den gelmez: yalnız motorun açtığı ajan koşusu oturumu taşır; kenar
   * çubuğu bu oturumları gizler, koşu ana oturumun Ajanlar kutusundan açılır.
   */
  async createSession(raw: SessionOptions & { parentSessionId?: string }): Promise<SessionSummary> {
    const { parentSessionId = null, ...options } = raw;
    const cwd = options.cwd;
    const sm = SessionManager.create(cwd, this.#sessionDir(cwd));
    const session = await this.#open(cwd, sm, options);
    const id = session.sessionId;
    this.#meta.set(id, {
      mode: options.mode,
      permission: options.permission,
      thinking: options.thinking,
      projectId: options.projectId ?? null,
      parentSessionId,
    });
    if (options.name) session.setSessionName(options.name);
    return {
      id,
      path: session.sessionFile ?? "",
      cwd,
      name: options.name ?? this.#i18n.t("session.newTask"),
      mode: options.mode,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      messageCount: 0,
      pinned: false,
      archived: false,
      live: true,
      projectId: options.projectId ?? null,
      auditRunId: null,
      parentSessionId,
      sideOf: null,
    };
  }

  async openSession(id: string): Promise<{
    summary: SessionSummary;
    transcript: TranscriptItem[];
    context?: ContextUsage;
    usage?: Usage;
    permission: PermissionMode;
    model?: ModelRef;
    thinking: ThinkingLevel;
    /** Açılışta hâlâ çalışan arka plan görevleri; Ajanlar kutusu bunlarla dolar. */
    backgrounds: BackgroundJob[];
    /** Açılışta aktif kalıcı hedef (`/goal`); GoalCard bununla dolar. */
    goal?: GoalState;
    /** Yanıt bekleyen izinler (koşularınkiler dahil), plan onayı ve soru; kartlar bununla döner. */
    permissions?: PermissionRequest[];
    planReview?: PlanReview;
    question?: QuestionRequest;
    /**
     * Bu snapshot'ın kapsadığı son olay sırası: renderer yalnızca `seq > lastSeq` olan olayları
     * uygular; snapshot ile canlı akış arasında çift/kayıp mesaj kalmaz.
     */
    lastSeq: number;
    /** Motorun bu çalışmasına ait kimlik; renderer'ın imleci bununla bayatlık denetler. */
    epoch: string;
    /** Açılış anında süren turun kimliği; tur yoksa null. Renderer turu bununla geri kurar. */
    runId: string | null;
    /** Alt ajan koşuları ve izleri (biten koşular oturum dosyasından gelir). */
    subagents: SubagentRun[];
    subagentTraces: SubagentTrace[];
  }> {
    const live = this.#live.get(id);
    if (live) {
      const infos = await SessionManager.list(live.cwd, this.#sessionDir(live.cwd));
      const info = infos.find((i) => i.id === id);
      const summary = info
        ? this.#summarize(info)
        : { ...(await this.#fallbackSummary(id, live.cwd)), live: true };
      const model = this.#modelRefOf(live.session);
      const goal = this.#goalOf(id);
      const planReview = this.plans.pendingFor(id);
      const question = this.questions.pendingFor(id);
      return {
        summary,
        transcript: this.#transcriptOf(id, live.session),
        ...this.#contextOf(live.session),
        usage: this.#usageOf(live.session),
        permission: live.permission,
        ...(model ? { model } : {}),
        thinking: this.#thinkingOf(live.session),
        backgrounds: this.#backgroundJobsOf(id),
        ...(goal ? { goal } : {}),
        permissions: this.#pendingAsks(id),
        ...(planReview ? { planReview } : {}),
        ...(question ? { question } : {}),
        lastSeq: this.bus.seqOf(id),
        epoch: this.bus.epoch,
        runId: live.mapper.runId ?? null,
        ...this.#subagentsOf(id),
      };
    }
    const path = await this.#resolvePath(id);
    const sm = SessionManager.open(path, undefined);
    const cwd = sm.getCwd();
    const meta = this.#meta.get(id);
    const session = await this.#open(cwd, sm, {
      cwd,
      mode: meta.mode,
      permission: meta.permission,
      location: "local",
      projectId: meta.projectId,
      ...(meta.thinking ? { thinking: meta.thinking } : {}),
    });
    const infos = await SessionManager.list(cwd, this.#sessionDir(cwd));
    const info = infos.find((i) => i.id === session.sessionId);
    const summary = info ? this.#summarize(info) : await this.#fallbackSummary(id, cwd);
    const model = this.#modelRefOf(session);
    const goal = this.#goalOf(id);
    return {
      summary: { ...summary, live: true },
      transcript: this.#transcriptOf(id, session),
      ...this.#contextOf(session),
      usage: this.#usageOf(session),
      permission: meta.permission,
      ...(model ? { model } : {}),
      thinking: this.#thinkingOf(session),
      backgrounds: this.#backgroundJobsOf(id),
      ...(goal ? { goal } : {}),
      lastSeq: this.bus.seqOf(id),
      epoch: this.bus.epoch,
      // Diskten yeni açılan oturumda süren tur olamaz; tur kimliği yalnız canlı oturumda bulunur.
      runId: null,
      ...this.#subagentsOf(id),
    };
  }

  /** Oturumun hâlâ çalışan arka plan görevleri; bitmişler bellekte kalır, açılışa taşınmaz. */
  #backgroundJobsOf(id: string): BackgroundJob[] {
    return this.#background
      .listBackgrounded(id)
      .filter((t) => t.status === "running")
      .map(toBackgroundJob);
  }

  /** Oturumun toplam token kullanımı; yeniden açılan oturumda önbellek isabeti buradan hesaplanır. */
  #usageOf(session: AgentSession): Usage {
    const s = session.getSessionStats();
    return {
      input: s.tokens.input,
      output: s.tokens.output,
      cacheRead: s.tokens.cacheRead,
      cacheWrite: s.tokens.cacheWrite,
      cost: s.cost,
    };
  }

  /** Açılıştaki bağlam doluluğu; Pi hesaplayamazsa boş nesne. */
  #contextOf(session: AgentSession): { context?: ContextUsage } {
    const usage = session.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return {};
    return {
      context: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent },
    };
  }

  /** Rotasyon yüzünden gizlenen hata varsa yayınlar; tur sessizce durmuş görünmesin. */
  #flushHeldError(sessionId: string): void {
    const held = this.#heldError.get(sessionId);
    if (!held) return;
    this.#heldError.delete(sessionId);
    this.bus.emit(held);
  }

  /** Bağlam doluluğunu yayınlar; sayı değişmediyse veriyolunu meşgul etmez. */
  #emitContext(id: string, session: AgentSession): void {
    const usage = session.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return;
    if (this.#lastContext.get(id) === usage.tokens) return;
    this.#lastContext.set(id, usage.tokens);
    this.bus.emit({
      type: "context",
      sessionId: id,
      at: Date.now(),
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    });
  }

  /** Daldaki N. kullanıcı mesajı girdisi (renderer kullanıcı balonlarını aynı sırayla sayar). */
  #userEntry(live: LiveSession, userOrdinal: number) {
    let n = 0;
    for (const entry of live.session.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      n++;
      if (n === userOrdinal) return entry;
    }
    return undefined;
  }

  /**
   * Aynı oturumda N. kullanıcı mesajının öncesine geri sarar (Pi ağaç gezinmesi; eski dal dosyada kalır).
   * Mesajın metni düzenlenmek üzere döner. Ajan çalışırken çağrılamaz.
   */
  async rewindSession(
    id: string,
    userOrdinal: number,
  ): Promise<{
    transcript: TranscriptItem[];
    editorText: string;
    context?: ContextUsage;
    usage?: Usage;
  }> {
    if (!this.#live.has(id)) await this.openSession(id);
    const live = this.#require(id);
    const entry = this.#userEntry(live, userOrdinal);
    if (!entry) throw new Error(this.#i18n.t("errors.rewindMessageNotFound"));
    // Geri sarma noktası: bu kullanıcı mesajı ve sonrası daldan düşer, işaretler de onunla gider.
    const cutoff = entry.message.timestamp;
    const result = await live.session.navigateTree(entry.id);
    if (result.cancelled) throw new Error(this.#i18n.t("errors.rewindCancelled"));
    this.#dropMarksAfter(id, cutoff);
    this.#tracers.get(id)?.dropAfter(cutoff);
    return {
      transcript: this.#transcriptOf(id, live.session),
      editorText: result.editorText ?? "",
      ...this.#contextOf(live.session),
      usage: this.#usageOf(live.session),
    };
  }

  /** Geri sarma noktasından sonraki işaretleri siler: dallanan kısmın izleri sohbette kalmaz. */
  #dropMarksAfter(id: string, cutoff: number): void {
    const marks = this.#meta.get(id).marks;
    const kept = marks.filter((mark) => mark.at <= cutoff);
    if (kept.length !== marks.length) this.#meta.set(id, { marks: kept });
  }

  /**
   * Oturumu kopyalar. `assistantOrdinal` verilirse metinli N. asistan mesajına kadar olan yol,
   * `userOrdinal` verilirse N. kullanıcı mesajının öncesine kadar olan yol yeni dosyaya alınır
   * (Dallandır); ikisi de yoksa tüm geçmiş kopyalanır (Çoğalt). Yeni oturum açık döner.
   */
  async forkSession(
    id: string,
    assistantOrdinal?: number,
    userOrdinal?: number,
  ): Promise<SessionSummary> {
    if (!this.#live.has(id)) await this.openSession(id);
    const live = this.#require(id);
    const sourcePath = live.session.sessionFile ?? this.#paths.get(id);
    if (!sourcePath) throw new Error(this.#i18n.t("errors.sessionNotWritten"));
    const meta = this.#meta.get(id);
    const cwd = live.cwd;
    const dir = this.#sessionDir(cwd);
    let sm: SessionManager;
    let suffix: string;
    if (assistantOrdinal === undefined && userOrdinal === undefined) {
      sm = SessionManager.forkFrom(sourcePath, cwd, dir);
      suffix = this.#i18n.t("session.copySuffix");
    } else if (userOrdinal !== undefined) {
      // İlk mesajın öncesi boş: dallandırılacak bir şey yok.
      const parentId = this.#userEntry(live, userOrdinal)?.parentId;
      if (!parentId) throw new Error(this.#i18n.t("errors.branchMessageNotFound"));
      const path = live.session.sessionManager.createBranchedSession(parentId);
      if (!path) throw new Error(this.#i18n.t("errors.branchFailed"));
      sm = SessionManager.open(path, dir);
      suffix = this.#i18n.t("session.branchSuffix");
    } else {
      // Renderer ile aynı kural: metin içeren asistan mesajları sayılır.
      let n = 0;
      let leafId: string | undefined;
      for (const entry of live.session.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const hasText = entry.message.content.some((c) => c.type === "text" && c.text.trim());
        if (!hasText) continue;
        n++;
        if (n === assistantOrdinal) {
          leafId = entry.id;
          break;
        }
      }
      if (!leafId) throw new Error(this.#i18n.t("errors.branchMessageNotFound"));
      const path = live.session.sessionManager.createBranchedSession(leafId);
      if (!path) throw new Error(this.#i18n.t("errors.branchFailed"));
      sm = SessionManager.open(path, dir);
      suffix = this.#i18n.t("session.branchSuffix");
    }
    const session = await this.#open(cwd, sm, {
      cwd,
      mode: meta.mode,
      permission: meta.permission,
      location: "local",
      projectId: meta.projectId,
      ...(meta.thinking ? { thinking: meta.thinking } : {}),
    });
    const newId = session.sessionId;
    // İşaretler de dallanan yolla taşınır: kopyalanan aralığa düşen satırlar yeni oturumda
    // görünür, sonrasındakiler (bu dalda yaşanmayan komutlar) taşınmaz.
    const until = transcriptFromMessages(session.messages, this.#lang).reduce(
      (max, item) => Math.max(max, itemTime(item)),
      0,
    );
    this.#meta.set(newId, {
      mode: meta.mode,
      permission: meta.permission,
      thinking: meta.thinking,
      projectId: meta.projectId,
      marks: meta.marks.filter((mark) => mark.at <= until),
    });
    const base =
      live.session.sessionManager.getSessionName()?.trim() || this.#i18n.t("session.name");
    session.setSessionName(`${base} (${suffix})`);
    const infos = await SessionManager.list(cwd, dir);
    const info = infos.find((i) => i.id === newId);
    const summary = info ? this.#summarize(info) : await this.#fallbackSummary(newId, cwd);
    return { ...summary, live: true };
  }

  /** Açık oturumun ilk kullanıcı mesajından türetilen başlık; mesaj yoksa boş. */
  #firstUserTitle(id: string): string {
    const live = this.#live.get(id);
    if (!live) return "";
    const first = transcriptFromMessages(live.session.messages, this.#lang).find(
      (i) => i.type === "user",
    );
    return first?.type === "user" ? deriveSessionTitle(first.text, "") : "";
  }

  async #fallbackSummary(id: string, cwd: string): Promise<SessionSummary> {
    const meta = this.#meta.get(id);
    return {
      id,
      path: this.#paths.get(id) ?? "",
      cwd,
      // Adı verilmiş canlı oturum (ör. koordinatör) klasör adıyla değil kendi adıyla görünür.
      // Adsız yeni sohbet (ilk yanıt henüz diske düşmedi) ilk mesajdan türetilen başlıkla:
      // yanıt akarken liste tazelenince klasör adına dönüyordu.
      name:
        this.#live.get(id)?.session.sessionManager.getSessionName()?.trim() ||
        this.#firstUserTitle(id) ||
        basename(cwd),
      mode: meta.mode,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      messageCount: 0,
      pinned: meta.pinned,
      archived: meta.archived,
      live: this.#live.has(id),
      projectId: meta.projectId,
      auditRunId: meta.audit?.runId ?? null,
      parentSessionId: meta.parentSessionId,
      sideOf: meta.sideOf,
    };
  }

  /**
   * Yan sohbet: ana oturumun o ana kadarki geçmişi yeni bir dala kopyalanır ve dal salt okunur
   * ("plan" izni) açılır. Ana tur sürerken de açılabilir: yarım kalan araç çağrısına Pi sentetik
   * sonuç ekler. Salt okunurluk, ana turla aynı dosyalara yazma yarışını baştan kaldırır; web
   * araçları ve soru aracı yine kullanıcıya sorar. İzin işareti yazılmaz: mod kullanıcının seçimi değil.
   */
  async openSideChat(id: string): Promise<SessionSummary> {
    const summary = await this.forkSession(id);
    this.#meta.set(summary.id, { sideOf: id });
    this.#applyPermission(summary.id, "plan");
    const base =
      this.#require(id).session.sessionManager.getSessionName()?.trim() ||
      this.#i18n.t("session.name");
    const name = `${base} (${this.#i18n.t("session.sideSuffix")})`;
    this.#require(summary.id).session.setSessionName(name);
    return { ...summary, name, sideOf: id };
  }

  isSideChat(id: string): boolean {
    return this.#meta.get(id).sideOf !== null;
  }

  /** Yan sohbeti ayrı oturuma çevirir: listede görünür, izin modu ana oturumunkine döner. */
  async promoteSideChat(id: string): Promise<SessionSummary> {
    if (!this.#live.has(id)) await this.openSession(id);
    const parent = this.#meta.get(id).sideOf;
    this.#meta.set(id, { sideOf: null });
    this.#applyPermission(id, parent ? this.#meta.get(parent).permission : "ask");
    const live = this.#require(id);
    const infos = await SessionManager.list(live.cwd, this.#sessionDir(live.cwd));
    const info = infos.find((i) => i.id === id);
    const summary = info ? this.#summarize(info) : await this.#fallbackSummary(id, live.cwd);
    return { ...summary, live: true };
  }

  /**
   * Önceki çalıştırmadan kalan yan sohbetleri siler (panel kapanmadan uygulama kapandıysa).
   * Açılışta çağrılır; o anda hiçbiri canlı değildir. Silinenlerin kimlikleri döner (main kendi
   * kayıtlarını, iz ve tur yedeğini de temizler).
   */
  async pruneSideChats(): Promise<string[]> {
    const ids = Object.entries(this.#meta.all())
      .filter(([, meta]) => meta.sideOf)
      .map(([id]) => id);
    if (ids.length > 0) await this.listSessions();
    for (const id of ids) await this.deleteSession(id).catch(() => undefined);
    return ids;
  }

  /**
   * Oturum bellekte ya da diskte var mı. Pi oturum dosyasını ilk yanıttan sonra yazar; hiç mesaj
   * almamış bir oturum (ör. boş koordinatör) uygulama yeniden açılınca kaybolur.
   */
  async hasSession(id: string): Promise<boolean> {
    if (this.#live.has(id)) return true;
    try {
      // Yol, oturum açılınca dosya yazılmadan önce de kaydedilir; dosyanın kendisine bakılır.
      return existsSync(await this.#resolvePath(id));
    } catch {
      return false;
    }
  }

  async #resolvePath(id: string): Promise<string> {
    const known = this.#paths.get(id);
    if (known) return known;
    await this.listSessions();
    const found = this.#paths.get(id);
    if (!found) throw new Error(this.#i18n.t("errors.sessionNotFound", { id }));
    return found;
  }

  #require(id: string): LiveSession {
    const live = this.#live.get(id);
    if (!live) throw new Error(this.#i18n.t("errors.sessionNotOpen", { id }));
    return live;
  }

  /** Metin + görselden model gövdesini üretir; ikisi de yoksa boş mesaj hatası verir. */
  async #messageBody(
    text: string,
    images?: readonly ImageAttachment[],
  ): Promise<{ body: string; attachments: ImageContent[] | undefined }> {
    const attachments =
      images && images.length > 0 ? await prepareImages(images, this.#lang) : undefined;
    const body = text.trim() || (attachments ? this.#i18n.t("prompt.lookAtImage") : "");
    if (!body) throw new Error(this.#i18n.t("errors.emptyMessage"));
    return { body, attachments };
  }

  async prompt(id: string, text: string, images?: readonly ImageAttachment[]): Promise<void> {
    const live = this.#require(id);
    const { session } = live;
    const stops = this.#stops.get(id) ?? 0;
    this.#syncAdvisor(id, session);
    // Yeni kullanıcı turu: önceki turun anahtar geçişi ve geçici hata bütçesi taşınmaz.
    this.#rotations.delete(id);
    this.#transient.delete(id);
    this.#transientPending.delete(id);
    // Yeni kullanıcı turu: sıkıştırma devre kesicileri sıfırlanır. Kullanıcı oturumu toparlamış
    // olabilir (geri sardı, dosyaları temizledi); kalıcı bir "artık denemem" kararı yanlış olurdu.
    this.#compactFailures.delete(id);
    this.#rapidRefills.delete(id);
    const { body, attachments } = await this.#messageBody(text, images);
    // prompt() ajan bitene kadar bekler; IPC'yi bloklamamak için beklenmez, hatalar olaya çevrilir.
    // Sıkıştırma da bu zincirin başında: kullanıcı yeni mesajı yazarken bağlam taşmaya yakınsa
    // tur, taşma hatasıyla değil özetle başlar (aşağıdaki `#autoCompact`).
    //
    // Önce önceki koşunun oturması beklenir. Eşleyici `run_end`'i `agent_end`'de yayar, arayüz
    // boşta görünür; Pi ise koşuyu `agent_settled`'a kadar sürdürür (tur sonu kontrolleri,
    // `agent_before_settle`). Bu aralıkta yönlendirme olarak kuyruğa giren mesaj Pi'nin son
    // kuyruk bakışını kaçırırsa kuyrukta asılı kalır; eskiden de `isStreaming` görülüp düşürülüyordu.
    void (async () => {
      await this.#settled(session);
      await this.#autoCompact(id, session);
      if (!this.#stillWanted(id, live, stops, text)) return;
      // Arada başka bir koşu başladıysa (arka plan dürtmesi) mesaj ona yönlendirme olarak girer.
      await sendUserMessage(session, body, attachments);
    })().catch((error: unknown) => {
      this.#emitError(id, error);
    });
  }

  /** Süren koşunun tamamen oturması (`agent_settled` dahil). */
  async #settled(session: AgentSession): Promise<void> {
    await session.waitForIdle();
    // `isStreaming` `agent_settled` yayılmadan biraz önce düşer; bir makro görev beklenir ki
    // eski koşunun `agent_settled`'ı eşleyicide yeni koşuyu kapatmasın.
    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Beklemeden sonra mesaj hâlâ gönderilecek mi. Oturum kapandıysa hayır. Kullanıcı "Durdur"a
   * bastıysa da hayır (iptal ettiği bir işi başlatmış olurdu); arayüz balonu gönderimden önce
   * eklediği için sohbete "gönderilmedi" işareti düşer, yeniden açılışta balon olmadığından
   * işaret mesajın başını taşır.
   */
  #stillWanted(id: string, live: LiveSession, stops: number, text: string): boolean {
    if (this.#live.get(id) !== live) return false;
    if ((this.#stops.get(id) ?? 0) === stops) return true;
    this.#markUnsent(id, text);
    return false;
  }

  /** Sohbete "gönderilmedi" işareti; işaret mesajın başını taşır (balon yeniden açılışta yok). */
  #markUnsent(id: string, text: string): void {
    const flat = text.replace(/\s+/g, " ").trim();
    const excerpt = flat.length > UNSENT_EXCERPT ? `${flat.slice(0, UNSENT_EXCERPT)}…` : flat;
    this.#mark(id, { kind: "unsent", ...(excerpt ? { to: excerpt } : {}) });
  }

  /**
   * Durdur'dan sonra kuyrukta kalanlar: kuyruk temizlenir, her mesaj için "gönderilmedi" işareti
   * düşer. Temizlenmezse Pi onları kullanıcının bir sonraki mesajına ekleyip gönderirdi.
   */
  #dropQueue(id: string, session: AgentSession): void {
    if (session.pendingMessageCount === 0) {
      if ((this.#queueInflight.get(id) ?? 0) === 0) this.#queued.delete(id);
      return;
    }
    for (const message of this.#drainQueue(id, session)) this.#markUnsent(id, message.text);
  }

  /**
   * Bağlam yönetiminin **pahalı** kademesine giden kapı: doluluk eşiği aşmışsa tur başlamadan
   * özet çıkarılır. Eskiden sıkıştırma yalnızca taşma hatası **alındıktan sonra** (reaktif)
   * çalışıyordu; o noktada tur zaten başarısız olmuş, kullanıcı beklemiş ve bir istek boşa
   * gitmiş oluyordu. Ucuz kademe (`microcompact`) eski araç çıktılarını zaten düşürdüğü için
   * buraya yalnızca gerçekten uzun oturumlar gelir.
   *
   * Eşik `AUTO_COMPACT_PERCENT`: sıkıştırmanın kendisi de bağlam ister (özet isteği), pencereyi
   * tıka basa doldurup sıkıştırmayı imkânsız hâle getirmemek için üstte pay bırakılır.
   */
  async #autoCompact(id: string, session: AgentSession): Promise<void> {
    if (session.isStreaming) return;
    // Devre kesici: üst üste başarısız olan sıkıştırma her turda yeniden denenip turu geciktirir.
    // ZCode da aynı sınırı kullanır (3); sayaç başarılı sıkıştırmada ve yeni kullanıcı turunda sıfırlanır.
    if ((this.#compactFailures.get(id) ?? 0) >= MAX_COMPACT_FAILURES) return;
    const usage = session.getContextUsage();
    if (!usage || usage.percent === null || usage.percent < AUTO_COMPACT_PERCENT) return;
    // Hızlı yeniden dolum: sıkıştırma bağlamı indirdi ama birkaç araç turu sonra yine eşiğin
    // üstündeyse sıkıştırma hiçbir şey kazandırmıyor demektir; döngüye girmek yerine durulur.
    if ((this.#rapidRefills.get(id) ?? 0) >= MAX_RAPID_REFILLS) return;
    const before = usage.tokens ?? 0;
    const result = await this.#compactNow(id, session);
    if (!result.ok) return;
    const after = session.getContextUsage()?.tokens ?? 0;
    // Özet gerçekten yer açtı mı: kazanç yoksa (ör. pencere zaten dolu) sayaç artar.
    if (before > 0 && after >= before * RAPID_REFILL_RATIO) {
      this.#rapidRefills.set(id, (this.#rapidRefills.get(id) ?? 0) + 1);
    } else {
      this.#rapidRefills.set(id, 0);
    }
  }

  /**
   * Sıkıştırmayı şimdi çalıştırır (eşik bakmadan). Koşan sıkıştırma varsa onu bekler.
   * `true` dönerse sıkıştırma tamamlandı.
   */
  async #compactNow(
    id: string,
    session: AgentSession,
  ): Promise<{ ok: boolean; reason?: CompactFailureReason; detail?: string }> {
    // Koşan sıkıştırma varsa o beklenir. İki sıkıştırma üst üste binerse Pi'nin `compact()`
    // başındaki `abort()` birincisini iptal eder; kullanıcı da bu arada ikinci mesajı gönderip
    // (arayüz "boşta" görünürken) ikinci bir sıkıştırma başlatabilir.
    const running = this.#compacting.get(id);
    if (running) return running;
    if (session.isStreaming) return { ok: false, reason: "busy" };
    // Sıkıştırma sürerken arayüz "boşta" görünmesin: süren bir tur gibi işaretlenir.
    this.#outsideRunBusy.add(id);
    this.bus.emit({ type: "status", sessionId: id, at: Date.now(), status: "working" });
    const task = (async () => {
      try {
        await session.compact();
        this.#compactFailures.set(id, 0);
        return { ok: true };
      } catch (error) {
        // Sıkıştırma başarısızsa tur yine de sürer: reaktif yol (taşma hatası) yedek olarak durur.
        // Sebep **saklanmaz**: otomatik yolda kullanıcıya gösterilmez ama elle istendiğinde
        // ne olduğunu söyleyebilmek gerekir (aksi hâlde "özetlenemedi"den başka bilgi kalmaz).
        const raw = error instanceof Error ? error.message : String(error);
        const noop = compactNoopReason(raw);
        // "Yapacak iş yok" durumları arıza sayılmaz: devre kesici sayacını artırmazlar.
        if (!noop) this.#compactFailures.set(id, (this.#compactFailures.get(id) ?? 0) + 1);
        return {
          ok: false,
          reason: noop ?? "failed",
          ...(noop ? {} : { detail: maskSecrets(raw).slice(0, 300) }),
        };
      } finally {
        this.#compacting.delete(id);
        // Doluluk özetten sonra yeniden yayınlanır: eşik altına indiği arayüzde görünsün.
        this.#lastContext.delete(id);
        // Yayılan "çalışıyor" **her** çıkışta kapatılır: başarıda, hatada ve no-op'ta. Bir tur
        // bu arada başladıysa (arka plan dürtmesi) durumu o tur yönetir; ona dokunulmaz.
        if (this.#outsideRunBusy.delete(id) && !session.isStreaming) {
          this.bus.emit({ type: "status", sessionId: id, at: Date.now(), status: "idle" });
        }
      }
    })();
    this.#compacting.set(id, task);
    return task;
  }

  /**
   * Kullanıcının istediği sıkıştırma (`/compact`). Eşik bakılmaz: kararı kullanıcı verdi.
   * Tur sürerken reddedilir — Pi `compact()` başında `abort()` çağırdığı için süren turu
   * keserdi; kullanıcıya ne yapacağı söylenir.
   */
  async compactNow(id: string): Promise<CompactResult> {
    const live = this.#live.get(id);
    if (!live) return { ok: false, reason: "not-open" };
    if (live.session.isStreaming) return { ok: false, reason: "busy" };
    const result = await this.#compactNow(id, live.session);
    // İşaret yalnız gerçekten denenmiş sıkıştırmada yazılır: "meşgul" bir sonuç değil, reddir
    // (kullanıcı `/compact` dedi ve tur sürüyordu); sohbete "özetlendi" satırı düşmesi yanıltırdı.
    if (result.ok || result.reason !== "busy") {
      this.#mark(id, {
        kind: "compact",
        outcome: result.ok ? "done" : result.reason === "failed" ? "failed" : "noop",
      });
    }
    if (!result.ok) return result;
    const usage = live.session.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return { ok: true };
    return {
      ok: true,
      context: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent },
    };
  }

  async steer(id: string, text: string, images?: readonly ImageAttachment[]): Promise<void> {
    await this.#enqueue(id, "steer", text, images);
  }

  /**
   * Kuyruğa alınan mesaj: ajanın işi tamamen bitince ayrı tur olarak işlenir (Pi followUp).
   * Akışta değilken kuyruğu işleyecek tur olmadığından doğrudan yeni tur başlatılır.
   */
  async followUp(id: string, text: string, images?: readonly ImageAttachment[]): Promise<void> {
    await this.#enqueue(id, "followUp", text, images);
  }

  /**
   * Yönlendirme ya da takip mesajını Pi kuyruğuna koyar. Oturum akışta değilse Pi mesajı kuyrukta
   * tutar ve turu başlatan olmaz: yeni tur olarak gönderilir.
   *
   * Akış denetimi başta yapılır, mesaj ise görsel hazırlığı ve Pi'nin girdi işleyicilerinden sonra
   * kuyruğa girer; Pi bu arada oturursa mesaj başlatanı olmayan kuyrukta kalır ve ancak bir sonraki
   * kullanıcı mesajıyla gider. Kuyruk bekçisi (`#watchQueue`) bunu yakalar.
   */
  async #enqueue(
    id: string,
    kind: QueuedMessage["kind"],
    text: string,
    images?: readonly ImageAttachment[],
  ): Promise<void> {
    const live = this.#require(id);
    const { session } = live;
    if (!session.isStreaming) return this.prompt(id, text, images);
    const stops = this.#stops.get(id) ?? 0;
    this.#queueInflight.set(id, (this.#queueInflight.get(id) ?? 0) + 1);
    try {
      const { body, attachments } = await this.#messageBody(text, images);
      const records = this.#queued.get(id) ?? [];
      const record: QueuedMessage = { kind, text, body, images: images ? [...images] : undefined };
      records.push(record);
      this.#queued.set(id, records);
      try {
        if (kind === "steer") await session.steer(body, attachments);
        else await session.followUp(body, attachments);
      } catch (error) {
        // Pi reddettiyse (eklenti komutu, girdi işleyicisi) kayıt da düşer: sondan eşlemede
        // asılı kalan gerçek mesajın yerine geçmesin.
        records.splice(records.indexOf(record), 1);
        throw error;
      }
    } finally {
      this.#queueInflight.set(id, (this.#queueInflight.get(id) ?? 1) - 1);
    }
    this.#watchQueue(id, live, stops);
  }

  /**
   * Kuyruk bekçisi: koşu oturduğunda Pi kuyruğunda mesaj kaldıysa kuyruk boşaltılır ve mesajlar
   * yeni tur olarak gönderilir (`prompt`). Oturum başına tek bekçi çalışır; sonraki mesajlar onu
   * kullanır. Durdur'a basıldıysa kuyruk işletilmez, temizlenir ve her mesaj için "gönderilmedi"
   * işareti düşer.
   */
  #watchQueue(id: string, live: LiveSession, stops: number): void {
    if (this.#queueWatch.has(id)) return;
    this.#queueWatch.add(id);
    const { session } = live;
    void (async () => {
      try {
        for (;;) {
          await this.#settled(session);
          if (this.#live.get(id) !== live) return;
          // Arada yeni koşu başladı: Pi kuyruğu koşu başında ya da sonunda kendisi boşaltır.
          if (session.isStreaming) continue;
          // Kuyruğa koyma süren bir çağrı var: kayıt Pi kuyruğuyla henüz eşleşmiyor. O çağrı
          // bitince bekçiyi kendisi kurar.
          if ((this.#queueInflight.get(id) ?? 0) > 0) return;
          if ((this.#stops.get(id) ?? 0) !== stops) {
            this.#dropQueue(id, session);
            return;
          }
          if (session.pendingMessageCount === 0) {
            this.#queued.delete(id);
            return;
          }
          const stuck = this.#joinQueued(this.#drainQueue(id, session));
          // `prompt` koşu oturmasını bekler ve kendi Durdur denetimini yapar; bekçi bir sonraki
          // turda boş kuyruğu görüp çıkar.
          await this.prompt(id, stuck.text, stuck.images);
        }
      } finally {
        this.#queueWatch.delete(id);
      }
    })().catch((error: unknown) => {
      this.#emitError(id, error);
    });
  }

  /**
   * Pi kuyruğunu boşaltıp kalan mesajları döndürür (önce yönlendirmeler, sonra takipler). Pi
   * kuyruğu yalnız metni verir; görseller motorun kaydından gelir. Eşleme Pi'ye verilen metinle,
   * sondan yapılır: kalanlar en yeni mesajlardır, aynı metinli eski (teslim edilmiş) kayıt seçilmez.
   * Pi `/` ile başlamayan metni değiştirmeden saklar; eşleşmeyen (genişletilmiş ya da başka yoldan
   * kuyruğa girmiş) mesajda Pi'nin metni kullanılır. Kuyruğa koyması süren çağrının kaydı henüz
   * Pi kuyruğunda olmadığı için eşleşmez ve kayıtta kalır.
   */
  #drainQueue(id: string, session: AgentSession): QueuedMessage[] {
    const { steering, followUp } = session.clearQueue();
    const records = [...(this.#queued.get(id) ?? [])];
    const pick = (kind: QueuedMessage["kind"], texts: readonly string[]): QueuedMessage[] => {
      const out: QueuedMessage[] = [];
      for (let i = texts.length - 1; i >= 0; i--) {
        const text = texts[i] ?? "";
        const at = records.findLastIndex((r) => r.kind === kind && r.body === text);
        const [own] = at >= 0 ? records.splice(at, 1) : [];
        out.unshift(own ?? { kind, text, body: text });
      }
      return out;
    };
    const stuck = [...pick("steer", steering), ...pick("followUp", followUp)];
    if ((this.#queueInflight.get(id) ?? 0) > 0 && records.length > 0) this.#queued.set(id, records);
    else this.#queued.delete(id);
    return stuck;
  }

  /** Kuyruktan kalan mesajlar tek yeni tur olarak gider: metinler alt alta, görseller sırayla. */
  #joinQueued(stuck: readonly QueuedMessage[]): { text: string; images?: ImageAttachment[] } {
    const text = stuck
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
    const images = stuck.flatMap((m) => m.images ?? []);
    return images.length > 0 ? { text, images } : { text };
  }

  /**
   * Bekleyen yönlendirme/takip mesajlarını temizler. Pi ayrıca `queue_update` yayar; burada
   * dönen içerikle anında `queue` olayı da yayılır ki arayüz aynı karede boşalsın.
   */
  clearQueue(id: string): void {
    const { session } = this.#require(id);
    const { steering, followUp } = session.clearQueue();
    this.#queued.delete(id);
    this.bus.emit({
      type: "queue",
      sessionId: id,
      at: Date.now(),
      steering: [...steering],
      followUp: [...followUp],
    });
  }

  /**
   * Kalıcı hedef yönetimi (`sessions:goal`). `set` hedefi kaydeder ve ilk turu başlatan görünür
   * mesajı gönderir (direktif bloğu içinde); goal uzantısı bundan sonraki her tur sonunda sentinel
   * arar ve hedef bitene dek gizli "Continue." dürtmesiyle devam eder.
   */
  goal(
    id: string,
    action: "set" | "stop" | "pause" | "resume",
    text?: string,
    maxIter?: number,
  ): void {
    if (action === "set") {
      const trimmed = text?.trim();
      if (!trimmed) throw new Error(this.#i18n.t("errors.goalEmpty"));
      const goal = {
        text: trimmed,
        iter: 0,
        maxIter: maxIter ?? 30,
        createdAt: Date.now(),
        paused: false,
      };
      this.#meta.set(id, { goal });
      const goalState: GoalState = {
        text: goal.text,
        iter: goal.iter,
        maxIter: goal.maxIter,
        paused: goal.paused,
      };
      this.bus.emit({
        type: "goal",
        sessionId: id,
        at: Date.now(),
        goal: goalState,
        note: "set",
      });
      const live = this.#require(id);
      const stops = this.#stops.get(id) ?? 0;
      const kickoff = `${this.#i18n.t("prompt.goalKickoff")}\n\n${buildGoalDirective({
        text: goal.text,
        iter: 0,
        maxIter: goal.maxIter,
      })}`;
      // `prompt` ile aynı: tur sonu penceresinde kuyruğa giren mesaj asılı kalabilir.
      void (async () => {
        await this.#settled(live.session);
        if (!this.#stillWanted(id, live, stops, goal.text)) return;
        await sendUserMessage(live.session, kickoff);
      })().catch((error: unknown) => {
        this.#emitError(id, error);
      });
      return;
    }
    if (action === "stop") {
      this.#clearGoal(id, "stopped");
      return;
    }
    const goal = this.#meta.get(id).goal;
    if (!goal) throw new Error(this.#i18n.t("errors.noActiveGoal"));
    if (action === "pause") {
      if (!goal.paused) {
        this.#meta.set(id, { goal: { ...goal, paused: true } });
        this.bus.emit({
          type: "goal",
          sessionId: id,
          at: Date.now(),
          goal: { ...goal, paused: true },
          note: "paused",
        });
      }
      return;
    }
    // resume: duraklatmayı kaldır ve hedefi gizli devam dürtmesiyle yeniden başlat.
    if (goal.paused) {
      const resumed = { ...goal, paused: false };
      this.#meta.set(id, { goal: resumed });
      this.bus.emit({
        type: "goal",
        sessionId: id,
        at: Date.now(),
        goal: resumed,
        note: "resumed",
      });
    }
    const pi = this.#pi.get(id);
    if (!pi) throw new Error(this.#i18n.t("errors.sessionNotOpen", { id }));
    this.#nudge(pi, "goal", this.#goalContinueText(goal.text, goal.iter, goal.maxIter));
  }

  async abort(id: string): Promise<void> {
    // Hatayla biten turun sürdürülmesi (yeniden deneme beklemesi, anahtar geçişi) de durur:
    // beklemede Durdur'a basılınca süre dolduğunda tur yine devam ediyordu. Gizlenen hata da
    // bant olarak düşmez; kullanıcı zaten durdurdu.
    this.#resumeAborts.get(id)?.abort();
    if (this.#live.has(id)) this.#stops.set(id, (this.#stops.get(id) ?? 0) + 1);
    this.#transientPending.delete(id);
    const rotation = this.#rotations.get(id);
    if (rotation) rotation.resume = false;
    this.#heldError.delete(id);
    this.permissions.rejectAll(id);
    this.plans.rejectAll(id);
    this.questions.rejectAll(id);
    this.#live.get(id)?.ui.cancelAll();
    const live = this.#require(id);
    // Araç sürerken durdurulan turun iptal edilmiş model isteği hata bandı olarak düşmez.
    live.mapper.noteStop();
    await live.session.abort();
    // Kuyrukta bekleyen yönlendirme/takip de durur: Pi onları bir sonraki kullanıcı mesajına
    // ekleyip gönderirdi. Kuyruğa koyması süren çağrılarınkini bekçi temizler.
    this.#dropQueue(id, live.session);
    // Emniyet kemeri: Durdur, kullanıcının kaçış kapısıdır ve **sessiz bir no-op olmamalı**.
    // Süren bir koşu yoksa Pi `abort()` hiçbir olay yaymaz; arayüz "çalışıyor"da kalır ve
    // kullanıcı ne olduğunu anlamadan kilitlenir (yaşandı: sıkıştırma "çalışıyor" yayıp
    // temizlemediği için Durdur işe yaramıyordu). Bu yüzden koşu yoksa durum her hâlükârda
    // "boşta"ya çekilir.
    //
    // Fazladan `idle` yaymak güvenli: `run_end` tur kapsamlı olay listesinde değildir, yani
    // ardından gelen gerçek `run_end` yine işlenir ve tur düzgün kapanır.
    this.#outsideRunBusy.delete(id);
    if (!live.session.isStreaming) {
      this.bus.emit({ type: "status", sessionId: id, at: Date.now(), status: "idle" });
    }
    // Kullanıcı kontrolü geri aldı: kalıcı hedef temizlenir (legacy davranışı).
    this.#clearGoal(id, "stopped");
  }

  async setModel(id: string, ref: ModelRef): Promise<void> {
    const runtime = await this.runtime();
    const model = runtime.getModel(ref.provider, ref.id);
    if (!model)
      throw new Error(this.#i18n.t("errors.modelNotFound", { ref: `${ref.provider}/${ref.id}` }));
    const live = this.#require(id);
    const before = this.#modelRefOf(live.session);
    this.#applyRetrySettings(live.settingsManager, ref.provider);
    await live.session.setModel(model);
    // Aynı model yeniden seçilirse satır yazılmaz: işaret yalnız gerçek geçişi anlatır.
    const changed = !before || before.provider !== ref.provider || before.id !== ref.id;
    if (changed) {
      this.#mark(id, {
        kind: "model",
        ...(before ? { from: modelLabel(before) } : {}),
        to: modelLabel(ref),
      });
    }
  }

  setThinking(id: string, level: ThinkingLevel): void {
    const live = this.#require(id);
    const before = this.#thinkingOf(live.session);
    live.session.setThinkingLevel(level);
    // Kalıcı kopya: Pi oturum dosyası seviyeyi taşımadığı için açılışta buradan verilir.
    this.#meta.set(id, { thinking: level });
    if (before !== level) this.#mark(id, { kind: "thinking", from: before, to: level });
  }

  /** İzin modunu oturuma ve meta'ya yazar. İşaret yazmaz: çağıran karar verir. */
  #applyPermission(id: string, permission: PermissionMode): void {
    const live = this.#require(id);
    live.permission = permission;
    // Kullanıcı çipten plandan çıktıysa modelin sakladığı dönüş modu anlamsızlaşır.
    if (permission !== "plan") live.planReturnTo = undefined;
    this.#meta.set(id, { permission });
  }

  setPermission(id: string, permission: PermissionMode): void {
    const before = this.#require(id).permission;
    this.#applyPermission(id, permission);
    if (before !== permission) {
      this.#mark(id, { kind: "permission", from: before, to: permission });
    }
  }

  /**
   * Yerel komut işareti (ZCode'un timelineMarker satırı): meta'ya yazılır (oturum yeniden açılınca
   * transkripte karışsın) ve yayınlanır (açık ekranda satır aynı karede belirsin). Kimlik ve zaman
   * burada üretilir; renderer yalnız çizer, kayıt dile bağlı değildir.
   */
  #mark(
    id: string,
    mark: { kind: MarkerKind; from?: string; to?: string; outcome?: "done" | "noop" | "failed" },
  ): void {
    const item: MarkerItem = {
      type: "marker",
      id: `mk-${randomUUID()}`,
      at: Date.now(),
      kind: mark.kind,
      ...(mark.from === undefined ? {} : { from: mark.from }),
      ...(mark.to === undefined ? {} : { to: mark.to }),
      ...(mark.outcome === undefined ? {} : { outcome: mark.outcome }),
    };
    this.#meta.mark(id, {
      id: item.id,
      kind: item.kind,
      at: item.at,
      ...(item.from === undefined ? {} : { from: item.from }),
      ...(item.to === undefined ? {} : { to: item.to }),
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
    });
    this.bus.emit({ type: "marker", sessionId: id, at: item.at, marker: item });
  }

  /**
   * Açılışta işaretleri transkripte zaman sırasına karıştırır. İşaretler Pi'nin oturum dosyasında
   * değil meta'da durur; karıştırma `at` ile yapılır ve eşitlikte transkript sırası korunur
   * (kararlı birleştirme), böylece canlı akışta görünen sıra yeniden açılışta bozulmaz.
   */
  /**
   * Durdurulan çağrıyı oturum dosyasına yazar: yeniden açılışta kart "hata" değil
   * "engellendi"/"reddedildi"/"durduruldu" görünsün. Yazılamazsa yalnız açılıştaki etiket kaybolur.
   */
  #recordStop(session: AgentSession, toolCallId: string, reason: ToolStop): void {
    try {
      session.sessionManager.appendCustomEntry(TOOL_STOP_TYPE, { toolCallId, reason });
    } catch (error) {
      this.config.log?.("warn", "engine", `araç durdurma kaydı yazılamadı: ${String(error)}`);
    }
  }

  /** Renderer'a giden transkript: durdurulan çağrıların durumu ve işaretler uygulanmış. */
  #transcriptOf(id: string, session: AgentSession): TranscriptItem[] {
    const stops = toolStopsOf(session.sessionManager.getEntries());
    return this.#withMarks(id, transcriptFromMessages(session.messages, this.#lang, stops));
  }

  #withMarks(id: string, items: TranscriptItem[]): TranscriptItem[] {
    const marks = this.#meta.get(id).marks;
    if (marks.length === 0) return items;
    const merged: TranscriptItem[] = [];
    let i = 0;
    for (const mark of marks) {
      while (i < items.length) {
        const item = items[i];
        if (!item || itemTime(item) > mark.at) break;
        merged.push(item);
        i += 1;
      }
      merged.push({ type: "marker", ...mark });
    }
    merged.push(...items.slice(i));
    return merged;
  }

  /** Model kaynaklı mod değişimi: oturuma yazılır ve çip güncellensin diye renderer'a bildirilir. */
  #switchPermission(id: string, permission: PermissionMode): void {
    // İşaret yazılmaz: plan moduna giriş zaten plan kartıyla görünür; satır kullanıcının
    // kendi seçimidir (çip ya da `/mod`).
    this.#applyPermission(id, permission);
    this.bus.emit({ type: "permission_mode", sessionId: id, at: Date.now(), mode: permission });
  }

  /** `plan_enter`: önceki mod saklanır, plan klasörü hazırlanır (tur ortasında da yazılabilsin). */
  #enterPlan(id: string, cwd: string): void {
    const live = this.#require(id);
    if (live.permission === "plan") return;
    live.planReturnTo = live.permission;
    const path = this.planPath(id, cwd);
    if (path) mkdirSync(dirname(path), { recursive: true });
    this.#switchPermission(id, "plan");
  }

  /**
   * `plan_exit`: plan onay kartına gider; onaylanırsa oturum `plan_enter` öncesi moda (elle girilen
   * planda "Sor") döner ve model aynı turda uygulamaya geçer. İptalde plan uygulanmaz, plan
   * modundan çıkılır ve tur durdurulur. Gözetimsiz oturumda sorulmadan ret.
   */
  async #reviewPlan(id: string, plan: string, path: string): Promise<PlanDecision> {
    const live = this.#require(id);
    if (this.permissions.isUnattended(id))
      return { approved: false, feedback: this.#i18n.t("permission.unattended") };
    const returnTo = live.planReturnTo ?? "ask";
    const decision = await this.plans.request(id, plan, path, returnTo);
    if (decision.approved) {
      live.planReturnTo = undefined;
      this.#switchPermission(id, returnTo);
    } else if (decision.cancelled) {
      // Kullanıcı plandan vazgeçti: plan modundan çıkılır ve tur durdurulur (durdurma butonuyla
      // aynı yol: bekleyen izin/soru istekleri de düşer). Durdurma yeni bir göreve bırakılır:
      // `plan_exit` aracının sonucu Pi'ye dönmeden turu kesmek araç akışını yarıda bırakırdı.
      live.planReturnTo = undefined;
      this.#switchPermission(id, returnTo);
      // Oturum bu arada kapanmış olabilir: red yutulur, durdurulacak bir şey kalmamıştır.
      queueMicrotask(() => {
        this.abort(id).catch(() => undefined);
      });
    }
    return decision;
  }

  respondPlan(requestId: string, decision: PlanDecision): boolean {
    return this.plans.respond(requestId, decision);
  }

  /**
   * `question`: kullanıcıya sorar. Gözetimsiz oturumda (zamanlanmış görev) soruyu cevaplayacak
   * kimse yok; boş yanıt döner ve tur asılı kalmaz (plan onayıyla aynı dal).
   */
  #askQuestions(id: string, questions: QuestionItem[]): Promise<QuestionAnswers> {
    if (this.permissions.isUnattended(id)) return Promise.resolve(questions.map(() => []));
    return this.questions.request(id, questions);
  }

  respondQuestion(requestId: string, answers: QuestionAnswers): boolean {
    return this.questions.respond(requestId, answers);
  }

  async rename(id: string, name: string): Promise<void> {
    if (!this.#live.has(id)) await this.openSession(id);
    this.#require(id).session.setSessionName(name);
  }

  /**
   * Adsız oturuma kısa bir başlık verir; main ilk üç turda, yanıt akmaya başlayınca (ve yedek
   * olarak tur bitince) çağırır. Eskiden liste ve
   * başlık çubuğu ilk mesajın ham ilk satırını gösteriyordu ("codezal hakkında bir twit…").
   * Üç tur: ilk tur Esc ile durdurulur ya da hata alırsa sonraki tur telafi eder; ad bir kez
   * yazılınca bir daha denenmez (her yanıttan sonra değişen başlık listede oynardı). Ad elle
   * verilmişse (ya da üretim sürerken verildiyse) dokunulmaz; başarısızsa türetilmiş başlık kalır.
   * Verilen başlığı döner.
   */
  async autoTitle(id: string): Promise<string | undefined> {
    const live = this.#live.get(id);
    if (!live || live.session.sessionManager.getSessionName()?.trim()) return undefined;
    return this.#titleOnce(id, false);
  }

  /**
   * Başlığı son mesajlara göre yeniden üretir (menüdeki "Başlığı yeniden üret"): mevcut ad, elle
   * verilmiş olsa bile değişir — kullanıcı açıkça istedi. Kapalı oturum önce açılır. Üretim
   * başarısızsa hata fırlatır; arayüz bildirir.
   */
  async regenerateTitle(id: string): Promise<string> {
    if (!this.#live.has(id)) await this.openSession(id);
    const title = await this.#titleOnce(id, true);
    if (!title) throw new Error(this.#i18n.t("errors.titleFailed"));
    return title;
  }

  async #titleOnce(id: string, force: boolean): Promise<string | undefined> {
    const live = this.#live.get(id);
    const model = live ? this.#modelRefOf(live.session) : undefined;
    if (!live || !model) return undefined;
    // Alt ajan / alt oturum başlığını çağıran verir; kullanıcı listesinde de görünmez.
    const meta = this.#meta.get(id);
    if (meta.parentSessionId || meta.sideOf) return undefined;
    // `run_end` aynı tur için ikinci kez gelebilir (agent_settled yedeği): ikinci çağrı ad henüz
    // yazılmadığından kontrolü geçer ve ücretli bir tamamlama daha açardı.
    if (this.#titling.has(id)) return undefined;
    this.#titling.add(id);
    try {
      const items = transcriptFromMessages(live.session.messages, this.#lang);
      const t = this.#i18n.t;
      const prompt = titlePrompt(
        items.flatMap((i) => (i.type === "user" ? [i.text] : [])),
        this.lastAssistantText(id),
        { user: t("prompt.sessionTitleUser"), reply: t("prompt.sessionTitleReply") },
      );
      if (!prompt) return undefined;
      const title = cleanGeneratedTitle(
        await this.complete(model, t("prompt.sessionTitle"), prompt),
      );
      // Model yanıt verirken oturum kapanmış ya da kullanıcı adı elle değiştirmiş olabilir.
      const now = this.#live.get(id);
      if (!title || !now) return undefined;
      if (!force && now.session.sessionManager.getSessionName()?.trim()) return undefined;
      now.session.setSessionName(title);
      return title;
    } finally {
      this.#titling.delete(id);
    }
  }

  /**
   * Turun dosya değişikliklerini (`edit`/`write`, `bash`, aynı klasörde çalışan alt ajanlar) tur
   * öncesi yedeğinden geri alır. Yedek yoksa (eski oturum, kapalı özellik) hata verir; `except`
   * verilirse (git tabanlı geri alma zaten iş yaptı) o yollar atlanır ve yedek yokluğu hata
   * sayılmaz.
   */
  undoTurnFiles(
    id: string,
    userOrdinal: number,
    except?: ReadonlySet<string>,
  ): { restored: string[]; removed: string[]; skipped: string[]; partial: boolean } {
    const store = this.#snapshots;
    if (!store?.has(id, userOrdinal)) {
      if (except) return { restored: [], removed: [], skipped: [], partial: false };
      throw new Error(this.#i18n.t("errors.noSnapshot"));
    }
    return store.restore(id, userOrdinal, except);
  }

  /**
   * Oturuma ait bütün çalışma zamanı durumunu bırakır. Kapanış ve silme yolları buradan geçer:
   * daha önce her yol kendi listesini temizlediği için silinen oturumun arka plan süreçleri,
   * eklenti köprüsü (`#pi`), denetim oturumu (`#audits`), dürtme sayaçları ve grup bağı
   * bellekte kalıyordu — sahipsiz `pnpm dev` süreci ve oturum başına büyüyen haritalar.
   */
  #forgetSession(id: string): void {
    const live = this.#live.get(id);
    if (live) {
      live.unsubscribe();
      live.session.dispose();
      live.ui.cancelAll();
      // Sahipsiz süreç bırakma: oturumun arka plan görevleri süreç ağacıyla kapanır.
      this.#background.forgetSession(id);
      this.#live.delete(id);
      this.permissions.clearSession(id);
      this.plans.rejectAll(id);
      this.questions.rejectAll(id);
    }
    this.#tracers.delete(id);
    this.#rotations.delete(id);
    this.#lastContext.delete(id);
    this.#widgetWarned.delete(id);
    this.#heldError.delete(id);
    this.#blockedTools.delete(id);
    this.#transient.delete(id);
    this.#transientPending.delete(id);
    this.#compacting.delete(id);
    this.#compactFailures.delete(id);
    this.#rapidRefills.delete(id);
    this.#advisorHidden.delete(id);
    this.#outsideRunBusy.delete(id);
    this.#stops.delete(id);
    this.#queued.delete(id);
    this.#queueInflight.delete(id);
    this.#pi.delete(id);
    this.#checkpointRoutes.delete(id);
    this.#outputsDirs.delete(id);
    this.#bashCheckpoints?.forgetSession(id);
    this.#audits.delete(id);
    this.mcp.forgetSession(id);
  }

  async deleteSession(id: string): Promise<void> {
    // Ajan koşularının oturumları ana oturumla birlikte gider: kenar çubuğunda görünmedikleri için
    // başka bir yoldan silinemezler.
    const children = this.runs
      .list(id)
      .map((run) => run.sessionId)
      .filter((child): child is string => child !== null && child !== id);
    this.runs.forget(id);
    for (const child of children) await this.deleteSession(child).catch(() => undefined);
    // Yan sohbetler de ana oturumla gider; listede görünmedikleri için başka yoldan silinemezler.
    const sides = Object.entries(this.#meta.all())
      .filter(([, meta]) => meta.sideOf === id)
      .map(([side]) => side);
    for (const side of sides) await this.deleteSession(side).catch(() => undefined);
    this.#snapshots?.clear(id);
    this.#abortReview(id);
    this.#forgetSession(id);
    const path = this.#paths.get(id);
    // Windows'ta NDJSON dosyası kilitli olabilir; kısa beklemeyle yinelenir, olmazsa bırakılır.
    if (path) removeQuietly(path);
    this.#paths.delete(id);
    this.#meta.delete(id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.#meta.set(id, { pinned });
  }

  setArchived(id: string, archived: boolean): void {
    this.#meta.set(id, { archived });
  }

  /** Arşivlenmiş tüm oturumları kalıcı siler; silinen sayısını döner. */
  async purgeArchived(): Promise<number> {
    const all = await this.listSessions();
    let n = 0;
    for (const s of all) {
      if (s.archived) {
        await this.deleteSession(s.id);
        n++;
      }
    }
    return n;
  }

  /** Oturumu kapatır (bellekten çıkarır), dosyası kalır. */
  closeSession(id: string): void {
    this.#abortReview(id);
    this.#forgetSession(id);
  }

  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  cwdOf(id: string): string | undefined {
    return this.#live.get(id)?.cwd;
  }

  /**
   * Oturumda yazılmış kullanıcı mesajı sayısı — arayüzün "tur sırası" dediği şey; dosya yedekleri
   * ve geri sarma aynı kuralla sayar. Yalnızca tur **bittiğinde** kesindir: `run_start` anında yeni
   * mesaj henüz `session.messages` listesine girmez (ajan döngüsünün ilk adımında eklenir), o anda
   * okunsa bir eksik çıkardı.
   */
  userTurnCount(id: string): number {
    const live = this.#live.get(id);
    if (!live) return 0;
    return live.session.messages.filter((m) => m.role === "user").length;
  }

  /** Oturumun son asistan metnini döner (zamanlanmış görev sonucu için). */
  lastAssistantText(id: string): string {
    const live = this.#live.get(id);
    if (!live) return "";
    const items = transcriptFromMessages(live.session.messages, this.#lang);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.type === "assistant") return it.text;
    }
    return "";
  }

  /** prompt() bitene kadar bekleyen sürüm (zamanlayıcı için). */
  async promptAndWait(id: string, text: string): Promise<void> {
    const { session } = this.#require(id);
    this.#syncAdvisor(id, session);
    // Önce süren koşu oturur (`prompt` ile aynı gerekçe): tur sonu penceresinde yönlendirme
    // kuyrukta asılı kalabilir, zamanlayıcı da işi yapılmış sanırdı.
    await session.waitForIdle();
    await sendUserMessage(session, text);
    await session.waitForIdle();
  }

  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    return this.permissions.respond(requestId, decision);
  }

  #emitError(sessionId: string, error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    // Sebep kodla taşınır: tanı paketi ve olay izi serbest metne göre sayım yapamaz.
    const { message, reason } = explainProviderErrorWithReason(raw, this.#lang);
    const at = Date.now();
    const events: AgentEventInput[] = [
      { type: "error", sessionId, at, message, reason },
      { type: "status", sessionId, at, status: "idle" },
    ];
    for (const e of events) this.bus.emit(e);
  }

  async dispose(): Promise<void> {
    // Tek yol: her oturum kapanış yoluyla bırakılır, sonra kalan haritalar boşaltılır. Elle
    // temizlenen liste eksik kaldığında (denetim oturumları, dürtme sayaçları) uygulama kapanana
    // kadar bellekte kalıyordu. Ayrık koşular önce durur: oturumları aşağıda kapanır.
    this.runs.dispose();
    for (const stops of this.#subagentStops.values()) for (const stop of stops.values()) stop();
    this.#subagentStops.clear();
    for (const [id] of this.#live) {
      this.#abortReview(id);
      this.#forgetSession(id);
    }
    this.#live.clear();
    this.#tracers.clear();
    this.#pi.clear();
    this.#audits.clear();
    this.#transient.clear();
    this.#transientPending.clear();
    this.#compacting.clear();
    this.#compactFailures.clear();
    this.#rapidRefills.clear();
    this.#outsideRunBusy.clear();
    this.#rotations.clear();
    this.#lastContext.clear();
    this.#heldError.clear();
    this.#widgetWarned.clear();
    this.#blockedTools.clear();
    this.#background.dispose();
    this.#mcpToolsUnsub();
    await this.mcp.dispose();
  }
}
