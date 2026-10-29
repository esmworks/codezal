import { spawn } from "node:child_process";
import { log } from "./log.js";

/**
 * Terminal sekmesinin kabuğu: Windows'ta PowerShell, POSIX'te `$SHELL`. Ajan komutları bu
 * çözümlemeyi **kullanmaz**; onlar `@codezal/agent` içindeki `agentShell` ile belirlenir
 * (Windows'ta Git Bash) ki `bash` kalıpları ön plan, arka plan ve kontrollerde aynı çalışsın.
 */
export function terminalShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return "powershell.exe";
  // macOS'ta varsayılan zsh; Linux'ta zsh kurulu olmayabilir, POSIX kabuğa düşülür.
  return env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

export function userShell(): string {
  return terminalShellFor(process.platform, process.env);
}

/** PowerShell'i tek argümanla çalıştırır: tırnak/boşluk içeren yollarda alıntılama sorunu kalmaz. */
function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Klasörü sistem terminal uygulamasında açar (kenar çubuğu "Terminalde aç"). */
export function openInTerminal(cwd: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", ["-a", "Terminal", cwd]]
      : process.platform === "win32"
        ? [
            "cmd.exe",
            [
              "/c",
              "start",
              // Boş başlık: `start` ilk tırnaklı argümanı pencere başlığı sanar.
              "",
              "powershell.exe",
              "-NoExit",
              "-EncodedCommand",
              // Base64/UTF-16LE: `'` ve boşluk içeren yollar cmd/PowerShell ayrıştırmasını bozmaz.
              encodedPowerShell(`Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`),
            ],
          ]
        : ["x-terminal-emulator", ["--working-directory", cwd]];
  const child = spawn(cmd, args, { cwd, detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    // Terminal uygulaması bulunamadı: sessizce geçme, günlüğe yaz (kullanıcı menüden tekrar dener).
    log.warn("terminal", `terminal açılamadı: ${String(error)}`);
  });
  child.unref();
}
