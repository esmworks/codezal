import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Bash korumalı alanı (macOS Seatbelt). "Tam erişim"de bile ajanın `cat keys.json` ile anahtar
 * havuzunu okuyabilmesi ve çalışma klasörü dışına yazabilmesi kapatılır: komut
 * `sandbox-exec -p <profil>` altında koşar. Ağ açık kalır; yalnız dosya yazımı ve veri kökü sınırlanır.
 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Çağrı anındaki karar: kapalı, açık (profille) ya da açık ama `sandbox-exec` yok. */
export type SandboxDecision =
  | { kind: "off" }
  | { kind: "on"; profile: string }
  | { kind: "missing" };

export interface SandboxSpec {
  /** Yazılabilir kökler (alt ağaçlarıyla). */
  writable: readonly string[];
  /** Okuma ve yazmaya kapalı kökler (Codezal veri klasörü). */
  denied: readonly string[];
}

/** SBPL dize sabiti: ters bölü ve çift tırnak kaçırılır (yol içinde `"` profili bozmasın). */
export function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Yolun mutlak ve gerçek (symlink çözülmüş) hâlleri. Seatbelt çözülmüş yolla eşleşir: macOS'ta
 * `/tmp` → `/private/tmp`, `$TMPDIR` → `/private/var/folders/...`. Yazılan hâl de tutulur.
 */
export function pathVariants(path: string): string[] {
  const abs = resolve(path);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // Henüz yoksa (ör. ~/go/pkg) yazıldığı gibi kalır.
  }
  return real === abs ? [abs] : [real, abs];
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const unique = (items: string[]): string[] => [...new Set(items)];

const subpaths = (paths: readonly string[]): string =>
  paths.map((p) => `(subpath ${sbplString(p)})`).join(" ");

/**
 * Profil. SBPL'de sonraki kural öncekini ezer: önce her şey serbest, sonra yazma kapanır,
 * yazılabilir kökler açılır, veri kökü okuma+yazmaya kapanır ve en sonda veri kökünün **içindeki**
 * yazılabilir kökler (Asistan oturumlarının çalışma klasörü `userData/asistan/...`) yeniden açılır.
 * Böylece çalışma klasörü `~` gibi veri kökünü kapsasa da veri kökü kapalı kalır.
 */
export function sandboxProfile(spec: SandboxSpec): string {
  const writable = unique(spec.writable.filter(Boolean).flatMap(pathVariants));
  const denied = unique(spec.denied.filter(Boolean).flatMap(pathVariants));
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  if (writable.length > 0) lines.push(`(allow file-write* ${subpaths(writable)})`);
  if (denied.length > 0) {
    lines.push(`(deny file-read* file-write* ${subpaths(denied)})`);
    const reopened = writable.filter((w) => denied.some((d) => isInside(w, d)));
    if (reopened.length > 0) lines.push(`(allow file-read* file-write* ${subpaths(reopened)})`);
  }
  return `${lines.join("\n")}\n`;
}

export interface SandboxPathsInput {
  cwd: string;
  /** Oturumun çıktı klasörü (Asistan). */
  outputsDir?: string | undefined;
  /** Codezal veri kökü; okuma ve yazmaya kapanır. */
  userDataDir?: string | undefined;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Varsayılan yazılabilir kökler: çalışma klasörü, çıktı klasörü, geçici klasörler, yaygın paket
 * önbellekleri (npm/pnpm/cargo/go kurulumları önbelleğe yazamazsa düşer) ve `/dev` (`/dev/null`).
 */
export function sandboxSpec(input: SandboxPathsInput): SandboxSpec {
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const writable = [
    input.cwd,
    input.outputsDir ?? "",
    "/private/tmp",
    "/private/var/folders",
    env.TMPDIR ?? "",
    tmpdir(),
    join(home, "Library", "Caches"),
    join(home, ".npm"),
    join(home, "Library", "pnpm"),
    join(home, ".cache"),
    join(home, ".cargo", "registry"),
    join(home, "go", "pkg"),
    "/dev",
  ];
  return { writable, denied: input.userDataDir ? [input.userDataDir] : [] };
}

/** Korumalı alan bu makinede kurulabilir mi (macOS ve `sandbox-exec` mevcut). */
export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/**
 * Ayar ve platforma göre karar. macOS dışında ayar etkisizdir (`off`); `sandbox-exec` yoksa
 * `missing` döner ve komut korumasız koşar (araç sonucu bir kez uyarır).
 */
export function sandboxDecision(enabled: boolean, input: SandboxPathsInput): SandboxDecision {
  if (!enabled || process.platform !== "darwin") return { kind: "off" };
  if (!existsSync(SANDBOX_EXEC)) return { kind: "missing" };
  return { kind: "on", profile: sandboxProfile(sandboxSpec(input)) };
}

/** POSIX tek tırnak kaçışı. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Pi'nin yerleşik yürütücüsü yalnız komut dizesini değiştirmeye izin verir (`spawnHook`): dış
 * kabuk `sandbox-exec`e devreder (`exec`; pid aynı kalır, durdurma süreç ağacını yine bulur),
 * komut korumalı alanda aynı kabukla çalışır.
 */
export function sandboxCommand(
  command: string,
  profile: string,
  shell: string,
  shellArgs: readonly string[],
): string {
  const args = [shell, ...shellArgs, command].map(shellQuote).join(" ");
  return `exec ${SANDBOX_EXEC} -p ${shellQuote(profile)} ${args}`;
}

/** Süreci doğrudan doğuran yol (arka plan görevleri): argv düzeyinde sarar, kaçış gerekmez. */
export function sandboxArgv(
  profile: string,
  shell: string,
  args: readonly string[],
): { shell: string; args: string[] } {
  return { shell: SANDBOX_EXEC, args: ["-p", profile, shell, ...args] };
}
