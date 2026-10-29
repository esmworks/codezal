import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@codezal/agent";
import type { AppSettings } from "@codezal/contracts";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  nativeTheme,
  screen,
} from "electron";
import { appIconPath } from "./paths.js";

// Tema token'larının pencere karşılıkları (packages/ui/src/tokens.css: --bg ve --tx).
const DARK_BG = "#17191c";
const LIGHT_BG = "#ffffff";
const DARK_TX = "#e7eaed";
const LIGHT_TX = "#1c2126";

/** Başlık şeridi yüksekliği; arayüzdeki `TitleBar` ile aynı (34px). */
const TITLE_BAR_HEIGHT = 34;
const WINDOW_STATE_PATH = "window-state.json";
const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface DisplayWorkArea {
  workArea: { x: number; y: number; width: number; height: number };
}

/** Bozuk/eski kayıtların pencereyi ekran dışına ya da kullanılamaz boyuta taşımamasını sağlar. */
export function parseWindowState(value: string, displays: DisplayWorkArea[]): WindowState | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as Record<string, unknown>;
    const { x, y, width, height, isMaximized } = state;
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      typeof y !== "number" ||
      !Number.isFinite(y) ||
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width < MIN_WIDTH ||
      typeof height !== "number" ||
      !Number.isFinite(height) ||
      height < MIN_HEIGHT ||
      typeof isMaximized !== "boolean"
    ) {
      return null;
    }

    const visibleOnDisplay = displays.some(({ workArea }) => {
      const overlapWidth =
        Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
      const overlapHeight =
        Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
      return overlapWidth >= 64 && overlapHeight >= TITLE_BAR_HEIGHT;
    });
    return visibleOnDisplay ? { x, y, width, height, isMaximized } : null;
  } catch {
    return null;
  }
}

function readWindowState(): WindowState | null {
  try {
    return parseWindowState(
      readFileSync(`${app.getPath("userData")}/${WINDOW_STATE_PATH}`, "utf8"),
      screen.getAllDisplays(),
    );
  } catch {
    return null;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  const state: WindowState = { ...bounds, isMaximized: win.isMaximized() };
  try {
    // Atomik: kapanışta yarım yazılan dosya bir sonraki açılışta boyutu varsayılana düşürmesin.
    writeFileAtomic(`${app.getPath("userData")}/${WINDOW_STATE_PATH}`, JSON.stringify(state));
  } catch (error) {
    console.error("Pencere boyutu kaydedilemedi:", error);
  }
}

/** Ayardaki tema seçimi pencere için koyu/açık'a indirgenir ("sistem" işletim sistemine sorar). */
export function isDarkTheme(theme: AppSettings["theme"]): boolean {
  if (theme === "koyu") return true;
  if (theme === "açık") return false;
  return nativeTheme.shouldUseDarkColors;
}

/**
 * Windows ve Linux'ta pencere denetimleri (küçült / büyüt / kapat) sisteme çizdirilir: başlık
 * çubuğu gizli kalır ama denetimler sağ üstte durur, Windows 11'in Snap Layouts menüsü ve
 * erişilebilirlik korunur. macOS'ta karşılığı trafik ışıklarıdır, ayrıca bir şey gerekmez.
 */
function overlay(dark: boolean): { color: string; symbolColor: string; height: number } {
  return {
    color: dark ? DARK_BG : LIGHT_BG,
    symbolColor: dark ? DARK_TX : LIGHT_TX,
    height: TITLE_BAR_HEIGHT,
  };
}

// Pencere açılışta ve tema değişince aynı değeri kullanır; menü çubuğu simgesinden açılan
// pencere de doğru renkle gelsin diye süreçte tutulur.
let dark = true;

export function windowOptions(
  platform: NodeJS.Platform,
  isDark: boolean,
): BrowserWindowConstructorOptions {
  const base: BrowserWindowConstructorOptions = {
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // İlk boyamaya kadar görünen renk; açık temada koyu bir kare parlamasın.
    backgroundColor: isDark ? DARK_BG : LIGHT_BG,
    show: false,
    title: "Codezal",
  };
  if (platform === "darwin") {
    return { ...base, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 10 } };
  }
  // Çerçevesiz pencerede menü şeridi içeriğin üstünde yer kaplar; gizlenir, Alt ile geri gelir.
  // Hızlandırıcılar şerit görünmese de çalışır.
  return {
    ...base,
    titleBarStyle: "hidden",
    titleBarOverlay: overlay(isDark),
    autoHideMenuBar: true,
  };
}

/** Tema değişince açık pencerelerin denetim şeridi de yeni renge geçer. */
export function setThemeDark(isDark: boolean): void {
  dark = isDark;
  if (process.platform === "darwin") return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setTitleBarOverlay(overlay(dark));
  }
}

export function createMainWindow(): BrowserWindow {
  const savedState = readWindowState();
  const win = new BrowserWindow({
    ...windowOptions(process.platform, dark),
    ...(savedState
      ? {
          x: savedState.x,
          y: savedState.y,
          width: savedState.width,
          height: savedState.height,
        }
      : {}),
    ...(process.platform === "darwin" ? {} : { icon: appIconPath() }),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Tarayıcı paneli için <webview>.
      webviewTag: true,
    },
  });

  if (savedState?.isMaximized) win.maximize();
  win.on("close", () => saveWindowState(win));
  // Pencere açma işleyicisi `hardenWebContents` içinde tek yerde kurulur (bağlantı hedefi ayarı).
  win.once("ready-to-show", () => win.show());

  // Geliştirmede renderer konsol hatalarını terminale yansıt.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        console.error(
          `[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
        );
      }
    });
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!process.env.ELECTRON_RENDERER_URL_DISABLED && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
  return win;
}
