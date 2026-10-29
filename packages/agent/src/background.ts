import { spawn } from "node:child_process";
import type { BackgroundJob } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { sandboxArgv } from "./sandbox.js";
import { agentShellRun, killProcessTree } from "./shell.js";

export const BACKGROUND_TOOL = "bash_background";
/** Görev başına saklanan çıktı kuyruğu; fazlası baştan atılır (uzun süren sunucu günlüğü şişmesin). */
export const MAX_OUTPUT_CHARS = 20_000;
/** Bitiş bildiriminde modele verilen çıktı kuyruğu. */
export const DONE_OUTPUT_TAIL = 4_000;
/**
 * Oturum başına saklanan **bitmiş** görev kaydı sayısı; eskiler düşer. Kayıtlar çıktının son
 * `MAX_OUTPUT_CHARS` karakterini taşıdığı için sınırsız büyüme uzun ömürlü bir uygulamada
 * oturum başına megabaytlara çıkıyordu.
 */
export const MAX_FINISHED_TASKS = 20;
/**
 * `exit`ten sonra boruların dinginleşmesi için beklenen süre. Çıktı yazmaya devam eden torun
 * süreç her veri parçasında pencereyi tazeler; sessizce boruyu tutan bir torun ise görevi bu
 * sürenin sonunda kapatır (Pi `waitForChildProcess` ile aynı 100 ms).
 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Doğrulama komutları arka plana atılamaz: turun kapanışı sonuca bağlıdır. Arka planda koşunca
 * model sonucu görmeden tam rapor yazıyor, dürtme gelince düzeltip yeniden doğruluyor ve tek iş
 * "bitti → bir şey daha yaptı" döngüsüne dönüşüyor. Ön planda koşan doğrulama turu bekletir ama
 * nihai rapor tek ve son olur.
 */
const VERIFICATION_PATTERNS = [
  /\b(?:pnpm|npm|yarn|bun|npx|pnpx|bunx)\b[^\n]*\b(?:run\s+)?(?:check|lint|test|typecheck|tsc)\b/i,
  // Çıplak araç çağrıları komut başında (ya da `&&`/`;` sonrası) aranır: `cat jest.config.js`
  // gibi dosya okumaları yanlışlıkla engellenmesin.
  /(?:^|[;&|]\s*)(?:npx\s+|bunx\s+)?(?:tsc|vitest|jest|eslint|pytest)(?:\s|$)/i,
  /(?:^|[;&|]\s*)biome\s+(?:check|ci)\b/i,
  /(?:^|[;&|]\s*)(?:cargo|go|make|just|mise|node|deno)\s+(?:test|check|clippy|--test)(?:\s|$)/i,
];

/** Komut kendi değişikliğini doğruluyor mu (check/lint/test/typecheck…); ön planda koşmalı. */
export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_PATTERNS.some((re) => re.test(command));
}

export type BackgroundStatus = "running" | "exited" | "stopped" | "error";

export interface BackgroundTask {
  id: string;
  sessionId: string;
  command: string;
  /** Modelin verdiği kısa açıklama; arayüz işi bununla adlandırır, yoksa komutla. */
  description?: string;
  cwd: string;
  startedAt: number;
  /** Süreç kapanış anı; arayüz biten görevin süresini buradan yazar. */
  endedAt?: number;
  status: BackgroundStatus;
  /** Çıkış kodu; süreç bitmemişse yok. */
  code?: number;
  /** Çıktının son `MAX_OUTPUT_CHARS` karakteri (stdout + stderr, geldiği sırayla). */
  output: string;
  /**
   * Süreçten bugüne okunan **toplam** karakter (kırpılmadan önce). Kırpma sessiz kalmasın diye
   * modele "özgün N karakter, gösterilen M" dipnotu bundan yazılır (`truncationNote`).
   */
  outputChars: number;
  /**
   * Görev arka plan işi olarak duyuruldu mu. `bash` sarmalayıcısının ön plan penceresinde
   * başlayan komut `false` kalır: sonucu araç sonucu olarak modele döner, bitince kimse
   * dürtülmez ve Ajanlar kutusunda görünmez.
   */
  backgrounded: boolean;
  /** Kendi süre sınırı dolduğu için kapatıldı; kullanıcının durdurmasından ayrıdır. */
  timedOut?: boolean;
}

