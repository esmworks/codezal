import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import {
  agentShell,
  CodezalEngine,
  ReviewStore,
  registerFlowModel,
  resolvePdfFont,
} from "@codezal/agent";
import { localeOf } from "@codezal/i18n";
import { app, BrowserWindow, Notification, nativeTheme } from "electron";
import { AgentTrace } from "./agent-trace.js";
import { expiredSessions } from "./archive.js";
import { assistantDir, assistantExtras, migrateProjectMemory, runScheduled } from "./assistant.js";
import { auditAssetsDir } from "./audit-assets.js";
import { budgetAlerts, monthCost } from "./budget.js";
import { disposeChecks, runCheck } from "./checks.js";
import type { AppContext } from "./context.js";
import {
  agentWorktreeName,
  applyWorktree,
  createWorktree,
  removeWorktree,
  worktreeChangedFiles,
  worktreeDiff,
} from "./git.js";
import { loadHooks } from "./hooks.js";
import { i18n } from "./i18n.js";
import { registerAgentRunsIpc } from "./ipc/agent-runs.js";
import { registerAgentsIpc } from "./ipc/agents.js";
import { registerAppIpc } from "./ipc/app.js";
import { registerAssistantIpc } from "./ipc/assistant.js";
import { registerAuditIpc } from "./ipc/audit.js";
import { registerMcpIpc } from "./ipc/mcp.js";
import { registerModelsIpc } from "./ipc/models.js";
import { registerOpenWithIpc } from "./ipc/open-with.js";
import { registerQuotaIpc } from "./ipc/quota.js";
import { registerReviewIpc } from "./ipc/review.js";
import { registerSessionsIpc } from "./ipc/sessions.js";
import { applyNetwork, registerSettingsIpc } from "./ipc/settings.js";
import { registerSkillsIpc } from "./ipc/skills.js";
import { registerWorkspaceIpc } from "./ipc/workspace.js";
import { broadcast } from "./ipc.js";
import { openExternalSafe, openLink } from "./links.js";
import { registerLocalFileScheme, serveLocalFiles } from "./local-files.js";
import { initLogger, log, verboseFromEnv } from "./log.js";
import { installContextMenu, installMenu } from "./menu.js";
import { startNetworkWatch } from "./network.js";
import { builtInOauthClients } from "./oauth-clients.js";
import { ensureUserPathOnEnv } from "./path-env.js";
import { appIconPath, ensureAppPaths, migrateUserData, windowsDataRoot } from "./paths.js";
import { renderPdf } from "./pdf.js";
import { PERF_TARGETS, perf } from "./perf.js";
import { ProjectStore } from "./projects.js";
import { nextRun, Scheduler } from "./scheduler.js";
import { hardenWebContents } from "./security.js";
import { AppStores, localDay } from "./stores.js";
import {
  applyLoginItem,
  applyTray,
  disposeTray,
  setKeepAwake,
  trayActive,
  turnEnded,
  turnStarted,
} from "./system.js";
import { TerminalManager } from "./terminals.js";
import { beginTurnSnapshot, forgetTurnSnapshot, sealTurnSnapshot } from "./turn-backup.js";
import { isQuittingForUpdate, startUpdater } from "./updater.js";
import { createMainWindow, isDarkTheme, setThemeDark } from "./window.js";

