import { z } from "zod";
import { WorkerInfo, WorkerReviewDecision } from "./agent-runs.js";
import { AgentCatalog, AgentDraft, AgentInfo } from "./agents.js";
import { AuditStartOptions, AuditView } from "./audit.js";
import {
  LogLine,
  LogTailRequest,
  LogTailResponse,
  PerfRecordRequest,
  PerfSummary,
} from "./diagnostics.js";
import {
  CatalogModel,
  CredentialRotation,
  GoalState,
  ImageAttachment,
  ModelRef,
  OpenWithApp,
  PermissionMode,
  ProjectRef,
  ProviderInfo,
  ProviderQuota,
  SESSION_SEARCH_MAX,
  SESSION_SEARCH_MIN,
  SessionOptions,
  SessionSearchHit,
  SessionSummary,
  ThinkingLevel,
} from "./domain.js";
import {
  AgentEvent,
  BackgroundJob,
  ContextUsage,
  PermissionDecision,
  PermissionRequest,
  PlanDecision,
  PlanReview,
  QuestionAnswers,
  QuestionRequest,
  SubagentRun,
  SubagentTrace,
  Usage,
} from "./events.js";
import { ResolvedHook } from "./hooks.js";
import { McpConnector, McpNativeService, McpToolPolicy } from "./mcp.js";
import { ExtensionUiValue } from "./plugins.js";
import { ReviewOutcome } from "./review.js";
import {
  AppSettings,
  AppSettingsPatch,
  AssistantProject,
  MemoryDraft,
  MemoryEntry,
  MemoryScope,
  ProjectConfig,
  ScheduledTask,
  UsageEntry,
} from "./settings.js";
import { SkillCatalog } from "./skills.js";
import { TranscriptItem } from "./transcript.js";
import { UpdateStatus } from "./update.js";
import {
  CheckResult,
  FileContent,
  FileNode,
  GitBranch,
  GitStatus,
  TerminalInfo,
  WorktreeInfo,
} from "./workspace.js";

/**
 * IPC sözleşmesi. Her kanal: istek şeması + yanıt şeması.
 * Main tarafı `invoke` handler'larını, preload/renderer tarafı tipli istemciyi buradan türetir.
 */
