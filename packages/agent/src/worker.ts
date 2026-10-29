import type {
  AgentInfo,
  PermissionMode,
  Usage,
  WorkerEndInfo,
  WorkerInfo,
  WorkerReport,
  WorkerStatus,
} from "@codezal/contracts";

/**
 * Ayrık ajan koşusunun motor tarafındaki karşılığı. `AgentRunManager` motoru bilmez; böylece
 * havuz ve yaşam döngüsü Pi'den bağımsız test edilebilir ve motor tek yerde kalır.
 */
export interface WorkerRuntime {
  /** Koşu oturumunu açar (cwd = worktree ya da ana klasör) ve oturum kimliğini döndürür. */
  open(input: {
    cwd: string;
    title: string;
    profile: AgentInfo;
    parentSessionId: string;
    permission: PermissionMode;
  }): Promise<string>;
  /** Açılan oturumun modeli (`sağlayıcı/kimlik`) ve düşünme düzeyi; panel satırı bunu gösterir. */
  describe?(sessionId: string): { model?: string; thinking?: string };
  /** Görev metnini koşuya gönderir; tur bitince çözülür. */
  run(sessionId: string, prompt: string): Promise<void>;
  /** Sürdürülen turu durdurur. */
  abort(sessionId: string): void;
  /** Oturumun toplam tüketimi. */
  usage(sessionId: string): Usage;
  /** Son asistan metni; ana oturuma dönen özet buradan alınır. */
  lastText(sessionId: string): string;
  /** Oturumu kapatır; oturum dosyası diskte kalır (transkript sonradan açılabilir). */
  close(sessionId: string): void;
}

/**
 * Git işlemleri main süreçte kalır: motor worktree'yi bu köprü üzerinden açar, `main/git.ts`
 * tek kaynak olmaya devam eder.
 */
export interface WorktreeService {
  /**
   * `id` koşunun kimliğidir: aynı adlı iki koşu aynı worktree/dal adını istemez, ad bu yüzden
   * kimlikle birlikte üretilir.
   */
  create(input: { cwd: string; name: string; id: string }): Promise<string>;
  remove(cwd: string, path: string): Promise<void>;
  /** Worktree'de değişen dosyaların depo-göreli listesi. */
  changedFiles(cwd: string, path: string): Promise<string[]>;
  /** Worktree'deki değişikliklerin diff'i; inceleme ekranı bunu gösterir. */
  diff(path: string): Promise<string>;
  /** Koşu dalını ana dala uygular (merge). */
  apply(cwd: string, path: string): Promise<void>;
  /**
   * Ana klasörde commit'lenmemiş (izlenmeyenler dahil) değişiklik var mı. Worktree HEAD'den
   * açılır ve bunları görmez; otomatik yalıtım kirli ağaçta bu yüzden yapılmaz.
   */
  dirty(cwd: string): Promise<boolean>;
}

/** Koşu yaşam döngüsü olayı; havuz bunu veriyoluna çevirir. */
export type WorkerEvent =
  | { kind: "started"; worker: WorkerSession }
  | { kind: "status"; worker: WorkerSession; activity?: string }
  | { kind: "report"; worker: WorkerSession }
  | { kind: "ended"; worker: WorkerSession; info: WorkerEndInfo };

export interface WorkerSessionDeps {
  runtime: WorkerRuntime;
  worktrees: WorktreeService;
  /** Görev istemi motorun dilinde üretilir: rol (yalıtımlı mı) + görev. */
  buildPrompt: (task: string, isolated: boolean) => string;
  onEvent: (event: WorkerEvent) => void;
}

/** Koşu sonucunun saklanan üst uzunluğu; tam metin koşunun kendi oturum dosyasındadır. */
export const MAX_RESULT_CHARS = 4_000;

let workerSeq = 0;

