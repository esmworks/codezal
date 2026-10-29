import type {
  AgentEventInput,
  PermissionMode,
  WorkerEndInfo,
  WorkerInfo,
  WorkerReviewDecision,
} from "@codezal/contracts";
import {
  isTerminal,
  type WorkerEvent,
  type WorkerRuntime,
  WorkerSession,
  type WorkerSessionInput,
  type WorktreeService,
} from "../worker.js";
import { Limiter } from "./limiter.js";

/**
 * İstenen yalıtım: `required` worktree açılamazsa koşu başlamaz (model açıkça istedi),
 * `preferred` açılamazsa kökte sürer (motorun çakışmayı önlemek için verdiği karar), `none`
 * doğrudan kökte çalışır.
 */
export type RunIsolation = "required" | "preferred" | "none";

export interface AgentRunStart extends Omit<WorkerSessionInput, "isolated"> {
  isolation: RunIsolation;
}

/** Ana oturum başına saklanan koşu kaydı; açılışta geri yüklenir. */
export interface AgentRunStore {
  load(): Map<string, WorkerInfo[]>;
  save(parentSessionId: string, runs: WorkerInfo[]): void;
}

export interface AgentRunManagerDeps {
  runtime: WorkerRuntime;
  /** Worktree köprüsü; yoksa (git katmanı bağlanmadıysa) yalıtım istenemez. */
  worktrees: WorktreeService | null;
  /** Motorun olay veriyoluna yayın; koşu özet olayları ana oturumun kimliğiyle akar. */
  emit: (event: AgentEventInput) => void;
  /** Koşu istemi motorun dilinde üretilir. */
  buildPrompt: (task: string, isolated: boolean) => string;
  /** Worktree açılamadığında koşuya yazılacak neden. */
  worktreeError: (title: string) => string;
  /** Önceki açılışta yarıda kalan koşunun nedeni. */
  interruptedError: () => string;
  /**
   * Eşzamanlı ajan sınırı; ayar canlı okunur. Yuvalar (`slots`) bellekteki alt ajanlarla
   * paylaşılır: sınır iki ayrı sayaca bölünürse iki katı ajan aynı anda çalışırdı.
   */
  concurrency: () => number;
  /** Koşunun izin modu; worktree koşusu ayardan, yalıtımsız koşu ana oturumdan gelir. */
  permission: (input: { parentSessionId: string; isolated: boolean }) => PermissionMode;
  /** Koşu bitti; motor arka plan koşusunda ana oturumu dürter. */
  onEnded?: (run: WorkerSession, info: WorkerEndInfo) => void;
  store: AgentRunStore;
  now?: () => number;
}

/** Ana oturum başına tutulan geçmiş kaydı; eskiler düşer (transkript koşunun dosyasında durur). */
export const MAX_STORED_RUNS = 20;

/** Yarıda kalmış sayılan durumlar; açılışta `failed` işaretlenir. */
function unfinished(status: WorkerInfo["status"]): boolean {
  return status === "starting" || status === "working" || status === "waiting";
}

/**
 * Ayrık ajan koşularının havuzu: kuyruk, eşzamanlılık, inceleme ve kalıcılık. Motoru bilmez;
 * koşuları `WorkerRuntime` köprüsü üzerinden çalıştırır. Koşu, onu başlatan oturuma bağlıdır:
 * liste, olaylar ve kalıcılık ana oturum kimliğiyle kurulur.
 */
export class AgentRunManager {
  readonly #deps: AgentRunManagerDeps;
  readonly #now: () => number;
  /**
   * Canlı koşular: süren ve inceleme bekleyenler. Biten koşu kayda (`#loaded`) taşınır; aksi
   * hâlde süreç boyunca birikir ve her araç olayında taranırdı.
   */
  readonly #runs = new Map<string, WorkerSession>();
  /** Koşu oturumu → koşu; izin ve araç olayları oturum kimliğiyle gelir. */
  readonly #bySessionId = new Map<string, WorkerSession>();
  /** Biten ve önceki açılıştan gelen kayıtlar; `review` bekleyenler karar verilene kadar kalır. */
  readonly #loaded = new Map<string, WorkerInfo[]>();
  /** Eşzamanlı ajan yuvaları; motor bellekteki alt ajanları da bununla sınırlar. */
  readonly slots: Limiter;