export const ipcContract = {
  "app:version": {
    req: z.void(),
    res: z.object({ app: z.string(), electron: z.string(), pi: z.string() }),
  },
  /** Günlük dosyasını (userData/logs/codezal.log) sistem editöründe açar. */
  "app:openLogs": { req: z.void(), res: z.void() },
  /** Günlük halka tamponundan son satırlar; Tanılama sayfası açılışta çeker. */
  "app:logTail": { req: LogTailRequest, res: LogTailResponse },
  /** Canlı günlük akışını açar/kapatır; yalnızca izleyici varken `app:log` yayınlanır. */
  "app:logWatch": { req: z.object({ on: z.boolean() }), res: z.void() },
  /** Renderer'ın yerel performans ölçümü (ilk boyama, araç kartı gecikmesi); dışarı gitmez. */
  "perf:record": { req: PerfRecordRequest, res: z.void() },
  /** PRD 11 ölçütleri: son ölçümlerin p50/p95'i ve hedefe göre sonucu (Ayarlar > Tanılama). */
  "perf:summary": { req: z.void(), res: PerfSummary },
  /** Ajan olay izi (NDJSON) klasörünü sistem dosya yöneticisinde açar. */
  "app:openAgentEvents": { req: z.void(), res: z.void() },
  /** Renderer hatalarını main günlüğüne yazar. */
  "app:logError": { req: z.object({ scope: z.string(), message: z.string() }), res: z.void() },
  /** Güncelleme denetimi (yalnızca paketli sürümde çalışır). */
  "app:checkUpdates": { req: z.void(), res: UpdateStatus },
  /** Son bilinen güncelleme durumu; pencere açılışında kart bunu okur. */
  "app:updateStatus": { req: z.void(), res: UpdateStatus },
  /** Bulunan sürümü indirmeyi başlatır (otomatik indirme kapalıyken kart düğmesi). */
  "app:downloadUpdate": { req: z.void(), res: UpdateStatus },
  /** İndirilen güncellemeyi kurar; uygulama kapanıp yeniden açılır. */
  "app:installUpdate": { req: z.void(), res: z.void() },
  "app:paths": {
    req: z.void(),
    res: z.object({
      userData: z.string(),
      agentDir: z.string(),
      sessionsDir: z.string(),
      /** Plan modunda yazılan plan dosyalarının kökü. */
      plansDir: z.string(),
      /** Günlük dosyalarının klasörü (codezal.log, codezal-debug.log). */
      logsDir: z.string(),
      /** Oturum başına NDJSON ajan olay izi klasörü. */
      agentEventsDir: z.string(),
      documents: z.string(),
      home: z.string(),
    }),
  },

  "window:close": { req: z.void(), res: z.void() },
  "window:minimize": { req: z.void(), res: z.void() },
  "window:toggleMaximize": { req: z.void(), res: z.void() },
  "window:state": {
    req: z.void(),
    res: z.object({ minimized: z.boolean(), maximized: z.boolean(), fullScreen: z.boolean() }),
  },

  "models:catalog": { req: z.void(), res: z.array(CatalogModel) },
  /** Uzak katalogtan (models.dev verisi) yeni modelleri çeker; ağ yoksa gömülü liste kalır. */
  "models:refresh": { req: z.void(), res: z.array(CatalogModel) },
  "models:providers": { req: z.void(), res: z.array(ProviderInfo) },
  /** Anahtar ekler; sağlayıcıda zaten anahtar varsa havuza yedek olarak girer. */
  "models:setApiKey": {
    req: z.object({
      provider: z.string(),
      apiKey: z.string().min(1),
      label: z.string().max(40).optional(),
    }),
    res: z.void(),
  },
  /** Tüm anahtarları kaldırır (çıkış). */
  "models:logout": { req: z.object({ provider: z.string() }), res: z.void() },
  "models:removeApiKey": {
    req: z.object({ provider: z.string(), keyId: z.string() }),
    res: z.void(),
  },
  /** Anahtarı başa alır ve soğumasını siler. */
  "models:activateApiKey": {
    req: z.object({ provider: z.string(), keyId: z.string() }),
    res: z.void(),
  },

  /** Kota önbelleği; `quota:refresh` çağrılmadan yalnız elde olan veriyi döner. */
  "quota:list": { req: z.void(), res: z.array(ProviderQuota) },
  /**
   * Kota tazeleme. `provider` verilirse yalnız o sağlayıcı, verilmezse bağlı tüm sağlayıcılar
   * (kota ucu olanlar) tazelenir; önbellek ömrü yok sayılır.
   */
  "quota:refresh": {
    req: z.object({
      provider: z.string().optional(),
      /** true ise önbellek ömrü yok sayılır (kullanıcı elle yeniledi). */
      force: z.boolean().default(false),
    }),
    res: z.array(ProviderQuota),
  },

  "project:pickFolder": { req: z.void(), res: ProjectRef.nullable() },
  "project:recent": { req: z.void(), res: z.array(ProjectRef) },
  /** Klasörü son kullanılanlardan çıkarır (disk silinmez). */
  "project:forget": { req: z.object({ path: z.string() }), res: z.void() },
  /** Kenar çubuğundaki manuel klasör sırası; yeni sıralı liste döner. */
  "project:reorder": { req: z.object({ paths: z.array(z.string()) }), res: z.array(ProjectRef) },
  /** Klasörü sistem terminalinde açar (macOS Terminal, Windows PowerShell, Linux x-terminal-emulator). */
  "project:openTerminal": { req: z.object({ path: z.string() }), res: z.void() },
  /** Sistemde kurulu harici uygulamalar (Finder, editör, terminal); "şurada aç" menüsünü besler. */
  "openWith:list": { req: z.void(), res: z.array(OpenWithApp) },
  /** Klasörü seçilen uygulamada açar: `appId` kayıt defterinde, `path` var olan dizin olmalı. */
  "openWith:open": {
    req: z.object({ appId: z.string().min(1), path: z.string().min(1) }),
    res: z.void(),
  },
  /**
   * Klasörü açar: son kullanılanlara ekler, taşınmış projenin oturum/bellek klasörlerini yeni yola
   * taşır, proje-yerel yapılandırma (.codezal, .pi) varsa ve hiç sorulmadıysa güven sorar.
   */
  "project:open": { req: z.object({ path: z.string().min(1) }), res: ProjectRef },
  /** Güven kararını değiştirir (Ayarlar > Kişiselleştirme). */
  "project:setTrusted": {
    req: z.object({ path: z.string().min(1), trusted: z.boolean() }),
    res: ProjectRef,
  },
  /** Güvenilen projenin `.codezal/ayarlar.json` + `ayarlar.local.json` birleşimi; yoksa boş. */
  "project:config": { req: z.object({ cwd: z.string().min(1) }), res: ProjectConfig },
  /**
   * Etkin hook'lar (Ayarlar'daki salt okunur liste): genel `hooks.json` ve `cwd` verilip proje
   * güvenilirse `.codezal/ayarlar*.json` içindekiler, kaynak dosyalarıyla.
   */
  "hooks:list": { req: z.object({ cwd: z.string().optional() }), res: z.array(ResolvedHook) },
  /** Plan dosyasını (userData/plans altında) projenin `.codezal/planlar/` klasörüne kopyalar; hedef yolu döner. */
  "plans:saveToProject": {
    req: z.object({ path: z.string().min(1), cwd: z.string().min(1) }),
    res: z.string(),
  },

  "sessions:list": { req: z.object({ cwd: z.string().optional() }), res: z.array(SessionSummary) },
  /**
   * Oturum içeriğinde tam metin arama (⌘K). Renderer yol değil **kimlik** gönderir (main
   * renderer'ın söylediği rastgele dosyayı okumaz); sıra taranma sırasıdır (yeniden eskiye).
   * Yalnız kullanıcı ve asistan metni aranır; araç çıktısı ve görseller dışarıda kalır.
   * `truncated`: sınır ya da süre dolduğu için taranmayan oturum kaldı.
   */
  "sessions:search": {
    req: z.object({
      query: z.string().trim().min(SESSION_SEARCH_MIN).max(SESSION_SEARCH_MAX),
      ids: z.array(z.string()).max(5000),
    }),
    res: z.object({ hits: z.array(SessionSearchHit), truncated: z.boolean() }),
  },
  "sessions:create": { req: SessionOptions, res: SessionSummary },
  "sessions:open": {
    req: z.object({ id: z.string() }),
    res: z.object({
      summary: SessionSummary,
      transcript: z.array(TranscriptItem),
      /** Açılışta bağlam doluluğu (halka için); hesaplanamazsa yok. */
      context: ContextUsage.optional(),
      /** Açılışta oturumun toplam token kullanımı (önbellek isabeti için); yoksa sıfır kabul edilir. */
      usage: Usage.optional(),
      /** Oturumun izin modu (meta); composer çipi bununla başlar, genel tercihle değil. */
      permission: PermissionMode.optional(),
      /** Oturumun o anki modeli (Pi oturum dosyasından geri yüklenir); çip bunu gösterir, genel tercihi değil. */
      model: ModelRef.optional(),
      /** Oturumun düşünme seviyesi; yoksa genel tercih gösterilir. */
      thinking: ThinkingLevel.optional(),
      /** Açılışta hâlâ çalışan arka plan görevleri; Ajanlar kutusu bunlarla dolar. */
      backgrounds: z.array(BackgroundJob).optional(),
      /** Açılışta aktif kalıcı hedef (`/goal`); GoalCard bununla dolar. */
      goal: GoalState.optional(),
      /**
       * Açılışta yanıt bekleyen izin istekleri (ajan koşularınınkiler `run` alanıyla), plan onayı
       * ve soru. Snapshot bunları taşımazsa yeniden açılışta kart kaybolur, kapı sonsuza dek bekler.
       */
      permissions: z.array(PermissionRequest).optional(),
      planReview: PlanReview.optional(),
      question: QuestionRequest.optional(),
      /**
       * Snapshot'ın kapsadığı son olay sırası: renderer yalnız `seq > lastSeq` olayları uygular;
       * snapshot ile canlı akış arasında çift/kayıp mesaj kalmaz.
       */
      lastSeq: z.number().int().nonnegative(),
      /** Motorun bu çalışmasına ait kimlik; imleç bayatlık denetimi için. */
      epoch: z.string().min(1),
      /**
       * Açılış anında süren turun kimliği; tur yoksa null. Snapshot'tan kurulan runtime bu değerle
       * "tur açık" durumuna döner: dönmezse süren turun akış olayları stale-run kapısında düşer ve
       * oturum, model çalışırken bir sonraki `run_start`'a dek donuk görünür.
       */
      runId: z.string().nullable(),
      /**
       * Alt ajan koşuları ve izleri: biten koşular oturum dosyasından geri gelir, Ajanlar paneli
       * uygulama yeniden başlasa da dolu açılır.
       */
      subagents: z.array(SubagentRun).optional(),
      subagentTraces: z.array(SubagentTrace).optional(),
      /** Snapshot alındıktan sonra yayınlanan olaylar (seq artan); açılış yarışını kapatır. */
      buffered: z.array(AgentEvent),
    }),
  },
  "sessions:prompt": {
    req: z.object({
      id: z.string(),
      text: z.string(),
      images: z.array(ImageAttachment).max(10).optional(),
    }),
    res: z.void(),
  },
  /** Çalışırken yönlendirme: mesaj sıradaki LLM çağrısında teslim edilir; boş metin + görsel geçerli. */
  "sessions:steer": {
    req: z.object({
      id: z.string(),
      text: z.string(),
      images: z.array(ImageAttachment).max(10).optional(),
    }),
    res: z.void(),
  },
  /**
   * Bağlamı şimdi özetle (`/compact`). Eşik bakılmaz — kararı kullanıcı verdi. Tur sürerken
   * reddedilir: Pi `compact()` başında `abort()` çağırdığı için süren turu keserdi.
   */
  "sessions:compact": {
    req: z.object({ id: z.string() }),
    res: z.object({
      ok: z.boolean(),
      /**
       * `nothing-to-compact` ve `already-compacted` arıza değildir: Pi sıkıştırılacak eski içerik
       * bulamadığında bunu hata olarak fırlatır, arayüz "yapacak iş yok" demelidir.
       */
      reason: z
        .enum(["not-open", "busy", "nothing-to-compact", "already-compacted", "failed"])
        .optional(),
      /** `failed` durumunda maskelenmiş sebep; kullanıcı ne olduğunu görebilsin. */
      detail: z.string().optional(),
      /** Sıkıştırma sonrası doluluk; arayüz göstergesi bununla tazelenir. */
      context: z
        .object({ tokens: z.number(), contextWindow: z.number(), percent: z.number() })
        .optional(),
    }),
  },
  /** Çalışırken kuyruğa alma: mesaj tur tamamen bitince ayrı tur olarak işlenir (Pi followUp). */
  "sessions:followUp": {
    req: z.object({
      id: z.string(),
      text: z.string(),
      images: z.array(ImageAttachment).max(10).optional(),
    }),
    res: z.void(),
  },
  /** Bekleyen yönlendirme ve takip mesajlarını temizler (Pi clearQueue). */
  "sessions:clearQueue": { req: z.object({ id: z.string() }), res: z.void() },
  "sessions:abort": { req: z.object({ id: z.string() }), res: z.void() },
  /** Kalıcı hedef (`/goal`): set yeni hedef başlatır, stop/pause/resume mevcudu yönetir. */
  "sessions:goal": {
    req: z.object({
      id: z.string(),
      action: z.enum(["set", "stop", "pause", "resume"]),
      /** `action: "set"` için zorunlu: hedef metni. */
      text: z.string().min(1).optional(),
      /** `action: "set"` için opsiyonel iterasyon sınırı; yoksa 30. */
      maxIter: z.number().int().positive().max(200).optional(),
    }),
    res: z.void(),
  },
  "sessions:setModel": { req: z.object({ id: z.string(), model: ModelRef }), res: z.void() },
  "sessions:setThinking": {
    req: z.object({ id: z.string(), thinking: ThinkingLevel }),
    res: z.void(),
  },
  "sessions:setPermission": {
    req: z.object({ id: z.string(), permission: PermissionMode }),
    res: z.void(),
  },
  "sessions:rename": { req: z.object({ id: z.string(), name: z.string().min(1) }), res: z.void() },
  /** Başlığı son mesajlara göre modelle yeniden üretir; yeni adı döner. */
  "sessions:regenerateTitle": {
    req: z.object({ id: z.string() }),
    res: z.object({ name: z.string() }),
  },
  "sessions:delete": { req: z.object({ id: z.string() }), res: z.void() },
  "sessions:setPinned": { req: z.object({ id: z.string(), pinned: z.boolean() }), res: z.void() },
  "sessions:setArchived": {
    req: z.object({ id: z.string(), archived: z.boolean() }),
    res: z.void(),
  },
  "sessions:purgeArchived": { req: z.void(), res: z.number().int().nonnegative() },
  "sessions:export": { req: z.object({ id: z.string() }), res: z.string().nullable() },
  /**
   * Oturumu kopyalar. `assistantOrdinal` verilirse (metinli N. asistan mesajı) yalnızca oraya kadar
   * olan yol yeni oturuma alınır (Dallandır); verilmezse tüm geçmiş kopyalanır (Çoğalt).
   */
  "sessions:fork": {
    req: z.object({
      id: z.string(),
      /** Metinli N. asistan mesajına kadar dallandır. */
      assistantOrdinal: z.number().int().positive().optional(),
      /** N. kullanıcı mesajından hemen önce dallandır (o mesaj yeni oturuma girmez). */
      userOrdinal: z.number().int().positive().optional(),
    }),
    res: SessionSummary,
  },
  /**
   * Yan sohbet: oturumun geçmişini salt okunur, listede görünmeyen bir dala kopyalar. Kapatmak
   * `sessions:delete`, ayrı oturuma çevirmek `sessions:promoteSide`.
   */
  "sessions:side": { req: z.object({ id: z.string() }), res: SessionSummary },
  /** Yan sohbeti kenar çubuğunda görünen, izni ana oturumunkine dönen ayrı oturuma çevirir. */
  "sessions:promoteSide": { req: z.object({ id: z.string() }), res: SessionSummary },
  /** Aynı oturumda N. kullanıcı mesajının öncesine geri sar; metin yazma kutusuna döner. */
  "sessions:rewind": {
    req: z.object({ id: z.string(), userOrdinal: z.number().int().positive() }),
    res: z.object({
      transcript: z.array(TranscriptItem),
      editorText: z.string(),
      context: ContextUsage.optional(),
      usage: Usage.optional(),
    }),
  },
  /** Turun dosya değişikliklerini tur öncesi yedeğinden geri alır (terminal komutları hariç). */
  "sessions:undoFiles": {
    req: z.object({ id: z.string(), userOrdinal: z.number().int().positive() }),
    res: z.object({
      restored: z.array(z.string()),
      removed: z.array(z.string()),
      /** Boyut ya da kopyalama bütçesi yüzünden yedeklenemeyen ve geri alınamayan dosyalar. */
      skipped: z.array(z.string()).default([]),
      /**
       * Tur yedeği eksik: terminal komutu çok büyük bir klasörde çalıştı (tarama sınırı) ya da
       * çok sayıda dosya değiştirdi; bazı değişiklikler kapsanmamış olabilir.
       */
      partial: z.boolean().default(false),
      /**
       * Oturum deponun alt klasöründeyken turun klasör dışında değiştirdiği dosyalar (depo köküne
       * göre); geri alınmazlar, kullanıcıya söylenir.
       */
      outside: z.array(z.string()).default([]),
    }),
  },

  "terminal:create": {
    req: z.object({
      cwd: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    res: TerminalInfo,
  },
  "terminal:write": { req: z.object({ id: z.string(), data: z.string() }), res: z.void() },
  "terminal:resize": {
    req: z.object({
      id: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    res: z.void(),
  },
  "terminal:kill": { req: z.object({ id: z.string() }), res: z.void() },
  "terminal:list": { req: z.void(), res: z.array(TerminalInfo) },

  "files:list": { req: z.object({ root: z.string(), dir: z.string() }), res: z.array(FileNode) },
  "files:read": { req: z.object({ path: z.string() }), res: FileContent },
  "files:search": {
    req: z.object({ root: z.string(), query: z.string().min(1) }),
    res: z.array(FileNode),
  },
  "files:create": { req: z.object({ path: z.string() }), res: z.void() },
  "files:reveal": { req: z.object({ path: z.string() }), res: z.void() },
  "files:openExternal": { req: z.object({ path: z.string() }), res: z.void() },
  /** Yolların her biri için dosya olarak duruyor mu; sıra korunur (tur sonu belge kartları). */
  "files:exists": {
    req: z.object({ paths: z.array(z.string()).max(50) }),
    res: z.array(z.boolean()),
  },
  "files:write": { req: z.object({ path: z.string(), content: z.string() }), res: z.void() },
  /** Dosyayı "farklı kaydet" diyaloğuyla kopyalar; iptalde null döner. */
  "files:saveCopy": { req: z.object({ path: z.string() }), res: z.string().nullable() },

  "git:status": { req: z.object({ cwd: z.string() }), res: GitStatus },
  "git:branches": { req: z.object({ cwd: z.string() }), res: z.array(GitBranch) },
  "git:checkout": { req: z.object({ cwd: z.string(), branch: z.string() }), res: z.void() },
  "git:discard": { req: z.object({ cwd: z.string(), path: z.string().optional() }), res: z.void() },
  "git:commit": {
    req: z.object({ cwd: z.string(), message: z.string().min(1), includeUnstaged: z.boolean() }),
    res: z.object({ hash: z.string() }),
  },
  "git:push": { req: z.object({ cwd: z.string() }), res: z.void() },
  /** Commit mesajı önerisi: `model` verilmezse ayarlardaki varsayılan; ikisi de yoksa sezgisel. */
  "git:suggestMessage": {
    req: z.object({ cwd: z.string(), includeUnstaged: z.boolean(), model: ModelRef.optional() }),
    res: z.object({
      message: z.string(),
      /** true: modelden geldi; false: sezgisel mesaj (`error` nedeni söyler). */
      ai: z.boolean(),
      error: z.string().optional(),
    }),
  },
  "git:diff": { req: z.object({ cwd: z.string(), path: z.string().optional() }), res: z.string() },

  "worktree:list": { req: z.object({ cwd: z.string() }), res: z.array(WorktreeInfo) },
  "worktree:create": {
    req: z.object({ cwd: z.string(), name: z.string().optional() }),
    res: WorktreeInfo,
  },
  "worktree:remove": { req: z.object({ cwd: z.string(), path: z.string() }), res: z.void() },

  "checks:run": {
    req: z.object({ cwd: z.string(), commands: z.array(z.string().min(1)) }),
    res: z.array(CheckResult),
  },

  "settings:get": { req: z.void(), res: AppSettings },
  "settings:set": { req: AppSettingsPatch, res: AppSettings },
  /** Kısayol kaydı sırasında menü hızlandırıcıları askıya alınır (tuş renderer'a ulaşsın). */
  "shortcuts:suspend": { req: z.object({ suspended: z.boolean() }), res: z.void() },
  "settings:openFile": {
    req: z.object({
      which: z.enum(["models", "project", "auth", "projectConfig", "projectConfigLocal", "hooks"]),
      cwd: z.string().optional(),
    }),
    res: z.void(),
  },
  "settings:pickFolder": { req: z.object({ title: z.string() }), res: z.string().nullable() },
  /** Görsel dosyası seçme diyaloğu; dosyalar main'de okunup base64 olarak döner. */
  "files:pickImages": { req: z.void(), res: z.array(ImageAttachment) },
  /** Herhangi bir dosya seçme diyaloğu; seçilen dosyaların tam yolları döner. */
  "files:pickFiles": { req: z.object({ title: z.string() }), res: z.array(z.string()) },
  "settings:exportData": { req: z.void(), res: z.string().nullable() },

  "usage:list": { req: z.void(), res: z.array(UsageEntry) },
  /**
   * Brave Search API anahtarı: main'de `keys.json` havuzunda tutulur, renderer yalnız bağlı olup
   * olmadığını görür.
   */
  "search:braveKey": { req: z.void(), res: z.object({ connected: z.boolean() }) },
  "search:setBraveKey": {
    req: z.object({ apiKey: z.string().trim().min(1) }),
    res: z.object({ connected: z.boolean() }),
  },
  "search:clearBraveKey": { req: z.void(), res: z.object({ connected: z.boolean() }) },

  "models:oauthLogin": {
    req: z.object({ provider: z.string() }),
    res: z.void(),
  },
  "models:oauthCancel": { req: z.object({ provider: z.string() }), res: z.void() },
  "models:oauthCode": {
    req: z.object({ provider: z.string(), code: z.string().min(1) }),
    res: z.void(),
  },
  "models:keyHint": { req: z.object({ provider: z.string() }), res: z.string().nullable() },

  "schedule:list": { req: z.void(), res: z.array(ScheduledTask) },
  "schedule:save": { req: ScheduledTask, res: ScheduledTask },
  "schedule:delete": { req: z.object({ id: z.string() }), res: z.void() },
  "schedule:runNow": { req: z.object({ id: z.string() }), res: z.void() },

  "assistant:projects": { req: z.void(), res: z.array(AssistantProject) },
  "assistant:saveProject": { req: AssistantProject, res: AssistantProject },
  "assistant:deleteProject": { req: z.object({ id: z.string() }), res: z.void() },
  /** Asistan projelerinin manuel sırası; yeni sıralı liste döner. */
  "assistant:reorderProjects": {
    req: z.object({ ids: z.array(z.string()) }),
    res: z.array(AssistantProject),
  },
  /**
   * Bağlamı proje klasörüne (`Bağlam/`) kopyalar. `confirm` verilmeden büyük kopyada yalnız
   * boyut döner (`needsConfirm`); üst sınırı aşan kaynak hata verir. Yenilemede eski kopya
   * çöp kutusuna taşınır.
   */
  "assistant:copyContext": {
    req: z.object({
      projectId: z.string(),
      value: z.string(),
      confirm: z.boolean().default(false),
    }),
    res: z.object({
      project: AssistantProject,
      bytes: z.number(),
      needsConfirm: z.boolean(),
    }),
  },
  /** Bağlamı projeden çıkarır; kopyası varsa kalıcı silinmez, çöp kutusuna taşınır. */
  "assistant:removeContext": {
    req: z.object({ projectId: z.string(), value: z.string() }),
    res: z.object({ project: AssistantProject }),
  },
  // ---------- bellek ----------
  "memory:list": { req: z.object({ scope: MemoryScope }), res: z.array(MemoryEntry) },
  "memory:save": { req: z.object({ scope: MemoryScope, draft: MemoryDraft }), res: MemoryEntry },
  "memory:remove": { req: z.object({ scope: MemoryScope, name: z.string() }), res: z.void() },
  /** Bellek klasörünü Finder/Explorer'da açar. */
  "memory:openFolder": { req: z.object({ scope: MemoryScope }), res: z.void() },
  // ---------- beceriler ----------
  /** Yüklü beceri ve kaynak klasör listesi; `cwd` proje kapsamı için. */
  "skills:list": { req: z.object({ cwd: z.string().nullable() }), res: SkillCatalog },
  /** Tek bir beceriyi aç/kapat (Pi ayarlarına `+yol` / `-yol` deseni yazar). */
  "skills:setEnabled": {
    req: z.object({
      cwd: z.string().nullable(),
      path: z.string(),
      enabled: z.boolean(),
    }),
    res: z.void(),
  },
  /** Kaynak klasör ekle/kaldır (Pi ayarlarındaki `skills` dizisi). */
  "skills:addSource": { req: z.object({ path: z.string().min(1) }), res: z.void() },
  "skills:removeSource": { req: z.object({ path: z.string().min(1) }), res: z.void() },
  /** Dosya ya da klasörü Finder/Explorer'da gösterir; klasör yoksa oluşturur. */
  "skills:reveal": { req: z.object({ path: z.string().min(1) }), res: z.void() },
  // ---------- ajanlar (kullanıcı tanımlı alt ajanlar) ----------
  /**
   * Gömülü, kullanıcı ve proje ajanlarının listesi. `cwd` proje klasörünü belirler; her
   * değişiklikten sonra `agents:changed` yayınlanır ve açık oturumlar araç listesini tazeler.
   */
  "agents:list": { req: z.object({ cwd: z.string().nullable() }), res: AgentCatalog },
  /** Yeni ajan dosyası yazar (`<kapsam>/<ad>.md`); aynı ad varsa hata döner. */
  "agents:create": {
    req: z.object({ cwd: z.string().nullable(), draft: AgentDraft }),
    res: AgentInfo,
  },
  /** Var olan ajanı günceller; ad değişirse dosya yeni adla yazılır, eskisi silinir. */
  "agents:update": {
    req: z.object({ cwd: z.string().nullable(), id: z.string(), draft: AgentDraft }),
    res: AgentInfo,
  },
  /** Ajan dosyasını siler (yalnızca kullanıcı ve proje ajanları). */
  "agents:delete": { req: z.object({ cwd: z.string().nullable(), id: z.string() }), res: z.void() },
  /** Ajanı listeden düşürür/geri alır; gömülü ajanlar kapatılamaz. */
  "agents:setEnabled": { req: z.object({ id: z.string(), enabled: z.boolean() }), res: z.void() },
  /**
   * Gömülü ajanın modelini geçersiz kılar (`null` = ana oturumun modelini devral). Gömülü tanım
   * kodda olduğu için seçim dosyaya değil durum dosyasına yazılır.
   */
  "agents:setModelOverride": {
    req: z.object({ id: z.string(), model: ModelRef.nullable() }),
    res: z.void(),
  },
  /** Ajan dosyasını ya da klasörünü Finder/Explorer'da gösterir. */
  "agents:reveal": { req: z.object({ path: z.string().min(1) }), res: z.void() },
  /** Eklentinin `ctx.ui` isteğine cevap; bekleyen çağrı çözülür. */
  "sessions:respondExtensionUi": {
    req: z.object({ sessionId: z.string(), requestId: z.string(), value: ExtensionUiValue }),
    res: z.void(),
  },
  // ---------- bağlayıcılar (MCP) ----------
  /** Kayıtlı uzak MCP sunucuları ve bağlantı durumları (belirteç içermez). */
  "mcp:list": { req: z.object({}), res: z.array(McpConnector) },
  /** Uygulamayla gelen OAuth istemcisi olan aileler (ör. "google"); arayüz kimlik formunu gizler. */
  "mcp:builtInGroups": { req: z.object({}), res: z.array(z.string()) },
  /** Ad ve adresle ekler, hemen bağlanmayı dener; 401 dönerse `needs-login` olur. */
  "mcp:add": {
    req: z.object({
      name: z.string().min(1),
      url: z.string().min(1),
      /** İsteğe bağlı sabit Bearer belirteci (API anahtarı gibi). */
      token: z.string().nullable(),
      /** DCR desteklemeyen sunucular (Google) için kullanıcının kendi OAuth istemcisi. */
      oauthClient: z
        .object({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
        .nullable()
        .optional(),
      /** Aynı ailedeki bağlayıcının OAuth istemcisini kopyala. */
      copyClientFrom: z.string().nullable().optional(),
      /** Yetki adresine eklenecek parametreler (ör. `access_type=offline`). */
      authorizeParams: z.record(z.string(), z.string()).nullable().optional(),
      clientGroup: z.string().nullable().optional(),
      /** Uygulama içi servis: `url` sağlayıcı API köküdür, belirteç doğrudan oraya gider. */
      native: McpNativeService.nullable().optional(),
    }),
    res: McpConnector,
  },
  /**
   * Yerel komut (stdio) sunucusu ekler ve başlatır. Süreç Codezal'ın kimlik ortamını almaz; yalnız
   * PATH, temel kabuk değişkenleri ve burada verilen `env` geçer.
   */
  "mcp:addStdio": {
    req: z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string().nullable(),
    }),
    res: McpConnector,
  },
  "mcp:update": {
    req: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    }),
    res: z.void(),
  },
  "mcp:remove": { req: z.object({ id: z.string() }), res: z.void() },
  /** OAuth girişi: tarayıcı açılır, geri dönüş yerel sunucuya gelir; bitince bağlanır. */
  "mcp:login": { req: z.object({ id: z.string() }), res: z.void() },
  /** Belirteçleri siler ve bağlantıyı kapatır. */
  "mcp:logout": { req: z.object({ id: z.string() }), res: z.void() },
  "mcp:reconnect": { req: z.object({ id: z.string() }), res: z.void() },
  /** Araç izinlerini toplu değiştirir; `tools` sunucudaki araç adlarıdır. */
  "mcp:setToolPolicy": {
    req: z.object({ id: z.string(), tools: z.array(z.string()).min(1), policy: McpToolPolicy }),
    res: z.void(),
  },
  /**
   * Yeni ya da tanımı değişmiş araçları onaylar: güncel tanım sabitlenir ve araç ajana açılır.
   * `tools` sunucudaki araç adlarıdır.
   */
  "mcp:approveTools": {
    req: z.object({ id: z.string(), tools: z.array(z.string()).min(1) }),
    res: z.void(),
  },
  /**
   * Sunucunun istemini argümanlarla işler; mesajların metni birleştirilip döner. Kompozere
   * yazılır, kullanıcı görmeden modele gitmez.
   */
  "mcp:getPrompt": {
    req: z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.string()) }),
    res: z.object({ text: z.string() }),
  },
  /** Hata/bağlı değil durumdaki etkin bağlayıcıları yeniden dener; denenen sayısını döner. */
  "mcp:reconnectFailed": { req: z.object({}), res: z.number().int().nonnegative() },

  // ---------- güvenlik denetimi ----------
  /** Oturumun denetim run'ının panel görünümü; run yoksa null. */
  "audit:state": { req: z.object({ sessionId: z.string() }), res: AuditView.nullable() },
  /** Panelden denetim başlatma (boş durum kartı); ajan yolu `audit_start` aracıdır. */
  "audit:start": {
    req: z.object({
      sessionId: z.string(),
      options: AuditStartOptions.default({ profile: "standard" }),
    }),
    res: AuditView,
  },
  /** Raporu PDF'e çevirir ve run klasörüne yazar. */
  "audit:export": { req: z.object({ sessionId: z.string() }), res: z.object({ path: z.string() }) },
  /** Run klasörünü Finder/Explorer'da açar. */
  "audit:reveal": { req: z.object({ sessionId: z.string() }), res: z.void() },

  // ---------- kod incelemesi (deneysel) ----------
  /** "İncele" düğmesi: son değişiklikleri ayrı bir denetçiyle inceler; hemen döner, sonuç olayla gelir. */
  "review:run": {
    req: z.object({ sessionId: z.string() }),
    res: z.object({
      started: z.boolean(),
      reason: z.enum(["no-changes", "busy", "disabled"]).optional(),
    }),
  },
  /** Bulgu işareti (gerçek / yanlış pozitif); ölçüm kaydına yazılır. */
  "review:mark": {
    req: z.object({ sessionId: z.string(), findingId: z.string(), outcome: ReviewOutcome }),
    res: z.void(),
  },
  /** İnceleme kayıt klasörünü sistem dosya yöneticisinde açar. */
  "review:reveal": { req: z.object({ sessionId: z.string() }), res: z.void() },

  notify: {
    req: z.object({ title: z.string(), body: z.string() }),
    res: z.void(),
  },

  /**
   * Ayrık ajan koşuları (`agent` aracının arka plan / worktree kipi). Koşu, onu başlatan oturuma
   * bağlıdır. İzin ve soru akışı için ayrı kanal açılmaz: `permissions:respond` /
   * `questions:respond` koşunun kendi `sessionId`'siyle çalışır.
   */
  "agentRuns:list": { req: z.object({ sessionId: z.string() }), res: z.array(WorkerInfo) },
  "agentRuns:stop": {
    req: z.object({ sessionId: z.string(), runId: z.string() }),
    res: z.void(),
  },
  /** Çalışan koşuya mesaj (steer); Pi kuyruğuna girer. */
  "agentRuns:steer": {
    req: z.object({ sessionId: z.string(), runId: z.string(), message: z.string().min(1) }),
    res: z.void(),
  },
  /** `review` durumundaki worktree koşusu: ana dala uygula ya da worktree'yi sil. */
  "agentRuns:review": {
    req: z.object({ sessionId: z.string(), runId: z.string(), decision: WorkerReviewDecision }),
    res: z.void(),
  },
  /** İnceleme ekranı: koşunun worktree'sindeki değişikliklerin diff'i. */
  "agentRuns:diff": {
    req: z.object({ sessionId: z.string(), runId: z.string() }),
    res: z.object({ diff: z.string() }),
  },
  /** Oturumun arka plan komutları (bitenler dahil); Arka plan sekmesinin listesi. */
  "background:list": { req: z.object({ sessionId: z.string() }), res: z.array(BackgroundJob) },
  /**
   * Arka plan komutunun saklanan çıktı kuyruğu. Çıktı olayla akmaz: sekme açıkken ve komut
   * sürerken yoklanır. Görev bilinmiyorsa (silinmiş, başka oturumun) `null`.
   */
  "background:output": {
    req: z.object({ sessionId: z.string(), jobId: z.string() }),
    res: z.object({ job: BackgroundJob, output: z.string(), truncated: z.boolean() }).nullable(),
  },
  /** Kullanıcı arka plan komutunu durdurur; bitiş `background_end` olayıyla gelir. */
  "background:stop": {
    req: z.object({ sessionId: z.string(), jobId: z.string() }),
    res: z.boolean(),
  },
  /** Bekletilen alt ajan koşusunu (explore, agent) tek başına durdurur; ana tur sürer. */
  "subagents:stop": {
    req: z.object({ sessionId: z.string(), runId: z.string() }),
    res: z.void(),
  },

  "permissions:respond": {
    req: z.object({ requestId: z.string(), decision: PermissionDecision }),
    res: z.void(),
  },
  /** Plan onay kartının kararı (`plan_exit`); reddedilirse geri bildirim modele gider. */
  "plans:respond": {
    req: z.object({ requestId: z.string(), decision: PlanDecision }),
    res: z.void(),
  },
  /** Soru kartının yanıtı (`question`); boş dizi sorunun yanıtsız geçildiğini söyler. */
  "questions:respond": {
    req: z.object({ requestId: z.string(), answers: QuestionAnswers }),
    res: z.void(),
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]["req"]>;
/** Doğrulanmış (varsayılanları uygulanmış) istek; main tarafındaki handler bunu alır. */
export type IpcPayload<C extends IpcChannel> = z.output<IpcContract[C]["req"]>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]["res"]>;

