import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  type BashSpawnHook,
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { type BackgroundTask, isVerificationCommand } from "./background.js";
import { type SandboxDecision, sandboxCommand } from "./sandbox.js";

export const BASH_TOOL = "bash";

/**
 * Ön plan penceresi: bu süreyi aşan komut arka plana alınır. Kısa komutlar (okuma, arama, tek
 * satırlık kabuk işleri) turda kalır; derleme, kurulum, dağıtım gibi dakikalık işler ise turu ve
 * kullanıcıyı beklemez. Model komutun uzun süreceğini önceden bilemediğinde tek emniyet ağı budur:
 * `bash_background` kararı modele bırakır, pencere ise yanlış tahmini yakalar.
 */
export const AUTO_BACKGROUND_MS = 90_000;

/**
 * Kesmeden sonra sürecin kapanması için beklenen en uzun süre. Süreç SIGTERM'i yok sayarsa
 * `killProcessTree` 3 sn sonra SIGKILL'e geçer; bu pay onu da kapsar. Süreç yine de kapanmazsa
 * (kesintisiz G/Ç'de takılı) tur askıda kalmaz, kesilme hatası döner.
 */
export const ABORT_SETTLE_MS = 5_000;

/**
 * Görevin bitişini bekler; sinyal kesilirse en fazla `graceMs` daha bekler ve `undefined` döner.
 * Durdur'dan sonra kapanmayan bir süreç turu sonsuza kadar kilitliyordu.
 */
function waitUnlessAbandoned<T>(
  wait: Promise<T>,
  signal: AbortSignal | undefined,
  graceMs: number,
): Promise<T | undefined> {
  if (!signal) return wait;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      timer = setTimeout(() => resolve(undefined), graceMs);
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
    wait.then(
      (value) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", arm);
        resolve(value);
      },
      (error: unknown) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", arm);
        reject(error);
      },
    );
  });
}

/** Pi'nin zaman aşımı sınırı; aynı doğrulama ve hata metinleri korunur. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface BashBridge {
  /** Gözetimsiz (zamanlanmış) oturum: arka plana alınan işi bildirecek kimse yok. */
  unattended(): boolean;
  /**
   * Komutu başlatır ama arka plan işi saymaz: ön plan penceresinde koşar, pencere aşılırsa
   * `detach` ile duyurulur. Oturum kapandıysa `undefined`.
   */
  start(
    command: string,
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      onData: (chunk: Buffer) => void;
      /** Seatbelt profili: verilirse süreç `sandbox-exec` altında doğar. */
      sandbox?: string;
    },
  ): BackgroundTask | undefined;
  /** Pencere aşıldı: görevi arka plan işi yapar (olayı motor yayınlar). Bitmişse `undefined`. */
  detach(id: string): BackgroundTask | undefined;
  /** Süre sınırı doldu: süreç kapatılır, görev "süresi doldu" diye bildirilir. */
  timeout(id: string): void;
  /** Kullanıcı turu kesti: süreç kapatılır, görev sessiz kalır. */
  stop(id: string): void;
  wait(id: string): Promise<BackgroundTask | undefined>;
}

const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);

export interface BashSandboxOptions {
  /** Çağrı anındaki karar (ayar canlı okunur); `cwd` aracın çözdüğü çalışma klasörüdür. */
  decide(cwd: string): SandboxDecision;
  /** Çağrı korumalı alanda koştu; motor sonucu işaretler (karttaki "Korumalı" etiketi). */
  onSandboxed?(toolCallId: string): void;
}

/**
 * Pi'nin yerleşik yürütücüsü için korumalı alan kancası: dış kabuk `sandbox-exec`e devreder,
 * komut aynı kabukla (`getShellConfig`, macOS'ta /bin/bash) içeride koşar. Karar her çağrıda
 * verilir; kapalıysa komut olduğu gibi kalır.
 */
export function sandboxSpawnHook(decide: (cwd: string) => SandboxDecision): BashSpawnHook {
  return (context) => {
    const decision = decide(context.cwd);
    if (decision.kind !== "on") return context;
    const shell = getShellConfig();
    return {
      ...context,
      command: sandboxCommand(context.command, decision.profile, shell.shell, shell.args),
    };
  };
}

