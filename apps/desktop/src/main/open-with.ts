import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { OpenWithApp } from "@codezal/contracts";
import { app, shell } from "electron";
import { log } from "./log.js";

const run = promisify(execFile);

type AppKind = "editor" | "terminal";

interface AppDef {
  id: string;
  name: string;
  kind: AppKind;
  /** macOS paket adı: kurulu tespiti, ikon kaynağı ve `open -a` hedefi. */
  mac?: string;
  /** PATH'teki CLI komutu (ör. `code`, `cursor`). */
  cli?: string;
  /** Windows'ta aranan yollar; `%VAR%` ortam değişkeniyle genişletilir. */
  win?: string[];
  /** CLI argüman şablonu; `{cwd}` proje klasörüyle değişir (varsayılan: yalnız klasör).
   *  Çalışma dizinini bayrakla alan terminallerde doğru klasörü açmak için şarttır. */
  args?: string[];
}

/**
 * Desteklenen harici uygulamalar. Yalnız sistemde kurulu olanlar listeye girer; komut ve yollar
 * main'de kalır, renderer'a sadece id/ad/simge gider (bkz. `OpenWithApp`).
 */
const APPS: AppDef[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    kind: "editor",
    mac: "Visual Studio Code",
    cli: "code",
    win: [
      "%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe",
      "%ProgramFiles%/Microsoft VS Code/Code.exe",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    mac: "Cursor",
    cli: "cursor",
    win: ["%LOCALAPPDATA%/Programs/cursor/Cursor.exe"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "editor",
    mac: "Windsurf",
    cli: "windsurf",
    win: ["%LOCALAPPDATA%/Programs/WindSurf/WindSurf.exe"],
  },
  { id: "zed", name: "Zed", kind: "editor", mac: "Zed", cli: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    kind: "editor",
    mac: "Sublime Text",
    cli: "subl",
    win: ["%ProgramFiles%/Sublime Text/sublime_text.exe"],
  },
  { id: "nova", name: "Nova", kind: "editor", mac: "Nova" },
  { id: "intellij", name: "IntelliJ IDEA", kind: "editor", mac: "IntelliJ IDEA", cli: "idea" },
  { id: "webstorm", name: "WebStorm", kind: "editor", mac: "WebStorm", cli: "webstorm" },
  { id: "pycharm", name: "PyCharm", kind: "editor", mac: "PyCharm", cli: "pycharm" },
  { id: "phpstorm", name: "PhpStorm", kind: "editor", mac: "PhpStorm", cli: "phpstorm" },
  { id: "goland", name: "GoLand", kind: "editor", mac: "GoLand", cli: "goland" },
  { id: "terminal", name: "Terminal", kind: "terminal", mac: "Terminal" },
  { id: "iterm", name: "iTerm", kind: "terminal", mac: "iTerm" },
  { id: "warp", name: "Warp", kind: "terminal", mac: "Warp" },
  {
    id: "ghostty",
    name: "Ghostty",
    kind: "terminal",
    mac: "Ghostty",
    cli: "ghostty",
    // Ghostty'de her config anahtarı CLI bayrağı olarak geçerli.
    args: ["--working-directory={cwd}"],
  },
  {
    id: "kitty",
    name: "kitty",
    kind: "terminal",
    mac: "kitty",
    cli: "kitty",
    args: ["--directory", "{cwd}"],
  },
  {
    id: "wezterm",
    name: "WezTerm",
    kind: "terminal",
    mac: "WezTerm",
    cli: "wezterm",
    args: ["start", "--cwd", "{cwd}"],
  },
  {
    id: "alacritty",
    name: "Alacritty",
    kind: "terminal",
    mac: "Alacritty",
    cli: "alacritty",
    args: ["--working-directory", "{cwd}"],
  },
  { id: "hyper", name: "Hyper", kind: "terminal", mac: "Hyper" },
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    kind: "terminal",
    cli: "wt",
    args: ["-d", "{cwd}"],
  },
  {
    id: "gnome-terminal",
    name: "GNOME Terminal",
    kind: "terminal",
    cli: "gnome-terminal",
    args: ["--working-directory={cwd}"],
  },
];

/** Dosya yöneticisi satırının kimliği; etiketi arayüz sözlüğünden gelir (platforma göre değişir). */
export const FILE_MANAGER_ID = "finder";

const FINDER_APP = "/System/Library/CoreServices/Finder.app";

/** Simge alınamadıysa da öğe listede kalır (arayüz glif çizer), o yüzden `null` önbelleğe yazılır. */
const iconCache = new Map<string, string | null>();