/** Koşu kimliği: okunur olsun diye zaman damgası + süreç sayacı. */
function nextWorkerId(): string {
  workerSeq += 1;
  return `run-${Date.now().toString(36)}-${workerSeq}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Koşu bitmiş mi; biten koşuya yönlendirme gönderilmez. */
export function isTerminal(status: WorkerStatus): boolean {
  return status === "review" || status === "done" || status === "failed" || status === "cancelled";
}

export interface WorkerSessionInput {
  parentSessionId: string;
  /** Kök klasör: yalıtımsız koşu burada çalışır, worktree bundan açılır. */
  cwd: string;
  profile: AgentInfo;
  title: string;
  task: string;
  isolated: boolean;
  background: boolean;
}

/**
 * Tek ayrık koşunun yaşam döngüsü: (worktree'de) oturum aç → görevi ver → bitişte özeti ve
 * değişen dosyaları topla → durumu güncelle. Değişiklik bırakan worktree koşusu `review`
 * durumuna geçer; birleştirme kararı kullanıcınındır.
 */
export class WorkerSession {
  readonly id = nextWorkerId();
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly profile: AgentInfo;
  readonly title: string;
  readonly task: string;
  readonly background: boolean;
  readonly createdAt = Date.now();
  readonly #deps: WorkerSessionDeps;
  #status: WorkerStatus = "starting";
  /** İstenen yalıtım; worktree açılamazsa (git deposu değil) koşu kökte çalışır ve düşer. */
  #isolated: boolean;
  #worktree = "";
  #sessionId: string | null = null;
  #startedAt: number | undefined;
  #endedAt: number | undefined;
  #activity: string | undefined;
  #report: WorkerReport = { done: [], active: [], waiting: [] };
  #usage: Usage | undefined;
  #result: string | undefined;
  #error: string | null = null;
  #files: string[] = [];
  #model: string | undefined;
  #thinking: string | undefined;
  /** Çalıştırılan araç sayısı; satırdaki "adım". */
  #steps = 0;
  #stopped = false;
  /** Oturum açılıyor: bu sırada gelen durdurma açılış bitince sonuçlanır. */
  #opening = false;
  /** Koşu başlamadan gelen yönlendirmeler; görevle birlikte verilir. */
  readonly #queuedSteers: string[] = [];
  readonly #ended: Promise<void>;
  #resolveEnded: () => void = () => {};
  readonly #started: Promise<void>;
  #resolveStarted: () => void = () => {};

  constructor(input: WorkerSessionInput, deps: WorkerSessionDeps) {
    this.parentSessionId = input.parentSessionId;
    this.cwd = input.cwd;
    this.profile = input.profile;
    this.title = input.title;
    this.task = input.task;
    this.#isolated = input.isolated;
    this.background = input.background;
    this.#deps = deps;
    this.#ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
    this.#started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  get status(): WorkerStatus {
    return this.#status;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get worktree(): string {
    return this.#worktree;
  }

  get isolated(): boolean {
    return this.#isolated;
  }

  get files(): readonly string[] {
    return this.#files;
  }

  /** Koşu bitince (başarı, hata ya da iptal) çözülür; bekletilen worktree koşusu bunu bekler. */
  get ended(): Promise<void> {
    return this.#ended;
  }

  /**
   * Görev verildiğinde (ya da koşu hiç başlamadan bittiğinde) çözülür. Bekletilen koşunun süre
   * sınırı buradan sayılır: sırada geçen süre koşunun süresi değildir.
   */
  get started(): Promise<void> {
    return this.#started;
  }

  /** Renderer'a giden görünüm; `agentRuns:*` yanıtları ve olaylar bu şemayı kullanır. */
  info(): WorkerInfo {
    return {
      id: this.id,
      parentSessionId: this.parentSessionId,
      cwd: this.cwd,
      agent: this.profile.name,
      title: this.title,
      task: this.task,
      status: this.#status,
      isolated: this.#isolated,
      background: this.background,
      worktree: this.#worktree,
      sessionId: this.#sessionId,
      createdAt: this.createdAt,
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      ...(this.#endedAt === undefined ? {} : { endedAt: this.#endedAt }),
      ...(this.#activity === undefined ? {} : { activity: this.#activity }),
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#thinking ? { thinking: this.#thinking } : {}),
      stepsDone: this.#steps,
      stepsTotal: this.#steps,
      ...(this.#files.length > 0 ? { filesChanged: this.#files.length } : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(this.#result ? { result: this.#result } : {}),
      error: this.#error,
    };
  }

  /**
   * Koşuyu başlatır: hazır klasörde (worktree ya da kök) oturum açar, görevi verir, bitişte
   * durumu kapatır. `worktree` boşsa koşu yalıtımsızdır.
   */
  async start(worktree: string, permission: PermissionMode): Promise<void> {
    this.#worktree = worktree;
    this.#isolated = worktree !== "";
    this.#opening = true;
    try {
      this.#sessionId = await this.#deps.runtime.open({
        cwd: worktree === "" ? this.cwd : worktree,
        title: this.title,
        profile: this.profile,
        parentSessionId: this.parentSessionId,
        permission,
      });
    } catch (error) {
      this.#opening = false;
      this.#finish(this.#stopped ? "cancelled" : "failed", errorText(error));
      return;
    }
    this.#opening = false;
    // Kurulum sırasında gelen durdurma: koşu hiç başlamış sayılmaz, tur açılmaz (boşa token
    // harcanmaz); açılan oturum bitişte kapanır.
    if (this.#stopped) {
      this.#finish("cancelled", "");
      return;
    }
    const meta = this.#deps.runtime.describe?.(this.#sessionId);
    this.#model = meta?.model;
    this.#thinking = meta?.thinking;
    this.#startedAt = Date.now();
    this.#set("working");
    this.#deps.onEvent({ kind: "started", worker: this });
    this.#resolveStarted();
    const prompt = [this.#deps.buildPrompt(this.task, worktree !== ""), ...this.#queuedSteers];
    this.#queuedSteers.length = 0;
    try {
      await this.#deps.runtime.run(this.#sessionId, prompt.join("\n\n"));
      if (this.#stopped) {
        // Durdurulan koşunun yaptığı iş kaybolmasın: değişiklik varsa inceleme bekler.
        this.#files = await this.#changedFiles();
        this.#finish("cancelled", "");
        return;
      }
      // Sonuç meta dosyasında taşınır; kırpılmazsa uzun raporlar her kayıtta dosyayı şişirir.
      this.#result = this.#deps.runtime.lastText(this.#sessionId).trim().slice(0, MAX_RESULT_CHARS);
      this.#usage = this.#deps.runtime.usage(this.#sessionId);
      this.#files = await this.#changedFiles();
      this.#finish("done", "");
    } catch (error) {
      this.#files = await this.#changedFiles();
      this.#finish(this.#stopped ? "cancelled" : "failed", errorText(error));
    }
  }

  /**
   * Çalışan koşuya yönlendirme. Pi tur sürerken gelen mesajı kuyruğa alır (mevcut `steer`
   * davranışı), bu yüzden ayrı bir tur açılmaz.
   */
  async steer(message: string): Promise<void> {
    if (isTerminal(this.#status)) return;
    const sessionId = this.#sessionId;
    // Sırada ya da açılışta: mesaj kaybolmasın, görevle birlikte verilir.
    if (!sessionId || this.#opening) {
      this.#queuedSteers.push(message);
      return;
    }
    // Onay bekleyen koşu yönlendirmeyle "çalışıyor"a dönmez: kart hâlâ yanıt bekliyor.
    this.#set(this.#status === "waiting" ? "waiting" : "working", message);
    try {
      await this.#deps.runtime.run(sessionId, message);
    } catch (error) {
      this.#finish("failed", errorText(error));
    }
  }

  /** Turu durdurur; koşu `cancelled` durumuna geçer. */
  stop(): void {
    if (isTerminal(this.#status)) return;
    this.#stopped = true;
    if (this.#sessionId) this.#deps.runtime.abort(this.#sessionId);
    // Henüz oturumu olmayan koşu (kuyrukta ya da worktree hazırlanırken): durdurma kararı burada
    // sonuçlanmalı. Aksi hâlde koşu `starting` durumunda asılı kalıyor ve yuvayı tutuyordu.
    // Açılış sürüyorsa karar `start` içinde verilir: burada bitirmek koşuyu iki kez bitirirdi.
    else if (this.#status === "starting" && !this.#opening) this.#finish("cancelled", "");
  }

  /** Koşu raporunun son hâli: süren işte son eylem, biten koşuda sonuç özeti. */
  get report(): WorkerReport {
    return this.#report;
  }

  /**
   * Koşu hiç başlamadan bitirilir (ör. worktree açılamadı). Aksi hâlde `starting` durumunda
   * asılı kalır ve kullanıcı ne olduğunu göremezdi.
   */
  fail(reason: string): void {
    this.#finish("failed", reason);
  }

  /** Son eylem: durum aynı kalır, eylem ve rapor güncellenir. Motor araç olaylarını buraya bağlar. */
  setActivity(activity: string): void {
    if (isTerminal(this.#status)) return;
    this.#steps += 1;
    this.#set(this.#status, activity);
  }

  /** Bekleyen soru/izin koşuyu "seni bekliyor" durumuna geçirir; yanıt gelince geri döner. */
  setWaiting(waiting: boolean, activity?: string): void {
    if (isTerminal(this.#status)) return;
    // Beklemeyen koşuyu "çalışıyor"a yeniden yazmak son eylemi silerdi.
    if (!waiting && this.#status !== "waiting") return;
    this.#report = {
      ...this.#report,
      waiting: waiting ? [activity ?? this.#activity ?? this.title] : [],
    };
    this.#set(waiting ? "waiting" : "working", activity ?? this.#activity);
  }

  /** Birleştirme kararı sonrası durum: uygulandıysa `done`, silindiyse `cancelled`. */
  markReviewed(applied: boolean): void {
    this.#status = applied ? "done" : "cancelled";
    this.#endedAt = this.#endedAt ?? Date.now();
    this.#deps.onEvent({ kind: "status", worker: this });
  }

  async #changedFiles(): Promise<string[]> {
    if (!this.#sessionId || this.#worktree === "") return [];
    try {
      return await this.#deps.worktrees.changedFiles(this.#worktree, this.#worktree);
    } catch {
      // Diff alınamazsa bitiş özeti yine verilir: dosya listesi süs, sonuç değil.
      return [];
    }
  }

  #set(status: WorkerStatus, activity?: string): void {
    this.#status = status;
    if (activity !== undefined) this.#activity = activity;
    // Raporun "süren" satırı son eylemdir; Ajanlar kutusu bunu canlı gösterir.
    this.#report = { ...this.#report, active: activity === undefined ? [] : [activity] };
    this.#deps.onEvent({ kind: "status", worker: this, ...(activity ? { activity } : {}) });
    this.#deps.onEvent({ kind: "report", worker: this });
  }

  /** Koşuyu bitirir: durum, sonuç ve tüketim yazılır; olay yayınlanır; oturum kapatılır. */
  #finish(status: "done" | "failed" | "cancelled", error: string): void {
    // Tek bitiş: ikinci çağrı (ör. açılışla yarışan durdurma) olayları yinelemesin.
    if (this.#endedAt !== undefined) return;
    this.#error = error === "" ? null : error;
    this.#endedAt = Date.now();
    // Değişiklik bırakan worktree koşusu birleştirme bekler (`review`); `done` uygulandıktan sonra.
    // Durdurulan ya da hata veren koşunun değişikliği de incelenir: yarım iş bile olsa karar
    // kullanıcınındır, aksi hâlde worktree sahipsiz kalıyordu. Bitiş bilgisi asıl sonucu taşır.
    this.#status = this.#files.length > 0 ? "review" : status;
    const summary = (this.#result ?? "").trim();
    this.#report = { done: summary === "" ? [] : [summary.slice(0, 300)], active: [], waiting: [] };
    const info: WorkerEndInfo = {
      status,
      result: this.#result ?? "",
      files: this.#files,
      durationMs: this.#endedAt - (this.#startedAt ?? this.createdAt),
      ...(this.#usage ? { usage: this.#usage } : {}),
    };
    // Önce rapor, sonra bitiş: satır "tamamlanan" maddesini bitişten önce görsün.
    this.#deps.onEvent({ kind: "report", worker: this });
    this.#deps.onEvent({ kind: "ended", worker: this, info });
    if (this.#sessionId) this.#deps.runtime.close(this.#sessionId);
    this.#resolveStarted();
    this.#resolveEnded();
  }
}
