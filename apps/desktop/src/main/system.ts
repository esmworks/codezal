import { dict, type Locale } from "@codezal/i18n";
import { app, BrowserWindow, Menu, nativeImage, powerSaveBlocker, Tray } from "electron";
import { log } from "./log.js";
import { trayIconPath } from "./paths.js";
import { createMainWindow } from "./window.js";

// İşletim sistemi tümleşiği: menü çubuğu simgesi ve oturum açılışında başlatma.

let tray: Tray | undefined;

/** Menü çubuğu simgesi açıkken pencere kapansa bile uygulama arka planda kalır. */
export function trayActive(): boolean {
  return tray !== undefined;
}

function show(): void {
  const win = BrowserWindow.getAllWindows()[0] ?? createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function send(command: "new-task" | "settings"): void {
  show();
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send("app:command", { command });
}

function buildMenu(locale: Locale): Menu {
  const d = dict(locale);
  return Menu.buildFromTemplate([
    { label: d.menu.show, click: show },
    { type: "separator" },
    { label: d.menu.newTask, click: () => send("new-task") },
    { label: d.menu.settings, click: () => send("settings") },
    { type: "separator" },
    { role: "quit", label: process.platform === "darwin" ? d.menu.quit : d.menu.quitWin },
  ]);
}

/**
 * Ayarlar > Genel > "Menü çubuğunda göster". macOS'ta şablon simge (sistem tema rengine boyar),
 * diğer platformlarda 16px'e küçültülmüş uygulama simgesi kullanılır. Dil değişince menü yenilenir.
 */
export function applyTray(enabled: boolean, locale: Locale): void {
  if (!enabled) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (!tray) {
    const mac = process.platform === "darwin";
    const image = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(mac ? image : image.resize({ width: 16, height: 16 }));
    tray.setToolTip("Codezal");
    // macOS'ta menü tıklamayla zaten açılır; Windows/Linux'ta sol tık pencereyi getirir.
    if (!mac) tray.on("click", show);
  }
  tray.setContextMenu(buildMenu(locale));
}

export function disposeTray(): void {
  tray?.destroy();
  tray = undefined;
}

/**
 * Ayarlar > Genel > "Başlangıçta çalıştır". Electron bunu yalnız macOS ve Windows'ta uygular;
 * geliştirmede ikili `node_modules/electron` olduğu için hiç dokunulmaz. macOS 13+ kaydı
 * reddedebilir (uygulama izinli bir konumda değilse) ve Electron yalnız stderr'e yazar; gerçekleşen
 * durum okunup döner, çağıran anahtarı ona göre düzeltir. "requires-approval" da açık sayılır:
 * kayıt vardır, kullanıcı Sistem Ayarları > Genel > Açılış Öğeleri'nden onaylar.
 */
export function applyLoginItem(enabled: boolean): boolean {
  if (!app.isPackaged) return enabled;
  if (process.platform !== "darwin" && process.platform !== "win32") return enabled;
  app.setLoginItemSettings({ openAtLogin: enabled });
  const state = app.getLoginItemSettings();
  const on =
    process.platform === "darwin"
      ? state.status === "enabled" || state.status === "requires-approval"
      : state.openAtLogin;
  if (on !== enabled)
    log.error("loginItem", `istenen: ${enabled}, sistem: ${state.status ?? state.openAtLogin}`);
  return on;
}

// ---------- Uyku engeli ----------

let awakeEnabled = false;
/**
 * Oturum başına süren tur sayısı. Tek bir genel sayaç, `run_end` hiç gelmeyen turda (oturum tur
 * sırasında silindi/kapandı) sonsuza dek artık kalıyor ve makineyi uyanık tutuyordu; oturum
 * kimliğine bağlı sayım, oturum gidince (`sessionGone`) toptan düşürülebilir.
 */
const runningTurns = new Map<string, number>();
let blocker: number | undefined;

/**
 * Ayar açıkken yalnız ajan turu sürerken uyku engellenir; boşta duran uygulama makineyi
 * gece boyu ayakta tutmaz. `prevent-app-suspension` ekranın kapanmasına karışmaz.
 */
function syncBlocker(): void {
  const want = awakeEnabled && runningTurns.size > 0;
  if (want && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
  else if (!want && blocker !== undefined) {
    powerSaveBlocker.stop(blocker);
    blocker = undefined;
  }
}

/** Ayarlar > Genel > "Bilgisayarı uyanık tut". */
export function setKeepAwake(enabled: boolean): void {
  awakeEnabled = enabled;
  syncBlocker();
}

export function turnStarted(sessionId: string): void {
  runningTurns.set(sessionId, (runningTurns.get(sessionId) ?? 0) + 1);
  syncBlocker();
}

export function turnEnded(sessionId: string): void {
  const left = (runningTurns.get(sessionId) ?? 0) - 1;
  if (left > 0) runningTurns.set(sessionId, left);
  else runningTurns.delete(sessionId);
  syncBlocker();
}

/** Oturum silindi/kapandı: `run_end` gelmemiş olsa da o oturumun turları bitmiş sayılır. */
export function sessionGone(sessionId: string): void {
  if (runningTurns.delete(sessionId)) syncBlocker();
}