let counter = 0;

/** `start` seçenekleri: ön plan penceresi ve çıktı akışı için. */
export interface BackgroundStartOptions {
  /**
   * `true` (varsayılan): görev baştan arka plan işidir (`bash_background start`).
   * `false`: ön plan penceresinde başlar (`bash` sarmalayıcısı); pencere aşılırsa
   * `markBackgrounded` ile arka plana alınır, aşılmazsa hiç duyurulmaz.
   */
  backgrounded?: boolean;
  /** İşin kısa açıklaması (`bash_background start` `description` alanı). */
  description?: string;
  /** Alt sürece verilecek ortam; verilmezse süreç ortamı (Pi `bash` ile aynı PI_* değerleri). */
  env?: NodeJS.ProcessEnv;
  /** Gelen ham çıktı; `bash` sarmalayıcısı Pi'nin çıktı akümülatörünü böyle besler. */
  onData?: (chunk: Buffer) => void;
  /**
   * Seatbelt profili (Bash korumalı alanı, yalnız macOS): süreç argv düzeyinde `sandbox-exec`
   * altında doğar. Görevin `command` alanı özgün komut kalır; Ajanlar kutusu sarmalayıcıyı göstermez.
   */
  sandbox?: string;
}

/**
 * Arka plan komutları: tur beklemeden çalışır, bittiğinde `onExit` ile motora haber verir.
 * Motor da oturumu gizli bir mesajla dürtüp modele sonucu okutur — uzun derleme ya da test
 * koşusu turu kilitlemesin diye.
 */
export class BackgroundRunner {
  readonly #tasks = new Map<string, BackgroundTask>();
  readonly #procs = new Map<string, ReturnType<typeof spawn>>();
  /** Görev bitince çözülen bekleyiciler; `bash` sarmalayıcısının ön plan penceresi burada bekler. */
  readonly #waiters = new Map<string, Array<(task: BackgroundTask) => void>>();
  readonly #onExit: (task: BackgroundTask) => void;
  /** Motorun `shell` ayarı: verilirse kabuk çözümlemesi atlanır (test ve özel kabuk için). */
  readonly #shellOverride: (() => string) | undefined;

  constructor(options: { onExit: (task: BackgroundTask) => void; shell?: () => string }) {
    this.#onExit = options.onExit;
    this.#shellOverride = options.shell;
  }