function expandWin(template: string): string {
  return template.replace(/%([A-Za-z_]+)%/g, (_, name: string) => process.env[name] ?? "");
}

function macAppPath(name: string): string | undefined {
  const roots = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    // Terminal ve konsol araçları burada durur.
    "/System/Applications/Utilities",
    join(homedir(), "Applications"),
  ];
  return roots.map((root) => join(root, `${name}.app`)).find((candidate) => existsSync(candidate));
}

/**
 * PATH taraması `which` alt sürecinden ucuz. Windows'ta yalnız `.exe`/`.com` sayılır: `.cmd` ve
 * `.bat` kabuk betiğidir, Node (CVE-2024-27980 sonrası) onları kabuksuz başlatmaz (EINVAL);
 * menüde tıklanınca hata veren satır göstermektense satır hiç çıkmaz.
 */
function commandOnPath(command: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** PATH'te aynı adlı ama çalıştırılamayan bir dosya (`code` klasörü gibi) kurulu sayılmaz. */
function isExecutable(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface Detected {
  appPath?: string;
  command?: string;
}

function detect(def: AppDef): Detected | undefined {
  if (process.platform === "darwin") {
    // macOS'ta tek ölçüt paketin varlığı: CLI kurulu olsa da uygulama yoksa satır gösterilmez.
    const appPath = def.mac ? macAppPath(def.mac) : undefined;
    return appPath ? { appPath } : undefined;
  }
  if (process.platform === "win32") {
    const fromWin = def.win?.map(expandWin).find((candidate) => candidate && existsSync(candidate));
    if (fromWin) return { appPath: fromWin };
  }
  const command = def.cli ? commandOnPath(def.cli) : undefined;
  return command ? { command } : undefined;
}

/** Menüde 15px gösterilecek simge: 32pt@2x (ic11) tam ölçek, yoksa sırayla büyüğe çıkılır. */
const ICNS_PNG_ORDER = ["ic11", "ic12", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * `.icns` içinden PNG kodlu öğeyi seçer. macOS'ta `app.getFileIcon` .app paketleri için
 * jenerik dosya simgesi döndürüyor (ölçüldü: Finder ve Cursor aynı çıktıyı veriyor), bu yüzden
 * uygulamaya özel simge paketin kendi kaynağından alınır — ayrıştırma için ek bağımlılık yok.
 */
export function pngFromIcns(data: Buffer): Buffer | undefined {
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "icns") return undefined;
  const elements = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) break;
    const payload = data.subarray(offset + 8, offset + length);
    if (payload.subarray(0, 8).equals(PNG_MAGIC)) elements.set(type, payload);
    offset += length;
  }
  for (const type of ICNS_PNG_ORDER) {
    const png = elements.get(type);
    if (png) return Buffer.from(png);
  }
  return undefined;
}

/** Paketin `Resources` klasöründeki simge dosyası: paket adı, `AppIcon.icns`, yoksa tek `.icns`. */
async function icnsPathFor(appPath: string): Promise<string | undefined> {
  const resources = join(appPath, "Contents", "Resources");
  const names = (await readdir(resources)).filter((name) => name.toLowerCase().endsWith(".icns"));
  if (names.length === 0) return undefined;
  const bundle = basename(appPath, ".app").toLowerCase();
  const pick =
    names.find((name) => name.toLowerCase() === `${bundle}.icns`) ??
    names.find((name) => name.toLowerCase() === "appicon.icns") ??
    names[0];
  return pick ? join(resources, pick) : undefined;
}

/**
 * Uygulamaya özel simge; paket simgeyi asset catalog'da tutuyorsa `null` döner. Okuma asenkron:
 * `.icns` dosyaları birkaç MB olabiliyor, eşzamanlı okuma main süreci ve tüm IPC'yi durdururdu.
 */
async function icnsDataUrl(appPath: string): Promise<string | null> {
  if (process.platform !== "darwin" || !appPath.endsWith(".app")) return null;
  try {
    const icns = await icnsPathFor(appPath);
    if (!icns) return null;
    const png = pngFromIcns(await readFile(icns));
    return png ? `data:image/png;base64,${png.toString("base64")}` : null;
  } catch (error) {
    log.warn("open-with", `icns okunamadı (${appPath}): ${String(error)}`);
    return null;
  }
}

async function fileIconDataUrl(source: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(source, { size: "normal" });
    return image.isEmpty() ? null : image.toDataURL();
  } catch (error) {
    log.warn("open-with", `simge alınamadı (${source}): ${String(error)}`);
    return null;
  }
}

