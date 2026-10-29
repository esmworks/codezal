import { spawn } from "node:child_process";
import { agentShellRun, killProcessTree } from "@codezal/agent";
import type { CheckResult } from "@codezal/contracts";
import { i18n } from "./i18n.js";

/**
 * Çalışan kontroller: uygulama kapanırken hepsi (alt süreçleriyle) kapatılır. POSIX'te `detached`
 * doğdukları için sahipsiz kalan bir `pnpm test` süreci makinede kalırdı.
 */
const running = new Set<ReturnType<typeof spawn>>();

/** Zaman aşımında süreç ağacına öldürme sinyalinden sonra sonucu döndürmek için tanınan süre. */
const KILL_GRACE_MS = 5_000;

/** Uygulama kapanışında çağrılır (main `before-quit`). */
export function disposeChecks(): void {
  for (const child of [...running]) {
    if (child.pid) killProcessTree(child.pid);
  }
  running.clear();
}

/**
 * Commit öncesi kontroller: her komut sırayla kabukta çalışır, çıktı kısaltılır.
 * Kabuk ajanın `bash` aracıyla aynı çözümlemeden gelir (`agentShellRun`); Windows'ta Git Bash,
 * yoksa PowerShell. Böylece kullanıcının yazdığı komut ön planda çalışıp burada patlamaz.
 */
export function runCheck(cwd: string, command: string): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const run = agentShellRun(command);
    const child = spawn(run.shell, run.args, {
      cwd,
      env: process.env,
      // POSIX'te kendi süreç grubunda: zaman aşımı yalnız kabuğu değil tüm ağacı kapatsın.
      detached: process.platform !== "win32",
      // Paketli uygulama konsolsuz: her kontrolde siyah konsol penceresi açılmasın.
      windowsHide: true,
    });
    running.add(child);
    if (run.stdin !== undefined) child.stdin?.end(run.stdin);
    let output = "";
    const push = (chunk: Buffer) => {
      if (output.length < 20000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    // Sonuç bir kez döner: `close`/`error` ile zaman aşımı yarışırsa ikinci çağrı yok sayılır.
    let settled = false;
    const settle = (result: CheckResult, killTimer?: NodeJS.Timeout): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      running.delete(child);
      resolveResult(result);
    };
    const timer = setTimeout(
      () => {
        if (child.pid) killProcessTree(child.pid);
        // Süreç ağacı SIGTERM'i yok sayarsa (tuzağa düşmüş sinyal, kilitlenmiş test koşucusu)
        // `close` hiç gelmez ve söz asılı kalırdı: commit penceresindeki düğmeler sonsuza kadar
        // kilitli kalıyor, tur sonu kontrolü de hiç dönmüyordu. Kısa bir beklemeden sonra sonuç
        // yine döner; süreç ölmemişse kullanıcı çıktıdaki nottan anlar.
        setTimeout(() => {
          settle({
            command,
            ok: false,
            code: -1,
            output: `${output.slice(-20000)}\n${i18n.t("errors.checkTimeout")}`.trim(),
            durationMs: Date.now() - started,
          });
        }, KILL_GRACE_MS);
      },
      10 * 60 * 1000,
    );
    child.on("close", (code) => {
      settle(
        {
          command,
          ok: code === 0,
          code: code ?? -1,
          output: output.slice(-20000),
          durationMs: Date.now() - started,
        },
        timer,
      );
    });
    child.on("error", (error) => {
      settle(
        {
          command,
          ok: false,
          code: -1,
          output: error.message,
          durationMs: Date.now() - started,
        },
        timer,
      );
    });
  });
}

export async function runChecks(cwd: string, commands: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of commands) {
    const r = await runCheck(cwd, c);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}
