import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

export interface AppPaths {
  userData: string;
  agentDir: string;
  sessionsDir: string;
  /** Plan modunda yazılan plan dosyaları (plans/<proje>/<oturum>.md). */
  plansDir: string;
  /** Günlük dosyalarının klasörü: `codezal.log` ve ayrıntılı günlük `codezal-debug.log`. */
  logsDir: string;
  /** Oturum başına NDJSON ajan olay izi (`agent-events/<oturum>.ndjson`). */
  agentEventsDir: string;
  /** Güvenlik denetimi run'ları (`audits/<depo>/run-N`); skill'in beklediği dosya düzeni burada. */
  auditsDir: string;
  /** Kod incelemesi kayıtları (`reviews/<depo>/<oturum>.jsonl`). */
  reviewsDir: string;
  /** Kullanıcı ajan tanımları (`agents/<ad>.md`) — Ayarlar > Ajanlar sayfası. */
  agentsDir: string;
  /** Ajanların açma/kapama durumu (`agents-state.json`); tanım dosyalarına dokunulmaz. */
  agentsStateFile: string;
  documents: string;
  home: string;
}

/** PRD §7.6: userData altında pi/, sessions/ ve plans/ dizinleri. */
export function ensureAppPaths(): AppPaths {
  const userData = app.getPath("userData");
  const agentDir = join(userData, "pi");
  const sessionsDir = join(userData, "sessions");
  const plansDir = join(userData, "plans");
  const logsDir = join(userData, "logs");
  const agentEventsDir = join(userData, "agent-events");
  const auditsDir = join(userData, "audits");
  const reviewsDir = join(userData, "reviews");
  const agentsDir = join(userData, "agents");
  const agentsStateFile = join(userData, "agents-state.json");
  for (const dir of [
    agentDir,
    sessionsDir,
    plansDir,
    logsDir,
    agentEventsDir,
    auditsDir,
    reviewsDir,
    agentsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    userData,
    agentDir,
    sessionsDir,
    plansDir,
    logsDir,
    agentEventsDir,
    auditsDir,
    reviewsDir,
    agentsDir,
    agentsStateFile,
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  };
}

/**
 * Windows'ta veri kökü `%LOCALAPPDATA%` altında tutulur. Electron'un `userData` varsayılanı
 * Roaming'dir; oturum NDJSON'ları, tur yedekleri ve ajan izleri oraya yazıldığında kurumsal
 * makinelerde roaming profille senkronlanır: yavaş oturum açma, kota ve dosya kilidi (EBUSY).
 */
export function windowsDataRoot(env: NodeJS.ProcessEnv, fallback: string): string {
  const local = env.LOCALAPPDATA?.trim();
  return local ? join(local, "Codezal") : fallback;
}

/**
 * Eski (Roaming) veri klasörünü yeni köke taşır: önce `rename`, farklı birimde kopyala-sil.
 * Yalnız hedef yokken çalışır; taşıma başarısız olursa eski veri silinmez, yeni kök boş başlar.
 */
export function migrateUserData(from: string, to: string): boolean {
  if (from === to || !existsSync(from) || existsSync(to)) return false;
  // Kopyalama yarıda kalırsa hedefte yarım kök kalır ve sonraki açılışlar "hedef var" sanıp
  // taşımayı atlar. Bu yüzden önce geçici klasöre kopyalanır, tamamlanınca hedefe taşınır.
  const staging = `${to}.tmp`;
  try {
    mkdirSync(dirname(to), { recursive: true });
    rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    try {
      renameSync(from, to);
    } catch {
      cpSync(from, staging, { recursive: true });
      renameSync(staging, to);
      rmSync(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return true;
  } catch {
    // Yarım kalan geçici klasör sonraki denemeyi kirletmesin.
    try {
      rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // temizlik de başarısızsa sonraki açılış yeniden dener
    }
    return false;
  }
}

/**
 * Uygulama simgesi: paketli sürümde extraResources, geliştirmede build/ klasörü. Giriş dosyası
 * doğrudan verilerek açıldığında (`electron out/main/index.mjs`) getAppPath out/main olur; o zaman
 * bundle konumuna göre çözülür.
 */
export function appIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "icon.png");
  const fromApp = join(app.getAppPath(), "build", "icon.png");
  if (existsSync(fromApp)) return fromApp;
  return fileURLToPath(new URL("../../build/icon.png", import.meta.url));
}

/**
 * Menü çubuğu simgesi. macOS'ta şablon görsel (siyah + saydam; sistem rengi verir, `@2x` eşlik
 * eder), diğer platformlarda uygulama simgesi. Paketli sürümde extraResources'tan gelir.
 */
export function trayIconPath(): string {
  if (process.platform !== "darwin") return appIconPath();
  if (app.isPackaged) return join(process.resourcesPath, "trayTemplate.png");
  const fromApp = join(app.getAppPath(), "build", "trayTemplate.png");
  if (existsSync(fromApp)) return fromApp;
  return fileURLToPath(new URL("../../build/trayTemplate.png", import.meta.url));
}