async function iconFor(source: string | undefined): Promise<string | null> {
  if (!source) return null;
  const cached = iconCache.get(source);
  if (cached !== undefined) return cached;
  // macOS paketinde jenerik dosya simgesine düşmek yanıltıcı olurdu; glif daha açıklayıcı.
  const bundle = process.platform === "darwin" && source.endsWith(".app");
  const dataUrl = (await icnsDataUrl(source)) ?? (bundle ? null : await fileIconDataUrl(source));
  iconCache.set(source, dataUrl);
  return dataUrl;
}

/** Kurulu uygulamaları döner; Finder/dosya yöneticisi her zaman ilk sırada. */
export async function listOpenWithApps(): Promise<OpenWithApp[]> {
  const rows: Array<{ app: OpenWithApp; source: string | undefined }> = [
    {
      app: { id: FILE_MANAGER_ID, name: "Finder", kind: "finder", iconDataUrl: null },
      source: process.platform === "darwin" ? FINDER_APP : undefined,
    },
  ];
  for (const def of APPS) {
    const detected = detect(def);
    if (!detected) continue;
    rows.push({
      app: { id: def.id, name: def.name, kind: def.kind, iconDataUrl: null },
      source: detected.appPath,
    });
  }
  // Simgeler paralel alınır: sıralı bekleme ilk açılışta düğmeyi geciktiriyordu.
  return Promise.all(
    rows.map(async (row) => ({ ...row.app, iconDataUrl: await iconFor(row.source) })),
  );
}

function requireDirectory(target: string): string {
  const directory = resolve(target);
  const stat = statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`klasör bulunamadı: ${directory}`);
  return directory;
}

function defById(appId: string): AppDef {
  const def = APPS.find((candidate) => candidate.id === appId);
  if (!def) throw new Error(`bilinmeyen uygulama: ${appId}`);
  return def;
}

/** CLI argümanlarını üretir; `{cwd}` proje klasörüyle değişir, her argüman ayrı kalır. */
export function expandArgs(template: string[] | undefined, directory: string): string[] {
  // Değiştirme işlevle yapılır: düz metin verilseydi yoldaki `$&`, `$'` kalıp sayılırdı.
  return (template ?? ["{cwd}"]).map((arg) => arg.replace("{cwd}", () => directory));
}

async function openFileManager(directory: string): Promise<void> {
  if (process.platform === "darwin" || process.platform === "win32") {
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return;
  }
  await run("xdg-open", [directory]);
}

/**
 * Uygulamayı ayrık süreç olarak başlatır ve yalnız başlamasını bekler. `execFile` çocuğun
 * çıkışını beklerdi: terminal emülatörü pencere kapanana dek yaşadığından IPC çağrısı asılı
 * kalıyor, çıktısı 1 MB'ı aşınca da terminal öldürülüyordu (bkz. `openInTerminal`).
 */
function spawnDetached(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}

async function launch(def: AppDef, detected: Detected, directory: string): Promise<void> {
  // Kabuk açılmaz, argümanlar ayrık gider: yol içindeki boşluk ya da `--flag` komuta karışmaz.
  const args = expandArgs(def.args, directory);
  if (process.platform === "darwin" && detected.appPath) {
    // `open` hemen döner. Dizini bayrakla alan terminaller (kitty, WezTerm...) argümanlarıyla
    // yeni örnekte açılır: `-n` olmadan çalışan örnek `--args`'ı yok sayar. CLI denenmez;
    // Ghostty'nin CLI'ı macOS'ta pencere açmıyor, ötekiler de terminal kapanana dek dönmüyor.
    const openArgs = def.args
      ? ["-n", "-a", detected.appPath, "--args", ...args]
      : ["-a", detected.appPath, directory];
    await run("open", openArgs);
    return;
  }
  const command = detected.command ?? detected.appPath;
  if (!command) throw new Error(`${def.name} için çalıştırılabilir dosya bulunamadı`);
  await spawnDetached(command, args, directory);
}

/** Klasörü seçilen uygulamada açar. */
export async function openWith(appId: string, target: string): Promise<void> {
  const directory = requireDirectory(target);
  if (appId === FILE_MANAGER_ID) {
    await openFileManager(directory);
    return;
  }
  const def = defById(appId);
  const detected = detect(def);
  if (!detected) throw new Error(`${def.name} kurulu görünmüyor`);
  await launch(def, detected, directory);
}