app.setName("Codezal");
// Windows bildirimleri Start menü kısayolunun AppUserModelID'sine bağlı; electron-builder'daki
// `appId` ile birebir aynı olmalı; eşleşmezse Windows bildirimi hiç görünmez.
if (process.platform === "win32") app.setAppUserModelId("com.codezal.app");
// Şema ayrıcalıkları uygulama hazır olmadan bildirilmek zorunda.
registerLocalFileScheme();
// Test ve geliştirme: ayrı veri klasörü (uçtan uca testler gerçek verilere dokunmasın). Paketli
// sürümde yok sayılır: ortam değişkeniyle açılan bir kopya başka bir veri kökünü (ör. saldırganın
// hazırladığı ayar ve MCP kayıtlarını) yüklemesin. e2e paketlenmemiş derlemeyle koşar.
const devUserData = app.isPackaged ? undefined : process.env.CODEZAL_USER_DATA;
if (devUserData) app.setPath("userData", devUserData);
// Windows'ta varsayılan `%APPDATA%` (Roaming) büyük veri için uygun değil (senkron, kota, kilit):
// kök `%LOCALAPPDATA%`'ya alınır, ilk açılışta eski klasör taşınır (bkz. paths.ts).
let dataRootNote: string | undefined;
if (!devUserData && process.platform === "win32") {
  const roaming = app.getPath("userData");
  const local = windowsDataRoot(process.env, roaming);
  if (local !== roaming) {
    const moved = migrateUserData(roaming, local);
    app.setPath("userData", local);
    // Taşıma olduysa ayrıca bildirilir; normal durumda yol zaten başlangıç satırında yazılıyor.
    if (moved) dataRootNote = `veri kökü taşındı: ${roaming} → ${local}`;
  }
}

// İkinci kopya aynı oturum dosyalarına yazar ve zamanlanmış görevleri mükerrer çalıştırır.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  // Sessiz çıkış "uygulama açılmıyor" sanılıyordu: `pnpm dev` derleyip Electron'u başlatıyor,
  // kilit alınamayınca süreç 0 koduyla bitiyor ve terminalde hiçbir iz kalmıyordu. Logger bu
  // satırdan sonra kurulduğu için `log.warn` doğrudan konsola düşer (dev'de görünür).
  log.warn(
    "app",
    `Codezal zaten çalışıyor; bu kopya kapatıldı (veri kökü: ${app.getPath("userData")}). ` +
      "Çalışan kopyayı kapat ya da ayrı veri köküyle aç: CODEZAL_USER_DATA=/tmp/codezal-dev pnpm dev",
  );
  app.quit();
}

let ctx: AppContext | undefined;
let scheduler: Scheduler | undefined;
let stopNetworkWatch: (() => void) | undefined;
let mainWindow: BrowserWindow | undefined;

if (singleInstance) {
  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function notify(ctx: AppContext, title: string, body: string) {
  const settings = ctx.settings();
  if (!settings.notifications || !Notification.isSupported()) return;
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  if (focused) return;
  new Notification({
    title,
    body,
    icon: appIconPath(),
    silent: !settings.notificationSound,
  }).show();
}

/** Bellek klasöründeki değişiklikleri (ajan ya da kullanıcı yazınca) arayüze duyurur. */
function watchMemory(root: string): void {
  mkdirSync(root, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast("memory:changed", {}), 300);
    });
  } catch {
    // Bazı dosya sistemleri özyinelemeli izlemeyi desteklemez; arayüz yine de elle yeniler.
  }
}

const ARCHIVE_SWEEP_MS = 3_600_000;
let archiveTimer: NodeJS.Timeout | undefined;

/**
 * Ayarlar > Arşiv > "Eskiyen oturumları arşivle": saatte bir tarar. Ayar kapalıysa tarama
 * yapılmaz, açılınca bir sonraki turda devreye girer (ayrı bir dinleyiciye gerek yok).
 */
function startArchiveSweep(ctx: AppContext): void {
  const sweep = async () => {
    const settings = ctx.settings();
    if (!settings.autoArchive) return;
    const sessions = await ctx.engine.listSessions();
    const ids = expiredSessions(sessions, Number(settings.archiveDays), Date.now());
    for (const id of ids) ctx.engine.setArchived(id, true);
    if (ids.length > 0) {
      log.info("archive", `${ids.length} oturum arşivlendi`);
      // Kenar çubuğu haberdar edilir: yoksa arşivlenen oturumlar ilgisiz bir eyleme kadar
      // listede normal görünmeye devam ediyordu.
      broadcast("sessions:changed", {});
    }
  };
  const run = () => void sweep().catch((error: unknown) => log.error("archive", error));
  archiveTimer = setInterval(run, ARCHIVE_SWEEP_MS);
  // Açılışta hemen değil: oturum listesi ve canlı bayraklar otursun.
  setTimeout(run, 30_000);
}