/**
 * Alt ajanların `bash`'i: Pi'nin yerleşik aracıyla aynı yürütücü (arka plana alma yok), yalnız
 * korumalı alan kancası eklenir. Yerleşik aracın yerine aynı adla kaydedilir.
 */
export function sandboxedBashTool(cwd: string, decide: (cwd: string) => SandboxDecision) {
  const base = createBashToolDefinition(cwd, { spawnHook: sandboxSpawnHook(decide) });
  return defineTool({
    name: BASH_TOOL,
    label: base.label,
    description: base.description,
    ...(base.promptSnippet ? { promptSnippet: base.promptSnippet } : {}),
    ...(base.promptGuidelines ? { promptGuidelines: base.promptGuidelines } : {}),
    parameters: base.parameters,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      base.execute(toolCallId, params, signal, onUpdate, ctx),
  });
}

/** Pi `resolveTimeoutMs` ile aynı kural: `<= 0` ve sonlu olmayan değer reddedilir. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid timeout: must be a finite number of seconds");
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS)
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return timeoutMs;
}

/**
 * Pi'nin `bash` aracını aynı adla sarar. Pi aynı adlı özel aracı yerleşik olanın yerine koyar.
 *
 * Neden: tur, komut bitene kadar kilitleniyordu. Model komutun ne kadar süreceğini önceden
 * kestiremediğinde (ya da kestirip yanıldığında) kullanıcı dakikalarca bekliyor, komutun takılı
 * kalması hâlinde ise turu kesmekten başka çare kalmıyordu. Artık pencereyi aşan komut arka plana
 * alınır, sonucu bitince gizli dürtmeyle modele döner (Claude Code'un otomatik arka plan deseni).
 *
 * İki yol bilinçli olarak Pi'nin yerleşik yürütücüsünde kalır:
 * - **Doğrulama komutları** (`isVerificationCommand`): turun kapanışı sonuca bağlıdır; arka plana
 *   atılınca model sonucu görmeden rapor yazıp dürtmeyle düzeltmeye gidiyor (bkz. `background.ts`).
 * - **Gözetimsiz oturumlar**: dürtmeyi görecek kimse yok.
 */
