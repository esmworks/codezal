import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Dock/Finder'dan açılan Electron, login kabuğun PATH'ini miras almaz: nvm, Homebrew ve
 * `~/.local/bin` görünmez olur ve alt süreçler (`npm install`) `spawn npm ENOENT` ile düşer.
 * Bu modül login kabuktan PATH'i alıp süreç ortamına ekler; alınamazsa bilinen kurulum
 * dizinleri düşük öncelikle eklenir. PATH'i yalnız genişletir, mevcut girdiler korunur.
 */

/** Kabuk profili çıktısını (ör. conda mesajı) PATH'ten ayıran sentinel. */
export const PATH_BEGIN = "__CODEZAL_PATH_BEGIN__";
export const PATH_END = "__CODEZAL_PATH_END__";

/** nvm'in varsayılan alias sürümü ya da en yüksek sürümü: bin dizini (yoksa null). */
function nvmBinDir(): string | null {
  const root = join(homedir(), ".nvm", "versions", "node");
  const candidates: string[] = [];
  try {
    const alias = readFileSync(join(homedir(), ".nvm", "alias", "default"), "utf8").trim();
    if (/^v\d+\./.test(alias)) candidates.push(alias);
  } catch {
    // `alias/default` yoksa yalnız sürüm dizinleri denenir.
  }
  try {
    const versions = readdirSync(root)
      .filter((name) => /^v\d+\./.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    candidates.push(...versions);
  } catch {
    return null;
  }
  for (const name of candidates) {
    const dir = join(root, name, "bin");
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Kabuk PATH'i alınamadığında düşük öncelikle denenecek yaygın Node kurulum dizinleri. */
function fallbackDirs(): string[] {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const programFiles = process.env.ProgramFiles;
    return [
      process.env.NVM_SYMLINK ?? "",
      appData ? join(appData, "npm") : "",
      programFiles ? join(programFiles, "nodejs") : "",
    ];
  }
  return [
    join(homedir(), ".local", "bin"),
    join(homedir(), "Library", "pnpm"),
    nvmBinDir() ?? "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Kök dışında sondaki ayraçları kırpar: aynı dizin iki kez PATH'e girmesin. */
function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/[/\\]+$/, "") : dir;
}

/** Kabuk PATH'i önce, mevcut PATH sonra, yedekler en sonda; boş ve tekrarlı girdiler atılır. */
export function mergePath(
  shellPath: string | undefined,
  currentPath: string,
  extra: string[] = [],
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [shellPath ?? "", currentPath, ...extra].join(delimiter).split(delimiter)) {
    const dir = normalizeDir(raw.trim());
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(delimiter);
}

/** Sentinel'ler arasındaki PATH; sentinel yoksa undefined (profil çıktısı PATH sanılmaz). */
export function extractSentinelPath(
  stdout: string,
  begin = PATH_BEGIN,
  end = PATH_END,
): string | undefined {
  const start = stdout.lastIndexOf(begin);
  if (start < 0) return undefined;
  const stop = stdout.indexOf(end, start + begin.length);
  if (stop < 0) return undefined;
  const value = stdout.slice(start + begin.length, stop).trim();
  return value === "" ? undefined : value;
}

/** Etkileşimli login kabuktan PATH; profil çıktısı sentinel ile ayıklanır. */
function loginShellPath(shell: string): string | undefined {
  try {
    const command = `printf '%s' '${PATH_BEGIN}'"$PATH"'${PATH_END}'`;
    const result = spawnSync(shell, ["-ilc", command], {
      encoding: "utf8",
      timeout: 3_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return undefined;
    return extractSentinelPath(result.stdout ?? "");
  } catch {
    return undefined;
  }
}

export interface EnsurePathOptions {
  shell?: string | undefined;
  /** Test için: kabuk PATH'i okuyucusu. */
  shellPath?: (shell: string) => string | undefined;
  /** Test için: yedek dizin listesi (yalnız var olanlar eklenir). */
  dirs?: string[];
}

/**
 * Sürecin PATH'ini zenginleştirir. Main girişinde bir kez çağrılır; spawn edilen tüm alt
 * süreçler (npm, git, bash aracı, eklenti runner'ları) bu ortamı miras alır.
 */
export function ensureUserPathOnEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: EnsurePathOptions = {},
): void {
  const shell =
    options.shell ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const read = options.shellPath ?? loginShellPath;
  const fromShell = process.platform === "win32" ? undefined : read(shell);
  const extra = (options.dirs ?? fallbackDirs()).filter((dir) => dir && existsSync(dir));
  const next = mergePath(fromShell, env.PATH ?? "", extra);
  if (next) env.PATH = next;
}