/** Otomatik başlığın denendiği son tur: ilk tur yarım kaldıysa sonraki iki tur telafi eder. */
const AUTO_TITLE_TURNS = 3;

/**
 * Oturum başına tutulan olay tamponu uzunluğu: renderer açılış yarışını (abonelik ile snapshot
 * yanıtı arasındaki olaylar) ve gap sonrası telafiyi kapatmaya yeter; belleği sınırlı tutar.
 */
const RECENT_AGENT_EVENTS_LIMIT = 500;

/** Tampon tutulan oturum sayısı üst sınırı; aşılırsa en eski oturum düşer. */
const RECENT_AGENT_SESSIONS_LIMIT = 200;

/**
 * Para bütçesi: bu ayın maliyeti %80/%100 eşiğini geçince arayüze bir kez haber verilir. Token
 * bütçesi gibi turu durdurmaz. Hangi eşiğin bildirildiği usage.json'da saklanır; pencere kapalıyken
 * (zamanlanmış görev) geçilen eşik kaydedilir ama bildirim gösterilmez.
 */
function checkBudget(ctx: AppContext): void {
  const { stores } = ctx;
  const limit = ctx.settings().monthlyBudgetUsd;
  const month = localDay(new Date()).slice(0, 7);
  const cost = monthCost(stores.usageEntries(), month);
  const { fire, next, changed } = budgetAlerts(cost, limit, month, stores.budgetNotified());
  if (changed) stores.setBudgetNotified(next);
  if (fire !== undefined) broadcast("usage:budget", { threshold: fire, cost, limit });
}