export function bashTool(
  cwd: string,
  bridge: BashBridge,
  lang: Locale = "tr",
  options: { thresholdMs?: number; abortSettleMs?: number; sandbox?: BashSandboxOptions } = {},
) {
  const d = dict(lang);
  const p = d.prompt;
  const thresholdMs = options.thresholdMs ?? AUTO_BACKGROUND_MS;
  const abortSettleMs = options.abortSettleMs ?? ABORT_SETTLE_MS;
  const base = createBashToolDefinition(cwd);
  // Arka plana alınabilen komutlar da Pi'nin biçimlendirmesini korur: kırpma, tam çıktının geçici
  // dosyası, kart ayrıntıları ve akış aynı yoldan gelir. Değişen tek şey süreci kimin tuttuğu.
  const auto = createBashToolDefinition(cwd, {
    operations: autoBackgroundOps(bridge, thresholdMs, d.prompt.bashDetached, abortSettleMs),
  });
  // `sandbox-exec` yoksa uyarı oturumda bir kez araç sonucuna yazılır; her komutta tekrarlanmaz.
  let missingWarned = false;
  return defineTool({
    name: BASH_TOOL,
    label: base.label,
    description: fill(p.bashDesc, {
      lines: DEFAULT_MAX_LINES,
      kb: DEFAULT_MAX_BYTES / 1024,
      seconds: Math.round(thresholdMs / 1000),
    }),
    ...(base.promptSnippet ? { promptSnippet: base.promptSnippet } : {}),
    promptGuidelines: [
      ...(base.promptGuidelines ?? []),
      fill(p.bashGuideline, { seconds: Math.round(thresholdMs / 1000) }),
    ],
    parameters: Type.Object({
      command: Type.String({ description: p.bashCommand }),
      timeout: Type.Optional(Type.Number({ description: p.bashTimeout })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const foreground = isVerificationCommand(params.command) || bridge.unattended();
      const decision = options.sandbox?.decide(ctx?.cwd || cwd) ?? { kind: "off" };
      if (decision.kind === "on") {
        options.sandbox?.onSandboxed?.(toolCallId);
        // Korumalı yürütücü çağrı başına kurulur: profil çalışma klasörüne ve ayara bağlı.
        const sandboxed = foreground
          ? createBashToolDefinition(cwd, { spawnHook: sandboxSpawnHook(() => decision) })
          : createBashToolDefinition(cwd, {
              operations: autoBackgroundOps(
                bridge,
                thresholdMs,
                d.prompt.bashDetached,
                abortSettleMs,
                decision.profile,
              ),
            });
        return sandboxed.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      const target = foreground ? base : auto;
      if (decision.kind !== "missing" || missingWarned) {
        return target.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      missingWarned = true;
      const notice = p.bashSandboxMissing;
      try {
        const result = await target.execute(toolCallId, params, signal, onUpdate, ctx);
        return {
          ...result,
          content: [...result.content, { type: "text" as const, text: `\n\n${notice}` }],
        };
      } catch (error) {
        // Sıfır dışı çıkışta Pi hata fırlatır; uyarı hata metnine eklenir ki model yine görsün.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n\n${notice}`);
      }
    },
  });
}

/**
 * Ön plan penceresi olan yürütücü. Komut tek kez başlatılır (iki kez değil): pencere içinde
 * biterse Pi'nin normal sonucu döner, pencere aşılırsa aynı süreç arka plan işi olur ve modele
 * "bitince uyandırılacaksın" notu döner. `timeout` ön planda kesme, arka planda iş son teslimi
 * olarak çalışır; ikisi de süreç ağacını kapatır.
 */
function autoBackgroundOps(
  bridge: BashBridge,
  thresholdMs: number,
  detachedNotice: string,
  abortSettleMs: number,
  sandbox?: string,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      const task = bridge.start(command, {
        cwd,
        onData,
        ...(env ? { env } : {}),
        ...(sandbox ? { sandbox } : {}),
      });
      // Görev açılamadı (oturum kapandı): tur askıda kalmasın, Pi'nin kesme yolu işlesin.
      if (!task) throw new Error("aborted");

      let deadlineFired = false;
      const deadline =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              deadlineFired = true;
              bridge.timeout(task.id);
            }, timeoutMs);
      const onAbort = () => bridge.stop(task.id);
      signal?.addEventListener("abort", onAbort, { once: true });
      const stopListening = () => signal?.removeEventListener("abort", onAbort);
      // Süre sınırı pencereden önceyse komut ön planda ölür: Pi'nin "Command timed out" sonucu.
      const windowMs = Math.min(thresholdMs, timeoutMs ?? Number.POSITIVE_INFINITY);

      let windowTimer: NodeJS.Timeout | undefined;
      const window = new Promise<"window">((resolve) => {
        windowTimer = setTimeout(() => resolve("window"), windowMs);
      });
      const waited = waitUnlessAbandoned(bridge.wait(task.id), signal, abortSettleMs);
      const outcome = await Promise.race([waited.then(() => "exited" as const), window]);
      if (windowTimer) clearTimeout(windowTimer);

      if (outcome === "window") {
        // İki zamanlayıcı aynı ana denk geldiğinde (modele göre kısa bir `timeout`) süre dolması
        // kazanır: kapatılan komut "arka plana alındı" diye duyurulmaz, kesilme hatası döner.
        // Kesilmiş komut arka plana alınmaz: kullanıcı onu durdurdu.
        const backgrounded = deadlineFired || signal?.aborted ? undefined : bridge.detach(task.id);
        if (backgrounded) {
          // Kesme dinleyicisi bırakılır ama süre sınırı **kalır**: tur kesilince arka plandaki iş
          // ölmez (kullanıcı isterse panelden durdurur), kendi süresi dolduğunda ise kapanır.
          stopListening();
          const notice = fill(detachedNotice, {
            seconds: Math.max(1, Math.round(windowMs / 1000)),
            id: backgrounded.id,
          });
          onData(Buffer.from(`\n\n${notice}`));
          return { exitCode: 0 };
        }
        // Pencere dolduğu anda süreç bitmişse ya da süre dolmuşsa normal sonuç yolu işler.
      }

      const finished = await waited;
      stopListening();
      if (deadline) clearTimeout(deadline);
      // Pi'nin yerleşik yürütücüsüyle aynı sıra: kesme, zaman aşımından önce bildirilir.
      if (signal?.aborted) throw new Error("aborted");
      if (deadlineFired && timeout !== undefined) throw new Error(`timeout:${timeout}`);
      return { exitCode: finished?.code ?? -1 };
    },
  };
}
