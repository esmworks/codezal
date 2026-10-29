import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * Ajan komutlarının kabuğu. Windows'ta Pi'nin `bash` aracıyla **aynı** çözümleme kullanılır
 * (`getShellConfig` → Git Bash): ön plan aracı, arka plan görevleri ve tur sonu kontrolleri aynı
 * kabukta koşar, bir yerde çalışan komut diğerinde PowerShell yüzünden patlamaz. POSIX'te
 * kullanıcının kabuğu ($SHELL, yoksa zsh) kullanılır; davranış eskisi gibi kalır.
 *
 * Windows'ta Git Bash yoksa PowerShell'e düşülür: `bash` aracı yine SDK'nın açık hatasını verir
 * ama kontroller ve arka plan görevleri çalışmaya devam eder.
 */
export interface AgentShell {
  shell: string;
  /** Komuttan önce kabuğa verilecek argümanlar (`-lc`, `-Command`, WSL'de `-s`). */
  args: string[];
  /** `stdin`: komut argüman olarak değil stdin'e yazılır (WSL'in eski `bash.exe -s` kipi). */
  commandTransport: "argv" | "stdin";
  /** Git Bash bulunamadıysa dolu; main bunu başlangıçta günlüğe yazar. */
  warning?: string;
}

export interface ShellRun {
  shell: string;
  args: string[];
  /** Doluysa çağıran bunu stdin'e yazıp akışı kapatmalı. */
  stdin?: string;
  /** PowerShell: çıktı UTF-8'e sabitlendi (5.1 aksi hâlde ANSI/OEM kod sayfasında yazar). */
  powershell: boolean;
}

let cached: AgentShell | undefined;

/** PowerShell (5.1 ve pwsh 7) mi? */
export function isPowerShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name.startsWith("powershell") || name === "pwsh" || name === "pwsh.exe";
}

/**
 * PowerShell 5.1 çıktısı UTF-8 olmaz: Türkçe karakterler bozuk görünür ve ajana bozuk gider.
 * `[Console]` ataması konsolsuz ortamda hata verebilir; komut bu yüzden bozulmasın diye sarmalanır.
 */
function powershellUtf8(command: string): string {
  return `try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [Text.Encoding]::UTF8; ${command}`;
}

function resolveAgentShell(): AgentShell {
  // POSIX'te kullanıcının kabuğu korunur: PATH (nvm, Homebrew) `.zprofile`/`.bash_profile`'dan
  // gelir ve zsh/bash komut kalıplarında fark yaratmaz. Asıl ayrışma Windows'ta yaşanıyordu.
  if (process.platform !== "win32") {
    return {
      // macOS'ta varsayılan zsh; Linux'ta zsh kurulu olmayabilir, POSIX kabuğa düşülür.
      shell: process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
      args: ["-lc"],
      commandTransport: "argv",
    };
  }
  try {
    const config = getShellConfig();
    const stdin = config.commandTransport === "stdin";
    return {
      shell: config.shell,
      // Giriş profili okunsun: PATH (Git, nvm) kullanıcının kabuğundaki gibi olsun.
      args: stdin ? config.args : ["-lc"],
      commandTransport: stdin ? "stdin" : "argv",
    };
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : "";
    return {
      shell: "powershell.exe",
      args: ["-Command"],
      commandTransport: "argv",
      warning: `Git Bash bulunamadı; komutlar PowerShell'de çalışacak (${reason})`,
    };
  }
}

/** Çözümleme pahalıdır (`where bash.exe`); süreç ömrü boyunca bir kez yapılır. */
export function agentShell(): AgentShell {
  cached ??= resolveAgentShell();
  return cached;
}

function runFor(config: AgentShell, command: string): ShellRun {
  const powershell = isPowerShell(config.shell);
  if (config.commandTransport === "stdin") {
    return { shell: config.shell, args: config.args, stdin: command, powershell };
  }
  return {
    shell: config.shell,
    args: [...config.args, powershell ? powershellUtf8(command) : command],
    powershell,
  };
}

/**
 * Komutu çalıştıracak kabuk, argümanlar ve (varsa) stdin içeriği. `shellOverride` motorun
 * `shell` ayarından gelir; verilirse çözümleme atlanır (testler ve özel kabuk için).
 */
export function agentShellRun(command: string, shellOverride?: string): ShellRun {
  if (!shellOverride) return runFor(agentShell(), command);
  const powershell = isPowerShell(shellOverride);
  return runFor(
    {
      shell: shellOverride,
      args: [powershell ? "-Command" : "-lc"],
      commandTransport: "argv",
    },
    command,
  );
}

/** SIGTERM'den sonra süreç grubu hâlâ yaşıyorsa SIGKILL'e geçmeden önce beklenen süre. */
export const KILL_ESCALATE_MS = 3_000;

/** Hedef hâlâ var mı; `kill(…, 0)` sinyal göndermeden yoklar. */
function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: süreç var ama sinyal yetkimiz yok; yine "yaşıyor" sayılır.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Önce süreç grubuna, olmazsa tek sürece gönderir; sinyalin gittiği hedefi döner. */
function signalTree(pid: number, signal: NodeJS.Signals): number | undefined {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return target;
    } catch {
      // Grup yoksa tek süreç denenir; o da yoksa süreç zaten ölmüş.
    }
  }
  return undefined;
}

/**
 * Süreci **ve alt süreçlerini** öldürür. Windows'ta `child.kill` yalnız kabuğu öldürür; `pnpm dev`
 * gibi komutların alt süreçleri (vite, test runner) kalır ve portu/dosyaları tutar. Bu yüzden
 * Windows'ta `taskkill /F /T`. POSIX'te çağıran süreci `detached` doğurmuş olmalı; değilse tek
 * süreç öldürülür.
 *
 * POSIX'te SIGTERM'i yok sayan (`trap "" TERM`) ya da kapanırken takılan bir süreç Durdur'dan sonra
 * sonsuza kadar yaşıyordu; araç da süreci beklediği için tur asılı kalıyordu. `escalateMs` sonra
 * grup hâlâ varsa SIGKILL gönderilir. Zamanlayıcı `unref`: uygulamanın kapanmasını bekletmez.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  escalateMs: number = KILL_ESCALATE_MS,
): void {
  if (process.platform === "win32") {
    try {
      const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      const child = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      // Başarısız doğurma "error" olayıyla gelir; yakalanmazsa süreç çöker.
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // taskkill yoksa/çalışmazsa yapılacak bir şey yok.
    }
    return;
  }
  const target = signalTree(pid, signal);
  if (target === undefined || signal === "SIGKILL" || escalateMs <= 0) return;
  // Yükseltme ilk sinyalin gittiği hedefe gider: grup kimliği, üyesi kaldıkça başka sürece
  // verilmez; grubu olmayan tek süreçte pid'in bu kısa sürede yeniden kullanılması çok düşük ihtimal.
  const timer = setTimeout(() => {
    if (!alive(target)) return;
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Arada kapandı.
    }
  }, escalateMs);
  timer.unref();
}