/** Veriyolu aboneleri: kullanım sayacı, bildirimler, git yenileme, olay izi. */
function subscribeBus(ctx: AppContext): void {
  const { agentTrace, engine, stores } = ctx;
  engine.bus.subscribe((event) => {
    // Tanılama izi önce yazılır: arayüz yavaşlasa da kayıt sırası bozulmasın.
    agentTrace.write(event);
    // Oturum başına son olayları sakla; sessions:open bu tamponu renderer'a telafi olarak verir.
    const buffer = ctx.recentAgentEvents.get(event.sessionId);
    if (buffer) {
      buffer.push(event);
      if (buffer.length > RECENT_AGENT_EVENTS_LIMIT) buffer.shift();
    } else {
      // Emniyet kemeri: silme/purge dışında bir yol haritayı büyütürse en eski oturumlar düşer
      // (normalde tamponlar oturum silinince temizlenir).
      if (ctx.recentAgentEvents.size >= RECENT_AGENT_SESSIONS_LIMIT) {
        const oldest = ctx.recentAgentEvents.keys().next().value;
        if (oldest !== undefined) ctx.recentAgentEvents.delete(oldest);
      }
      ctx.recentAgentEvents.set(event.sessionId, [event]);
    }
    broadcast("agent:event", event);
  });
  engine.bus.on("usage", (event) => {
    const [provider, ...rest] = (event.model ?? "bilinmiyor/bilinmiyor").split("/");
    stores.addUsage(
      provider ?? "?",
      rest.join("/") || (event.model ?? "?"),
      event.usage.input,
      event.usage.output,
      event.usage.cost,
    );
    checkBudget(ctx);
  });
  // Adsız oturuma ilk üç turda kısa başlık üretilir (ilki durdurulduysa ya da hata aldıysa sonraki
  // telafi eder); ad bir kez yazılınca motor bir daha denemez. Liste yenilensin diye haber
  // verilir. Hata günlüğe düşer, türetilmiş başlık (ilk mesajın ilk satırı) kalır.
  const tryAutoTitle = (sessionId: string) => {
    // Ayar kapalıysa model çağrılmaz; liste ilk mesajdan türetilen başlığı göstermeye devam eder.
    if (!ctx.settings().autoTitle) return;
    const turns = engine.userTurnCount(sessionId);
    if (turns < 1 || turns > AUTO_TITLE_TURNS) return;
    void engine
      .autoTitle(sessionId)
      .then((name) => {
        if (name) broadcast("sessions:changed", {});
      })
      .catch((error: unknown) =>
        log.warn("autoTitle", error instanceof Error ? error.message : String(error)),
      );
  };
  // Başlık yanıt akarken gelir: üretim kullanıcı mesajı oturuma girer girmez başlar. İlk akış
  // olayını beklemek yetmiyordu: düşünen model 25 sn boyunca olay yollamayabiliyor, başlık yine
  // sona kalıyordu. Tur sonundaki çağrı yedektir (erken üretim başarısızsa).
  engine.bus.on("user_message", (event) => tryAutoTitle(event.sessionId));
  engine.bus.on("run_start", (event) => {
    turnStarted(event.sessionId);
    // Git deposu olan projelerde tur öncesi ağaç kaydı: "Geri al" terminal değişikliklerini de kapsar.
    const cwd = engine.cwdOf(event.sessionId);
    if (cwd) void beginTurnSnapshot(event.sessionId, cwd);
  });
  engine.bus.on("run_end", (event) => {
    turnEnded(event.sessionId);
    // Tur kaydı burada mühürlenir: kullanıcı sırası ancak tur bitince kesinleşir (tur sırasında
    // teslim edilen yönlendirmeler de sayıya girer). Mühürsüz kayıt geri almada kullanılmaz.
    const cwd = engine.cwdOf(event.sessionId);
    if (cwd) {
      void sealTurnSnapshot(event.sessionId, cwd, engine.userTurnCount(event.sessionId));
    }
    // Yan sohbet kullanıcının yan sorusudur, ana iş değil: "görev bitti" bildirimi göstermez.
    if (!event.aborted && !engine.isSideChat(event.sessionId))
      notify(ctx, "Codezal", i18n.t("notifications.taskDone"));
    if (!event.aborted) tryAutoTitle(event.sessionId);
  });
  engine.bus.on("permission_request", (event) => {
    notify(
      ctx,
      i18n.t("notifications.permissionTitle"),
      `${event.request.toolName}: ${event.request.command ?? event.request.target ?? ""}`,
    );
  });
  engine.bus.on("plan_review", () =>
    notify(ctx, i18n.t("notifications.planTitle"), i18n.t("notifications.planBody")),
  );
  engine.bus.on("question_request", (event) => {
    notify(ctx, i18n.t("notifications.questionTitle"), event.request.questions[0]?.question ?? "");
  });
  engine.bus.on("error", (event) => log.error(`agent:${event.sessionId}`, event.message));
  engine.bus.on("tool_end", () => {
    // Ajan dosya değiştirdiğinde git görünümleri yenilensin.
    broadcast("git:changed", { cwd: "" });
  });
}

// Geliştirme aracı: CODEZAL_DEBUG_PORT verilirse CDP ile pencere sürülebilir (ekran görüntüsü, smoke test).
// Paketli sürümde kapalı: ortam değişkeni, çalışan uygulamaya tam uzaktan denetim portu açardı.
if (!app.isPackaged && process.env.CODEZAL_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CODEZAL_DEBUG_PORT);
}

// Main süreç çökmesin: beklenmeyen hatalar günlüğe düşer, pencere açık kalır.
process.on("uncaughtException", (error) => log.error("main:uncaught", error));
process.on("unhandledRejection", (reason) => log.error("main:unhandled", reason));
app.on("render-process-gone", (_e, _wc, details) => {
  log.error("renderer:gone", `${details.reason} (çıkış kodu ${details.exitCode})`);
});
app.on("child-process-gone", (_e, details) => {
  if (details.reason !== "clean-exit")
    log.error("child:gone", `${details.type}: ${details.reason}`);
});

