import { spawn } from "node:child_process";
import type { HookEvent, ResolvedHook } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentShellRun, killProcessTree } from "./shell.js";

/** Süre verilmeyen hook'un sınırı (saniye). Dolarsa çağrı engellenmez, uyarı günlüğe düşer. */
export const DEFAULT_HOOK_TIMEOUT_SEC = 30;
/** PreToolUse'da çağrıyı engelleyen, PostToolUse'da geri bildirim veren çıkış kodu (Claude Code ile aynı). */
export const HOOK_BLOCK_CODE = 2;
/** PostToolUse girdisindeki araç sonucu metni bu kadar karakterle sınırlanır. */
export const HOOK_RESULT_CHARS = 10_000;
/** Hook'un stdout/stderr'inden saklanan en çok karakter (gerekçe modele gider, şişmesin). */
const HOOK_OUTPUT_CHARS = 8_000;
/** Süre dolunca SIGTERM'den SIGKILL'e geçmeden beklenen süre. */
const HOOK_KILL_ESCALATE_MS = 1_000;

export interface HookPayload {
  event: HookEvent;
  tool: string;
  input: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  /** Yalnız PostToolUse: araç sonucunun metni (kırpılmış). */
  result?: string;
  isError?: boolean;
}

export interface HookRun {
  /** Çıkış kodu; süre dolduysa ya da süreç başlatılamadıysa `null`. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Süreç başlatılamadı (kabuk yok vb.). */
  error?: string;
}

export interface RunHookOptions {
  cwd: string;
  timeoutMs: number;
  /** Ana sürecin PATH düzeltmesi yapılmış ortamı; verilmezse `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Motorun `shell` ayarı (test ve özel kabuk); verilmezse ajan kabuğu çözülür. */
  shell?: string;
}

const append = (acc: string, chunk: Buffer): string =>
  acc.length >= HOOK_OUTPUT_CHARS
    ? acc
    : (acc + chunk.toString("utf8")).slice(0, HOOK_OUTPUT_CHARS);

/**
 * Hook komutunu ajan kabuğunda çalıştırır; çağrının JSON'u stdin'e yazılır. Hata fırlatmaz:
 * başlatma hatası `error`, süre dolması `timedOut` olarak döner — `tool_call` kancasında fırlayan
 * hata Pi'de aracı engeller, altyapı arızası ise kullanıcının çağrısını düşürmemeli.
 */
export function runHook(
  command: string,
  payload: HookPayload,
  options: RunHookOptions,
): Promise<HookRun> {
  return new Promise((resolve) => {
    const input = JSON.stringify(payload);
    const run = agentShellRun(command, options.shell);
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      CODEZAL_HOOK_EVENT: payload.event,
      CODEZAL_HOOK_TOOL: payload.tool,
    };
    // WSL'in eski kipinde komutun kendisi stdin'e gider; girdi o zaman ortam değişkeniyle taşınır.
    if (run.stdin !== undefined) env.CODEZAL_HOOK_INPUT = input;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: HookRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(run.shell, run.args, {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Kendi süreç grubunda: süre dolunca hook'un doğurduğu alt süreçler de kapanır.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    // stdin'i okumayan hook kapanınca yazma EPIPE verir; yakalanmazsa main süreci düşer.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(run.stdin ?? input);
    child.on("error", (error) =>
      finish({ code: null, stdout, stderr, timedOut, error: error.message }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid, "SIGTERM", HOOK_KILL_ESCALATE_MS);
      // Boruları devralan torun süreç `close`u geciktirebilir; tur onu beklemez.
      finish({ code: null, stdout, stderr, timedOut });
    }, options.timeoutMs);
  });
}

const regexCache = new Map<string, RegExp | null>();

/**
 * Eşleştirici araç adının **tamamına** uygulanır (`bash`, `bash_background`'u yakalamasın);
 * `edit|write` gibi seçenekler yazılabilir. Boş ya da `*` tüm araçlar. Geçersiz ifade `undefined`.
 */