  constructor(deps: AgentRunManagerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.slots = new Limiter(deps.concurrency);
    for (const [parent, runs] of deps.store.load()) {
      // Yarıda kalan koşu canlı değildir: sürdürme yok, `failed` işaretlenir; inceleme bekleyen
      // worktree koşusu olduğu gibi kalır ve kararı yine verilebilir.
      this.#loaded.set(
        parent,
        runs.map((run) =>
          unfinished(run.status)
            ? { ...run, status: "failed", error: deps.interruptedError() }
            : run,
        ),
      );
    }
  }

  /** Yalıtım mümkün mü (worktree köprüsü kurulu mu). */
  get canIsolate(): boolean {
    return this.#deps.worktrees !== null;
  }

  /** Ana klasör kirli mi; köprü yoksa ya da git okunamıyorsa değil sayılır. */
  async dirty(cwd: string): Promise<boolean> {
    const worktrees = this.#deps.worktrees;
    if (!worktrees) return false;
    return worktrees.dirty(cwd).catch(() => false);
  }

  /** Yeni koşu açar; eşzamanlılık sınırı doluysa kuyruğa alınır. */
  start(input: AgentRunStart): WorkerSession {
    const { isolation, ...rest } = input;
    const run = new WorkerSession(
      { ...rest, isolated: isolation !== "none" && this.canIsolate },
      {
        runtime: this.#deps.runtime,
        // Köprü yoksa yalıtım istenmez; `changedFiles` yalnız worktree'de çağrılır.
        worktrees: this.#deps.worktrees ?? NO_WORKTREES,
        buildPrompt: this.#deps.buildPrompt,
        onEvent: (event) => this.#onEvent(event),
      },
    );
    this.#runs.set(run.id, run);
    if (isolation === "required" && !this.canIsolate) {
      run.fail(this.#deps.worktreeError(run.title));
      return run;
    }
    this.#save(run.parentSessionId);
    void this.slots.run(() => this.#launch(run, isolation === "required")).catch(() => {});
    return run;
  }

  /** Ana oturumun koşuları (eskiden yeniye): kayıttakiler + canlılar. */
  list(parentSessionId: string): WorkerInfo[] {
    const live = [...this.#runs.values()]
      .filter((run) => run.parentSessionId === parentSessionId)
      .map((run) => run.info());
    return [...(this.#loaded.get(parentSessionId) ?? []), ...live].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  get(parentSessionId: string, runId: string): WorkerSession | undefined {
    const run = this.#runs.get(runId);
    return run?.parentSessionId === parentSessionId ? run : undefined;
  }

  /** Koşuyu durdurur; koşu bulunamadı ya da zaten bitmişse `false`. */
  stop(parentSessionId: string, runId: string): boolean {
    const run = this.get(parentSessionId, runId);
    if (!run || isTerminal(run.status)) return false;
    run.stop();
    return true;
  }

  /**
   * Çalışan koşuya yönlendirme. Yanıt koşunun turu bitene kadar bekletilmez: aksi hâlde
   * arayüzde ve modelin araç çağrısında "gönderiliyor" durumu dakikalarca asılı kalırdı. Sırada
   * bekleyen koşunun mesajı saklanır, koşu başlayınca göreve eklenir.
   */
  steer(parentSessionId: string, runId: string, message: string): boolean {
    const run = this.get(parentSessionId, runId);
    if (!run || isTerminal(run.status)) return false;
    void run.steer(message);
    return true;
  }

  /** İnceleme kararı: ana dala uygula ya da worktree'yi sil. */
  async review(
    parentSessionId: string,
    runId: string,
    decision: WorkerReviewDecision,
  ): Promise<void> {
    const worktrees = this.#deps.worktrees;
    const run = this.get(parentSessionId, runId);
    if (run) {
      if (!worktrees || run.worktree === "" || run.status !== "review") return;
      if (decision === "apply") {
        await worktrees.apply(run.cwd, run.worktree);
        run.markReviewed(true);
      } else {
        await worktrees.remove(run.cwd, run.worktree).catch(() => undefined);
        run.markReviewed(false);
      }
      this.#save(parentSessionId);
      return;
    }
    // Önceki açılıştan kalan koşu: karar yine verilebilmeli, aksi hâlde worktree asılı kalırdı.
    const loaded = this.#loaded.get(parentSessionId) ?? [];
    const index = loaded.findIndex((r) => r.id === runId);
    const stored = loaded[index];
    if (index < 0 || !stored || !worktrees || stored.worktree === "") return;
    if (decision === "apply") {
      await worktrees.apply(stored.cwd, stored.worktree);
      loaded[index] = { ...stored, status: "done" };
    } else {
      await worktrees.remove(stored.cwd, stored.worktree).catch(() => undefined);
      loaded[index] = { ...stored, status: "cancelled" };
    }
    this.#save(parentSessionId);
  }

  /** İnceleme ekranı için worktree diff'i; worktree yoksa boş dize. */
  async diff(parentSessionId: string, runId: string): Promise<string> {
    const worktrees = this.#deps.worktrees;
    if (!worktrees) return "";
    const path =
      this.get(parentSessionId, runId)?.worktree ||
      this.#loaded.get(parentSessionId)?.find((r) => r.id === runId)?.worktree;
    if (!path) return "";
    return worktrees.diff(path).catch(() => "");
  }

  /** Oturum süren bir ayrık koşunun oturumu mu; öyleyse o koşu. */
  runOf(sessionId: string): WorkerSession | undefined {
    return this.#bySessionId.get(sessionId);
  }

  /** Oturum süren bir ayrık koşunun oturumu mu; öyleyse ana oturumu. */
  parentOf(sessionId: string): string | undefined {
    return this.#bySessionId.get(sessionId)?.parentSessionId;
  }

  /** Koşunun son eylemi; motor araç olaylarını buraya bağlar. Bilinmeyen oturum yok sayılır. */
  noteActivity(sessionId: string, text: string): void {
    this.#bySessionId.get(sessionId)?.setActivity(text);
  }

  /** Koşu kullanıcıdan onay bekliyor ya da bekleyen onayı kalmadı. */
  markWaiting(sessionId: string, waiting: boolean): void {
    this.#bySessionId.get(sessionId)?.setWaiting(waiting);
  }

  /**
   * Ana oturum silindi: çalışan koşuları durdurulur, kayıtları düşer. Worktree'lere dokunulmaz;
   * uygulanmamış iş Ayarlar > Worktree'de görünmeye devam eder.
   */
  forget(parentSessionId: string): void {
    for (const run of [...this.#runs.values()]) {
      if (run.parentSessionId !== parentSessionId) continue;
      this.#runs.delete(run.id);
      run.stop();
    }
    this.#loaded.delete(parentSessionId);
    this.#deps.store.save(parentSessionId, []);
  }

  /** Uygulama kapanışında çalışan koşular durdurulur (oturumlar diskte kalır). */
  dispose(): void {
    for (const run of [...this.#runs.values()]) run.stop();
  }

  // ---------- iç işleyiş ----------

  /**
   * Yuva alan koşuyu başlatır; yuva koşu bitene kadar tutulur. Worktree açılması da yuvanın
   * içindedir: açılış sırasında sınır aşılmaz.
   */
  async #launch(run: WorkerSession, required: boolean): Promise<void> {
    // Sırada beklerken durdurulan koşu zaten `cancelled`dır; yuva hemen bırakılır.
    if (isTerminal(run.status)) return;
    const worktree = run.isolated ? await this.#worktreeFor(run, required) : "";
    if (worktree === null) {
      // İstenen worktree açılamadı: koşu başlamaz, neden görünür kalır.
      run.fail(this.#deps.worktreeError(run.title));
      return;
    }
    // Worktree açılırken koşu durdurulmuş olabilir; açılan klasör geri alınır.
    if (isTerminal(run.status)) {
      if (worktree !== "") await this.#deps.worktrees?.remove(run.cwd, worktree).catch(() => {});
      return;
    }
    const permission = this.#deps.permission({
      parentSessionId: run.parentSessionId,
      isolated: worktree !== "",
    });
    await run.start(worktree, permission);
  }

  /**
   * Koşunun worktree'si. `preferred` yalıtımda açılamazsa kökte sürer (boş dize), `required`
   * yalıtımda koşu başlamaz (null).
   */
  async #worktreeFor(run: WorkerSession, required: boolean): Promise<string | null> {
    const worktrees = this.#deps.worktrees;
    if (!worktrees) return required ? null : "";
    const path = await worktrees
      .create({ cwd: run.cwd, name: run.title, id: run.id })
      .catch(() => "");
    if (path !== "") return path;
    return required ? null : "";
  }

  #onEvent(event: WorkerEvent): void {
    const run = event.worker;
    const base = { sessionId: run.parentSessionId, at: this.#now() };
    switch (event.kind) {
      case "started":
        this.#deps.emit({
          ...base,
          type: "worker_started",
          workerId: run.id,
          title: run.title,
          worktree: run.worktree,
          workerSessionId: run.sessionId,
        });
        if (run.sessionId) this.#bySessionId.set(run.sessionId, run);
        this.#save(run.parentSessionId);
        break;
      case "status":
        this.#deps.emit({
          ...base,
          type: "worker_status",
          workerId: run.id,
          status: run.status,
          ...(event.activity ? { activity: event.activity } : {}),
        });
        // İnceleme kararı da bir durum geçişidir; diske yalnız koşu sınırlarında yazılır.
        if (run.status === "done" || run.status === "cancelled") {
          this.#archive(run);
          this.#save(run.parentSessionId);
        }
        break;
      case "report":
        this.#deps.emit({ ...base, type: "worker_report", workerId: run.id, report: run.report });
        break;
      case "ended":
        this.#deps.emit({
          ...base,
          type: "worker_ended",
          workerId: run.id,
          title: run.title,
          info: event.info,
        });
        if (run.sessionId) this.#bySessionId.delete(run.sessionId);
        // İnceleme bekleyen koşu kararı canlı nesneyle alır; diğerleri kayda geçer.
        if (run.status !== "review") this.#archive(run);
        this.#save(run.parentSessionId);
        void this.#afterEnd(run, event.info);
        break;
    }
  }

  /**
   * İnceleme beklemeyen worktree koşusunun (değişiklik bırakmayan; biten, duran ya da hata veren)
   * klasörü ve dalı temizlenir: incelenecek bir şey yoktur, kalırsa sahipsiz birikir.
   */
  async #afterEnd(run: WorkerSession, info: WorkerEndInfo): Promise<void> {
    if (run.worktree !== "" && run.status !== "review") {
      await this.#deps.worktrees?.remove(run.cwd, run.worktree).catch(() => undefined);
    }
    this.#deps.onEnded?.(run, info);
  }

  /**
   * Biten koşu canlı listeden kayda geçer. Ana oturum silindiyse (`forget`) koşu listede
   * değildir; kaydı yeniden açılmaz.
   */
  #archive(run: WorkerSession): void {
    if (!this.#runs.delete(run.id)) return;
    const loaded = this.#loaded.get(run.parentSessionId) ?? [];
    this.#loaded.set(run.parentSessionId, [...loaded, run.info()].slice(-MAX_STORED_RUNS));
  }

  /** Ana oturumun kaydı: kayıttakiler + canlılar, en yeni `MAX_STORED_RUNS` kadarı. */
  #save(parentSessionId: string): void {
    this.#deps.store.save(parentSessionId, this.list(parentSessionId).slice(-MAX_STORED_RUNS));
  }
}

/** Köprü kurulmadığında `WorkerSession`'a verilen boş servis; yalıtım zaten istenmez. */
const NO_WORKTREES: WorktreeService = {
  create: async () => "",
  remove: async () => {},
  changedFiles: async () => [],
  diff: async () => "",
  apply: async () => {},
  dirty: async () => false,
};