app.whenReady().then(() => {
  // Kilit alınamadıysa (ikinci kopya) hiçbir şey kurulmaz; süreç `app.quit()` ile kapanır.
  if (!singleInstance) return;
  const paths = ensureAppPaths();
  // Dock/Finder'dan açılışta PATH dardır (nvm/Homebrew görünmez) ve paket kurulumu `spawn npm
  // ENOENT` ile düşer; login kabuk PATH'i ile zenginleştir, alt süreçler bu ortamı miras alır.
  ensureUserPathOnEnv();
  // Pi eklentilerinin child süreçleri (ör. pi-subagents) varsayılan `~/.pi/agent` yerine Codezal
  // deposunu okusun: anahtarlar havuzdan `auth.json`'a aynalanır, child'lar oradan görür.
  // Zaten set edilmişse (Pi içinden başlatılma) dokunulmaz.
  process.env.PI_CODING_AGENT_DIR ??= paths.agentDir;
  initLogger(paths.logsDir);
  // Açılış ölçüsü işletim sisteminin süreç oluşturma anından sayılır: Node ortamı Electron'un
  // kendi açılışından sonra kurulur, `performance.timeOrigin` açılışı kısa gösterirdi.
  const browserProcess = app.getAppMetrics().find((m) => m.type === "Browser");
  if (browserProcess) perf.setProcessStart(browserProcess.creationTime);
  // Açılış ölçüleri günlüğe de düşer: halka tampon süreçle ölür, oturumlar arası geçmiş günlükte
  // kalır. Araç kartı sık ölçülür; yalnız ayrıntılı günlükte görünür.
  perf.onSample((metric, ms) => {
    const line = `${metric} ${Math.round(ms)} ms (hedef < ${PERF_TARGETS[metric]} ms)`;
    if (metric === "toolCard") log.debug("perf", line);
    else log.info("perf", line);
  });
  // Ajan kabuğu başlangıçta çözülür: Windows'ta Git Bash yoksa uyarı günlüğe düşsün.
  // (Ad `shell` olamaz: aynı kapsamda Electron'un `shell` modülü kullanılıyor.)
  const agentShellInfo = agentShell();
  log.info("app", `Codezal ${app.getVersion()} başlıyor (Electron ${process.versions.electron})`);
  log.info("app", `veri kökü: ${paths.userData} · ajan kabuğu: ${agentShellInfo.shell}`);
  if (dataRootNote) log.info("app", dataRootNote);
  if (agentShellInfo.warning) log.warn("shell", agentShellInfo.warning);
  serveLocalFiles();

  const projects = new ProjectStore(paths.userData);
  const stores = new AppStores(paths.userData);
  // İlk açılışta dil sistem dilinden algılanır (desteklenmeyen dilde İngilizce). Kullanıcı
  // Ayarlar'dan seçtiyse dosya vardır; seçim bir daha ezilmez (dosya oluşturulduktan sonra
  // `created` false kalır).
  if (stores.settings.created) {
    stores.settings.update({ language: localeOf(app.getLocale()) });
  }
  // Ayrıntılı günlük ayardan ya da `CODEZAL_LOG` ortam değişkeninden gelir; ayar sonradan değişebilir.
  log.setVerbose(stores.settings.get().verboseLog || verboseFromEnv());
  if (log.verbose()) log.debug("app", `ayrıntılı günlük açık: ${log.debugPath()}`);
  hardenWebContents((url) => openLink(url, stores.settings.get()));
  applyNetwork(stores.settings.get());
  void i18n.changeLanguage(stores.settings.get().language);
  mkdirSync(assistantDir(), { recursive: true });
  const auditAssets = auditAssetsDir();
  const engine = new CodezalEngine({
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    memoryDir: join(paths.userData, "memory"),
    // Alt ajan tanımları: kullanıcı ajanları veri kökünde, proje ajanları `.codezal/agents`ta.
    agentsDir: paths.agentsDir,
    agentsStateFile: paths.agentsStateFile,
    // Ajan koşularının worktree köprüsü: arka plan ve paralel yazan ajanlar kendi dallarında çalışır.
    worktrees: {
      create: async ({ cwd, name, id }) => {
        // Worktree kökü kullanıcı ayarına uyar; boşsa depo içindeki `.worktrees`.
        const root = stores.settings.get().worktreeRoot;
        const info = await createWorktree(
          cwd,
          root.trim() || undefined,
          agentWorktreeName(name, id),
        );
        return info.path;
      },
      // Koşu dalları Codezal'ındır: worktree ile birlikte dal da gider (birleştirilmişse).
      remove: (cwd, path) => removeWorktree(cwd, path, { deleteBranch: true }),
      changedFiles: (_cwd, path) => worktreeChangedFiles(path),
      diff: (path) => worktreeDiff(path),
      apply: async (cwd, path) => {
        await applyWorktree(cwd, path);
        // "Bitince temizle": ana dala uygulanan worktree'de kaybolacak iş kalmaz.
        if (stores.settings.get().worktreeClean)
          await removeWorktree(cwd, path, { deleteBranch: true });
      },
      // Ana klasörün durumu da aynı okuma: depo değilse boş liste, yani kirli değil.
      dirty: async (cwd) => (await worktreeChangedFiles(cwd)).length > 0,
    },
    // Ayarlar > Ajanlar: eşzamanlı koşu sınırı ve worktree koşularının izin modu, canlı okunur.
    webSummaryModel: () => stores.settings.get().webSummaryModel,
    // Ayarlar > Bağlantı > Web araması: sağlayıcı ve SearXNG adresi her aramada canlı okunur.
    webSearch: () => {
      const s = stores.settings.get();
      return { provider: s.webSearchProvider, searxngUrl: s.searxngUrl };
    },
    advisorModel: () => stores.settings.get().advisorModel,
    advisorScheduled: () => stores.settings.get().advisorScheduled,
    agentRuns: () => {
      const s = stores.settings.get();
      return { concurrency: s.agentConcurrency, worktreePermission: s.agentWorktreePermission };
    },
    plansDir: paths.plansDir,
    snapshotsDir: join(paths.userData, "snapshots"),
    // Güvenlik denetimi: run'lar userData/audits altında; skill paketi resources/audit'ten okunur.
    auditsDir: paths.auditsDir,
    ...(auditAssets ? { auditAssetsDir: auditAssets } : {}),
    onAuditChanged: (sessionId) => broadcast("audit:changed", { sessionId }),
    // Tur sonu kontrolleri: Ayarlar > Kod incelemesi'ndeki açık komutlar; anahtar kapalıysa boş.
    turnChecks: () => {
      const s = stores.settings.get();
      if (!s.turnChecks) return [];
      return [s.lintOn ? s.lintCmd : "", s.testOn ? s.testCmd : "", s.buildOn ? s.buildCmd : ""]
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    },
    runCheck: (cwd, command) => runCheck(cwd, command),
    // Kod incelemesi (deneysel): "İncele" düğmesiyle başlar, bulgular gölge modda raporlanır.
    reviewer: () => stores.settings.get().reviewerOn,
    reviewStore: new ReviewStore(paths.reviewsDir),
    // Klonlanan depodaki `.pi/` ayarları sorulmadan yüklenmesin (Codex/Claude Code güven kapısı).
    projectTrusted: (cwd) => projects.isTrusted(cwd),
    // Kullanıcı hook'ları: genel `hooks.json` + güvenilen projenin `.codezal/ayarlar*.json`'ı.
    // Ortam, `ensureUserPathOnEnv` ile login kabuk PATH'i eklenmiş süreç ortamıdır (npx, nvm görünür).
    hooks: (cwd) => loadHooks(paths.userData, cwd, projects.isTrusted(cwd)),
    hookEnv: () => process.env,
    log: (level, scope, message) =>
      level === "warn" ? log.warn(scope, message) : log.info(scope, message),
    // Bash korumalı alanı (yalnız macOS): ayar her komutta okunur; veri kökü okumaya da kapanır.
    bashSandbox: () => stores.settings.get().bashSandbox,
    userDataDir: paths.userData,
    language: stores.settings.get().language,
    keyCooldownMs: () => Number(stores.settings.get().keyCooldownHours) * 3_600_000,
    credentialRotated: (event) => broadcast("credential:rotated", event),
    // MCP sunucusunun verdiği yetki adresi denetlenir: `file:`/özel şema bir program açabilirdi.
    // Reddedilince akış zaman aşımını beklemesin diye hata fırlatılır.
    openExternal: async (url) => {
      if (!(await openExternalSafe(url))) throw new Error(i18n.t("errors.unsafeExternalUrl"));
    },
    appVersion: app.getVersion(),
    builtInOauthClients: builtInOauthClients(),
    // Yerel komut bağlayıcıları (stdio) `ensureUserPathOnEnv`in zenginleştirdiği PATH'le çalışır;
    // ortamın geri kalanı (kimlik yolları, sağlayıcı anahtarları) sürece geçmez.
    mcpStdioPath: () => process.env.PATH,
    // Asistan sohbetinden görev kurma: araç depoya yazar, sonraki çalışma burada hesaplanır.
    schedule: {
      list: () => stores.tasks(),
      save: (task) => {
        const saved = stores.saveTask({ ...task, nextRunAt: nextRun(task) });
        broadcast("schedule:changed", {});
        return saved;
      },
      remove: (id) => {
        const existed = stores.tasks().some((t) => t.id === id);
        stores.deleteTask(id);
        broadcast("schedule:changed", {});
        return existed;
      },
      projects: () => stores.projects().map((p) => ({ id: p.id, name: p.name })),
    },
    // HTML → PDF: gizli pencere + Chromium printToPDF; dış bağımlılık yok.
    renderPdf: (input) => renderPdf(input),
    // pdf_edit filigran ve form değeri için sistemdeki Unicode TTF (aday listesi agent pdf-edit.ts).
    pdfFont: resolvePdfFont(),
    sessionExtrasFor: ({ mode, projectId }) =>
      mode === "asistan" ? assistantExtras(paths.documents, stores, projectId) : undefined,
    globalInstructions: () => {
      const s = stores.settings.get();
      const parts = [s.globalInstructions.trim()];
      if (s.summary) parts.push(i18n.t("prompt.summaryNote"));
      const text = parts.filter(Boolean).join("\n\n");
      return text || undefined;
    },
  });
  // Uçtan uca test: Playwright ajan akışını senaryolu modelle sürer. Paketli sürümde kapalı;
  // değişken yalnız geliştirme ikilisinde anlam taşır.
  if (!app.isPackaged && process.env.CODEZAL_E2E_FAUX === "1") {
    void engine.runtime().then((runtime) => registerFlowModel(runtime));
  }
  const terminals = new TerminalManager(broadcast);
  const agentTrace = new AgentTrace(paths.agentEventsDir, stores.settings.get().agentTraceLog);
  agentTrace.prune();
  const context: AppContext = {
    paths,
    engine,
    projects,
    stores,
    terminals,
    agentTrace,
    recentAgentEvents: new Map(),
    settings: () => stores.settings.get(),
  };
  ctx = context;

  subscribeBus(context);
  migrateProjectMemory(engine, stores);
  watchMemory(engine.memory.root);

  registerAppIpc(context);
  registerModelsIpc(context);
  registerQuotaIpc(context);
  registerSessionsIpc(context);
  // Panel açıkken kapanan uygulamanın yan sohbetleri artık sahipsizdir: listede görünmezler,
  // silinmezlerse diskte birikirlerdi. Kimlikler çağrı anında toplanır; sonra açılanlara dokunulmaz.
  void engine
    .pruneSideChats()
    .then((ids) => {
      // IPC silme yolundaki main kayıtları da düşer: iz dosyası ve tur yedeği sahipsiz kalmasın.
      for (const id of ids) {
        agentTrace.remove(id);
        forgetTurnSnapshot(id);
      }
      if (ids.length > 0) log.info("side", `${ids.length} yan sohbet silindi`);
    })
    .catch((error: unknown) => log.warn("side", String(error)));
  registerWorkspaceIpc(context);
  registerOpenWithIpc();
  registerSettingsIpc(context);
  registerAssistantIpc(context);
  registerSkillsIpc(context);
  registerAgentsIpc(context);
  registerAgentRunsIpc(context);
  registerMcpIpc(context);
  registerAuditIpc(context);
  registerReviewIpc(context);
  // Pi CLI kullananlar için varsayılan kaynaklar; yalnızca ilk açılışta ve klasör varsa yazılır.
  engine.resources.seedDefaults({ skills: ["~/.pi/agent/skills"] });

  // Açık bağlayıcılara arka planda bağlan; araçlar hazır olunca yeni oturumlara girer.
  engine.mcp.start();
  // Ağ kopsa da uyku sonrası da bağlantılar kendiliğinden toparlansın; main debounce'u
  // eşzamanlı tetikleri tek denemeye indirir (Servisler sayfasının açılışı da aynı yolu kullanır).
  stopNetworkWatch = startNetworkWatch(() => void engine.mcp.reconnectFailed());

  scheduler = new Scheduler(
    () => stores.tasks(),
    (t) => stores.saveTask(t),
    (t) => runScheduled(engine, stores, t),
  );
  scheduler.start();
  installMenu(stores.settings.get().language, stores.settings.get().keybindings);
  installContextMenu();
  // Pencere denetimlerinin rengi temaya bağlı; "sistem" seçiliyken işletim sistemi değişince de.
  setThemeDark(isDarkTheme(stores.settings.get().theme));
  nativeTheme.on("updated", () => {
    if (stores.settings.get().theme === "sistem") setThemeDark(nativeTheme.shouldUseDarkColors);
  });
  applyTray(stores.settings.get().menubar, stores.settings.get().language);
  applyLoginItem(stores.settings.get().startup);
  setKeepAwake(stores.settings.get().keepAwake);
  startArchiveSweep(context);
  startUpdater(stores.settings.get().autoUpdate);
  // Geliştirmede Dock simgesi Electron'un kendi simgesi olur; paketli sürüm icns kullanır.
  // "DEV" rozeti yayın sürümüyle karışmasın diye: ikisi aynı simgeyi taşır.
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(appIconPath());
    app.dock?.setBadge("DEV");
  }
  mainWindow = createMainWindow();
  // Yalnız ilk pencere açılış sayılır: Dock'tan yeniden açılan pencere bir açılış ölçüsü değil.
  mainWindow.once("ready-to-show", () => perf.recordSinceStart("windowReady", Date.now()));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on("window-all-closed", () => {
  // Menü çubuğu simgesi açıkken uygulama arka planda kalır; simgeden geri getirilir.
  if (process.platform !== "darwin" && !trayActive()) app.quit();
});

/** Kapanış temizliğinin üst sınırı: takılan bir MCP sunucusu uygulamayı açık tutmasın. */
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
let cleanupStarted = false;
let cleanupDone = false;

app.on("before-quit", (event) => {
  // İkinci tur: temizlik bitti, `app.quit()` yeniden çağrıldı; kapanış olağan akışla sürer.
  if (cleanupDone) return;
  const updating = isQuittingForUpdate();
  // Kapanış, motor kapanana kadar ertelenir: önceden `engine.dispose()` beklenmiyor, süreç MCP
  // bağlantılarını ve alt süreçleri kapatmadan çıkıyordu. Güncelleme kurulumunda ertelenmez.
  if (!updating) event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  disposeTray();
  stopNetworkWatch?.();
  clearInterval(archiveTimer);
  scheduler?.stop();
  // Çalışan kontrol komutları (ör. uzun `pnpm test`) kapanışta sahipsiz kalmasın.
  disposeChecks();
  const cleanup = Promise.allSettled([ctx?.terminals.dispose(), ctx?.engine.dispose()]);
  if (updating) {
    cleanupDone = true;
    return;
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CLEANUP_TIMEOUT_MS));
  void Promise.race([cleanup, timeout]).then(() => {
    cleanupDone = true;
    // Bir sonraki tura ertelenir: temizlik anında biterse bu microtask, Electron'un ilk (bizim
    // ertelediğimiz) `Quit()` çağrısı dönmeden çalışır. O çağrı dönüşte "çıkılıyor" durumunu
    // sıfırlar; pencere kapanır ama uygulama açık kalır, ancak ikinci çıkışta kapanırdı.
    setImmediate(() => app.quit());
  });
});