  start(
    sessionId: string,
    cwd: string,
    command: string,
    options: BackgroundStartOptions = {},
  ): BackgroundTask {
    const id = `bg-${++counter}`;
    const task: BackgroundTask = {
      id,
      sessionId,
      command,
      ...(options.description ? { description: options.description } : {}),
      cwd,
      startedAt: Date.now(),
      status: "running",
      output: "",
      outputChars: 0,
      backgrounded: options.backgrounded ?? true,
    };
    this.#tasks.set(id, task);
    const run = agentShellRun(command, this.#shellOverride?.());
    const argv =
      options.sandbox && process.platform === "darwin"
        ? sandboxArgv(options.sandbox, run.shell, run.args)
        : { shell: run.shell, args: run.args };
    // Kendi süreç grubunda: `pnpm dev` gibi komutlar alt süreç doğuruyor, durdurma hepsini almalı.
    const child = spawn(argv.shell, argv.args, {
      cwd,
      env: options.env ?? process.env,
      // Girdi verilmeyen komutta stdin **kapatılır**: açık kalan boru girdi okuyan komutu
      // (`read`, `cat`, onay soran bir CLI) sonsuza kadar bekletir. Pi'nin yerleşik `bash`
      // yürütücüsü de aynı biçimde `ignore` kullanır.
      stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Paketli uygulama konsolsuz: her komut için siyah konsol penceresi açılmasın.
      windowsHide: true,
    });
    if (run.stdin !== undefined) child.stdin?.end(run.stdin);
    this.#procs.set(id, child);
    // Süreç kapanışı `close`a bağlanmaz: komut çıkıp da boruları devralan bir torun süreç
    // (`nohup … &`, daemon) stdout'u tutmaya devam ederse `close` hiç gelmez, görev sonsuza
    // kadar "çalışıyor" kalır ve model hiç uyandırılmaz. Pi'nin `waitForChildProcess` mantığı
    // gibi: `exit`ten sonra borular dinginleşince kapatırız, dinginlik penceresi veri geldikçe
    // tazelenir ki hâlâ yazan torunun kuyruğu kesilmesin.
    let exited = false;
    let exitCode: number | null = null;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let grace: NodeJS.Timeout | undefined;
    const settle = (code?: number | null) => {
      if (code !== undefined && code !== null) exitCode = code;
      if (grace) {
        clearTimeout(grace);
        grace = undefined;
      }
      // Durdurulan görev "stopped" kalır; kullanıcı kararını çıkış kodu ezmesin.
      this.#finish(id, task.status === "stopped" ? "stopped" : "exited", exitCode ?? -1);
    };
    const armGrace = () => {
      if (grace) clearTimeout(grace);
      grace = setTimeout(() => settle(), EXIT_STDIO_GRACE_MS);
    };
    /** Çıkıştan sonra iki boru da kapandıysa hemen, değilse dinginlik penceresiyle kapatır. */
    const afterExit = () => {
      if (!exited) return;
      if (stdoutEnded && stderrEnded) settle();
      else armGrace();
    };
    const push = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Sayaç kırpmadan **önce** artar: dipnot "özgün kaç karakter" diyebilsin.
      task.outputChars += text.length;
      task.output = (task.output + text).slice(-MAX_OUTPUT_CHARS);
      options.onData?.(chunk);
      if (exited) armGrace();
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.stdout?.once("end", () => {
      stdoutEnded = true;
      afterExit();
    });
    child.stderr?.once("end", () => {
      stderrEnded = true;
      afterExit();
    });
    child.on("error", (error) => {
      this.#finish(id, "error", -1, error.message);
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      afterExit();
    });
    child.on("close", (code) => {
      exited = true;
      settle(code);
    });
    return task;
  }

  #finish(id: string, status: BackgroundStatus, code: number, extra?: string): void {
    const task = this.#tasks.get(id);
    if (!task || !this.#procs.has(id)) return;
    this.#procs.delete(id);
    task.status = status;
    task.code = code;
    task.endedAt = Date.now();
    if (extra) {
      task.outputChars += extra.length;
      task.output = (task.output + extra).slice(-MAX_OUTPUT_CHARS);
    }
    // Biten görev kırpmanın **dışında** tutulur: `bash` sarmalayıcısı sonucu biten görevi ikinci
    // kez yoklar (`wait`), kaydı düşerse `undefined` görüp başarılı komutu `-1` koduyla
    // raporlardı.
    this.#prune(task.sessionId, id);
    for (const resolve of this.#waiters.get(id) ?? []) resolve(task);
    this.#waiters.delete(id);
    this.#onExit(task);
  }

  /**
   * Biten kayıtları oturum başına `MAX_FINISHED_TASKS` ile sınırlar; koşanlara ve `keepId`ye
   * dokunmaz (yeni biten görev çağıranına lazım).
   */
  #prune(sessionId: string, keepId: string): void {
    const finished = [...this.#tasks.values()].filter(
      (t) => t.sessionId === sessionId && t.status !== "running",
    );
    if (finished.length <= MAX_FINISHED_TASKS) return;
    // Map ekleme sırasını korur: en eski bitenler baştan düşer, yeni biten görev kaydı kalır.
    const stale = finished.filter((t) => t.id !== keepId);
    for (const old of stale.slice(0, finished.length - MAX_FINISHED_TASKS)) {
      this.#tasks.delete(old.id);
    }
  }

  get(id: string): BackgroundTask | undefined {
    return this.#tasks.get(id);
  }

  list(sessionId: string): BackgroundTask[] {
    return [...this.#tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  /**
   * Arayüze ve modele görünen görevler. Ön plan penceresinde koşan bir komut henüz arka plan
   * işi değildir: model kimliğini bilmiyor, kullanıcı da listede görmemeli.
   */
  listBackgrounded(sessionId: string): BackgroundTask[] {
    return this.list(sessionId).filter((t) => t.backgrounded);
  }

  /** Süreç kapanana kadar bekler; görev zaten bittiyse (ya da kaybolduysa) hemen döner. */
  waitFor(id: string): Promise<BackgroundTask | undefined> {
    const task = this.#tasks.get(id);
    if (!task || !this.#procs.has(id)) return Promise.resolve(task);
    return new Promise((resolve) => {
      const list = this.#waiters.get(id) ?? [];
      list.push(resolve);
      this.#waiters.set(id, list);
    });
  }

  /**
   * Ön plan penceresinde başlayan görevi arka plan işi sayar. Bu arada süreç bittiyse `undefined`
   * döner — bitmiş bir komut için "arka plana alındı" denmez, normal araç sonucu kazanır.
   */
  markBackgrounded(id: string): BackgroundTask | undefined {
    const task = this.#tasks.get(id);
    if (!task || !this.#procs.has(id)) return undefined;
    task.backgrounded = true;
    return task;
  }

  /**
   * Süre sınırı doldu: süreci kapatır ama **kullanıcı durdurdu** saymaz — görev `exited` kapanır
   * ve bitiş bildirimi `timedOut` notuyla gider. `stop` ile karışmaması bilinçli: durdurulan
   * görev sessiz kalır çünkü sonucu isteyen kullanıcıdır, süresi dolan görevi ise model bilmeli.
   */
  timeout(id: string): boolean {
    const child = this.#procs.get(id);
    const task = this.#tasks.get(id);
    if (!child || !task) return false;
    task.timedOut = true;
    if (child.pid) killProcessTree(child.pid);
    return true;
  }

  /** Süreci (ve alt süreçlerini) durdurur; `close` olayı görevi kapatır. */
  stop(id: string): boolean {
    const child = this.#procs.get(id);
    const task = this.#tasks.get(id);
    if (!child || !task) return false;
    task.status = "stopped";
    // Windows'ta `child.kill` yalnız kabuğu öldürür; alt süreçler `taskkill /T` ile kapanır.
    if (child.pid) killProcessTree(child.pid);
    return true;
  }

  /** Oturum kapanınca onun görevleri de kapanır: sahipsiz süreç bırakmayız. */
  stopSession(sessionId: string): void {
    for (const task of this.list(sessionId)) if (task.status === "running") this.stop(task.id);
  }

  /**
   * Oturum silinince kayıtları da bırakır. `stopSession`'dan farkı bitmiş görevlerin de
   * silinmesi: silinen oturumun `bash_background output` çıktısı erişilebilir kalmamalı.
   */
  forgetSession(sessionId: string): void {
    // Koşan görevler `stop()` sonrası "stopped" görünür ama süreç hâlâ kapanıyor: kaydı şimdi
    // silinirse `close` olayındaki `#finish` boşa düşer, süreç tutamacı `#procs`ta kalır ve
    // `background_end` olayı hiç yayınlanmaz. Bu yüzden koşanlar **önce** işaretlenir.
    const running = new Set(this.#procs.keys());
    this.stopSession(sessionId);
    for (const task of this.list(sessionId)) {
      if (running.has(task.id)) continue;
      this.#tasks.delete(task.id);
    }
  }

  dispose(): void {
    for (const id of [...this.#procs.keys()]) this.stop(id);
  }
}

/** Oturuma bağlı köprü: araç `sessionId`/`cwd` bilmez, motor bunları kapatır. */
export interface BackgroundBridge {
  /** Başlatamıyorsa `undefined`: gözetimsiz oturumda görevi bitince uyandıracak kimse yok. */
  start(command: string, description?: string): BackgroundTask | undefined;
  get(id: string): BackgroundTask | undefined;
  list(): BackgroundTask[];
  stop(id: string): boolean;
}

/** Motor olayı ve `sessions:open` yanıtı için sözleşme karşılığı. */
export function toBackgroundJob(
  task: Pick<
    BackgroundTask,
    "id" | "command" | "description" | "status" | "startedAt" | "code" | "endedAt"
  >,
): BackgroundJob {
  return {
    id: task.id,
    command: task.command,
    ...(task.description ? { description: task.description } : {}),
    status: task.status,
    startedAt: task.startedAt,
    ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
    ...(task.code === undefined ? {} : { code: task.code }),
  };
}

/**
 * Kırpma dipnotu: saklanan kuyruk özgün çıktıdan kısaysa modele söylenir. Sessiz kırpma, son
 * birkaç bin karakteri okuyan modelin "hata yok" sanmasına yol açıyordu (bkz. `tool-budget.ts`).
 * Boş dize: kırpma yoksa metne hiçbir şey eklenmez.
 */
export function truncationNote(task: BackgroundTask, shown: number, lang: Locale = "tr"): string {
  if (task.outputChars <= shown) return "";
  return dict(lang)
    .prompt.backgroundOutputTruncated.replace("{{total}}", String(task.outputChars))
    .replace("{{shown}}", String(shown));
}

/** Görevin tek satırlık özeti: `bg-1 çalışıyor — pnpm test`. */
export function describeTask(task: BackgroundTask, lang: Locale = "tr"): string {
  const d = dict(lang);
  const status =
    task.status === "running"
      ? d.prompt.backgroundRunning
      : task.status === "stopped"
        ? d.prompt.backgroundStopped
        : d.prompt.backgroundExited.replace("{{code}}", String(task.code ?? -1));
  return `${task.id} ${status} — ${task.command}`;
}

/**
 * Arka plan komutu aracı. `start` komutu başlatır ve hemen döner; tur kilitlenmez, kullanıcı
 * başka işe geçebilir. Süreç bittiğinde motor oturumu dürter ve model sonucu kendisi bildirir.
 * `output` çalışan görevin çıktısını okur (sunucu gibi bitmeyen işler için), `stop` durdurur.
 */
export function backgroundTool(bridge: BackgroundBridge, lang: Locale = "tr") {
  const d = dict(lang);
  return defineTool({
    name: BACKGROUND_TOOL,
    label: d.agent.tool.background,
    description: d.prompt.backgroundDesc,
    promptSnippet: d.prompt.backgroundSnippet,
    promptGuidelines: [d.prompt.backgroundGuideline],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("start"), Type.Literal("output"), Type.Literal("stop"), Type.Literal("list")],
        { description: d.prompt.backgroundAction },
      ),
      command: Type.Optional(
        Type.String({ minLength: 1, description: d.prompt.backgroundCommand }),
      ),
      id: Type.Optional(Type.String({ description: d.prompt.backgroundId })),
      description: Type.Optional(Type.String({ description: d.prompt.backgroundDescription })),
    }),
    async execute(_id, params) {
      const text = ((): string => {
        if (params.action === "start") {
          const command = params.command?.trim();
          if (!command) return d.prompt.backgroundNeedsCommand;
          // Doğrulama ön planda koşar: sonucu görmeden tur kapanmasın, rapor tek olsun.
          if (isVerificationCommand(command))
            return d.prompt.backgroundVerification.replace("{{command}}", command);
          const task = bridge.start(command, params.description?.trim() || undefined);
          if (!task) return d.prompt.backgroundUnattended;
          return d.prompt.backgroundStarted
            .replace("{{id}}", task.id)
            .replace("{{command}}", command);
        }
        if (params.action === "list") {
          const tasks = bridge.list();
          if (tasks.length === 0) return d.prompt.backgroundNone;
          return tasks.map((t) => describeTask(t, lang)).join("\n");
        }
        const id = params.id?.trim();
        if (!id) return d.prompt.backgroundNeedsId;
        const task = bridge.get(id);
        if (!task) return d.prompt.backgroundNotFound.replace("{{id}}", id);
        if (params.action === "stop") {
          bridge.stop(id);
          return d.prompt.backgroundStopMsg.replace("{{id}}", id);
        }
        const tail = task.output.slice(-DONE_OUTPUT_TAIL);
        const note = truncationNote(task, tail.length, lang);
        return `${describeTask(task, lang)}\n\n${tail || d.prompt.backgroundNoOutput}${note ? `\n\n${note}` : ""}`;
      })();
      return { content: [{ type: "text", text }], details: { action: params.action } };
    },
  });
}