export function hookMatches(matcher: string, toolName: string): boolean | undefined {
  const m = matcher.trim();
  if (m === "" || m === "*") return true;
  let re = regexCache.get(m);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${m})$`);
    } catch {
      re = null;
    }
    regexCache.set(m, re);
  }
  return re ? re.test(toolName) : undefined;
}

/** Araç sonucunun metin kısmı; görseller atlanır, uzun metin kırpılır. */
export function resultText(content: ReadonlyArray<TextContent | ImageContent>): string {
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return text.length > HOOK_RESULT_CHARS ? `${text.slice(0, HOOK_RESULT_CHARS)}…` : text;
}

export interface HooksBridge {
  /** Çalışma klasörü için etkin hook'lar (genel + güvenilen projeninkiler). */
  hooks(cwd: string): ResolvedHook[];
  /** Hook süreçlerinin ortamı (main'in PATH düzeltmesi yapılmış `process.env`'i). */
  env?: () => NodeJS.ProcessEnv;
  /** Kabuk geçersiz kılma (motorun `shell` ayarı). */
  shell?: () => string;
  /** Engellemeyen uyarı (süre doldu, sıfır dışı çıkış, geçersiz eşleştirici); main günlüğe yazar. */
  warn?: (message: string) => void;
  /** PreToolUse çağrıyı engelledi: kart "hata" değil "reddedildi" çizilsin diye motor işaretler. */
  onDeny?: (toolCallId: string) => void;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * `codezal-hooks`: kullanıcının PreToolUse / PostToolUse komutları. PreToolUse çıkış kodu 2 ise
 * çağrı engellenir ve stderr modele gerekçe olarak döner; 0 geçer; diğer kodlar ve süre dolması
 * yalnız uyarıdır. PostToolUse yalnız gözlemler; 2 dönerse stderr araç sonucuna geri bildirim
 * olarak eklenir. Hook listesi her çağrıda yeniden okunur: dosya düzenlenince oturum açık kalsa da
 * yeni kurallar geçerli olur.
 */
export function hooksExtension(
  sessionId: string,
  defaultCwd: string,
  bridge: HooksBridge,
  lang: Locale = "tr",
) {
  const p = dict(lang).prompt;
  const warn = (message: string) => bridge.warn?.(message);
  const select = (event: HookEvent, toolName: string, cwd: string): ResolvedHook[] => {
    let all: ResolvedHook[];
    try {
      all = bridge.hooks(cwd);
    } catch (error) {
      warn(`hook listesi okunamadı: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    return all.filter((hook) => {
      if (hook.event !== event) return false;
      const matched = hookMatches(hook.matcher, toolName);
      if (matched === undefined) {
        warn(`geçersiz eşleştirici "${hook.matcher}" (${hook.source}); hook atlandı`);
        return false;
      }
      return matched;
    });
  };
  const exec = (hook: ResolvedHook, payload: HookPayload) => {
    const env = bridge.env?.();
    const shell = bridge.shell?.();
    return runHook(hook.command, payload, {
      cwd: payload.cwd,
      timeoutMs: (hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC) * 1000,
      ...(env ? { env } : {}),
      ...(shell ? { shell } : {}),
    });
  };
  /** Engellemeyen sonuçları günlüğe yazar (0 ve 2 dışındaki kodlar, süre, başlatma hatası). */
  const report = (hook: ResolvedHook, run: HookRun) => {
    const label = `${hook.event} hook "${hook.command}" (${hook.source})`;
    if (run.error) warn(`${label} başlatılamadı: ${run.error}`);
    else if (run.timedOut)
      warn(
        `${label} ${hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC} sn içinde bitmedi; çağrı sürdü`,
      );
    else if (run.code !== 0 && run.code !== HOOK_BLOCK_CODE)
      warn(`${label} ${run.code} koduyla çıktı: ${firstLine(run.stderr) || "(stderr boş)"}`);
  };

  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      try {
        const cwd = ctx.cwd || defaultCwd;
        for (const hook of select("PreToolUse", event.toolName, cwd)) {
          const run = await exec(hook, {
            event: "PreToolUse",
            tool: event.toolName,
            input: event.input as Record<string, unknown>,
            sessionId,
            cwd,
          });
          if (!run.timedOut && run.code === HOOK_BLOCK_CODE) {
            // Gerekçe ilk satırda: kart hatanın ilk satırını gösterir, kullanıcı nedeni orada görür.
            const reason = run.stderr.trim() || p.hookNoReason;
            bridge.onDeny?.(event.toolCallId);
            return {
              block: true,
              reason: `${reason}\n\n${p.hookBlocked.replaceAll("{{command}}", hook.command)}`,
            };
          }
          report(hook, run);
        }
      } catch (error) {
        warn(`PreToolUse hook hatası: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      const feedback: string[] = [];
      try {
        const cwd = ctx.cwd || defaultCwd;
        const hooks = select("PostToolUse", event.toolName, cwd);
        if (hooks.length === 0) return undefined;
        const result = resultText(event.content);
        for (const hook of hooks) {
          const run = await exec(hook, {
            event: "PostToolUse",
            tool: event.toolName,
            input: event.input,
            sessionId,
            cwd,
            result,
            isError: event.isError,
          });
          if (!run.timedOut && run.code === HOOK_BLOCK_CODE) {
            const text = run.stderr.trim();
            if (text) {
              feedback.push(`${p.hookFeedback.replaceAll("{{command}}", hook.command)}\n${text}`);
            }
            continue;
          }
          report(hook, run);
        }
      } catch (error) {
        warn(`PostToolUse hook hatası: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (feedback.length === 0) return undefined;
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n${feedback.join("\n\n")}` },
        ],
      };
    });
  };
}