/** Menü ve kısayollardan gelen uygulama komutları (⌘N, ⌘K, ⌘,, ⌘\\, ⌘G, ⌘J, ⌘M). */
export const AppCommand = z.enum([
  "new-task",
  "search",
  "settings",
  "toggle-sidebar",
  "changes",
  "toggle-panel",
  "terminal",
  "commit",
  "model",
  "find",
]);
export type AppCommand = z.infer<typeof AppCommand>;

/** Main → renderer olay kanalları. */
export const ipcEvents = {
  "agent:event": AgentEvent,
  "app:command": z.object({ command: AppCommand }),
  /** Canlı günlük satırı; yalnızca `app:logWatch` açıkken yayınlanır. */
  "app:log": LogLine,
  "terminal:data": z.object({ id: z.string(), data: z.string() }),
  "terminal:exit": z.object({ id: z.string(), code: z.number().int() }),
  "git:changed": z.object({ cwd: z.string() }),
  "oauth:progress": z.object({
    provider: z.string(),
    kind: z.enum(["url", "code", "message", "done", "error"]),
    text: z.string(),
  }),
  "schedule:ran": z.object({ id: z.string(), sessionId: z.string() }),
  /** Görev çalışmaya başladı; oturum, bitişi beklemeden sohbet listesine düşsün diye yayınlanır. */
  "schedule:started": z.object({ id: z.string(), sessionId: z.string() }),
  /** Görev listesi ajan aracıyla değişti; arayüz yeniden yükler. */
  "schedule:changed": z.object({}),
  /**
   * Oturum listesi arayüzün istemediği bir yoldan değişti (otomatik arşiv taraması); kenar
   * çubuğu listeyi yeniler. Kullanıcı eylemleri listeyi zaten iyimser günceller.
   */
  "sessions:changed": z.object({}),
  /** Limit dolunca anahtar değişti; arayüz bildirir ve sağlayıcı listesini yeniler. */
  "credential:rotated": CredentialRotation,
  /** Bu ayın maliyeti para bütçesinin %80/%100 eşiğini geçti (ayda eşik başına bir kez). */
  "usage:budget": z.object({
    threshold: z.number(),
    cost: z.number().nonnegative(),
    limit: z.number().positive(),
  }),
  /** Bellek klasöründe değişiklik (ajan ya da kullanıcı yazdı). */
  "memory:changed": z.object({}),
  /** Denetim run'ı durumu değişti (araç yazımı ya da panel eylemi); panel yeniden çeker. */
  "audit:changed": z.object({ sessionId: z.string() }),
  /** Beceri listesi değişti; arayüz yeniden yükler. */
  "skills:changed": z.object({}),
  /** Ajan listesi değişti; arayüz yeniden yükler, açık oturumlar araç tanımını tazeler. */
  "agents:changed": z.object({}),
  /** Bağlayıcı listesi ya da durumu değişti; arayüz yeniden yükler. */
  "mcp:changed": z.object({}),
  /** Uzak katalog tazelendi ve model listesi değişti; arayüz kataloğu yeniden çeker. */
  "models:changed": z.object({}),
  /** Otomatik güncelleme durumu. */
  "update:status": UpdateStatus,
  /** Ayara göre gömülü tarayıcıda açılacak bağlantı. */
  "link:open": z.object({ url: z.string() }),
} as const;
export type IpcEventChannel = keyof typeof ipcEvents;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<(typeof ipcEvents)[C]>;

/** Çalışılan platform; preload `process.platform`'ı doğrudan verir. */
export type AppPlatform = "darwin" | "win32" | "linux";

/** Preload'un `window.codezal` altında sunduğu yüzey. */
export interface CodezalBridge {
  /** Renderer'ın tek platform kaynağı (`navigator.platform` kullanımdan kalktı). */
  platform: AppPlatform;
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): () => void;
  /** Sürükleyip bırakılan dosyanın disk yolunu verir (Electron `webUtils`); yol yoksa boş dize. */
  pathForFile(file: File): string;
}
