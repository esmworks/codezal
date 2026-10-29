import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { removeQuietly } from "./fsx.js";
import { type BatchItem, MAX_SNAPSHOT_BYTES, type SnapshotStore } from "./snapshots.js";

/**
 * Terminal (`bash`) komutlarının tur yedeği.
 *
 * Komutun hangi dosyalara dokunacağı önceden bilinemez. Seçilen yol: komuttan önce çalışma
 * klasörünün ucuz bir dizini çıkarılır, komuttan sonra yeniden çıkarılıp karşılaştırılır;
 * değişen/silinen dosyanın tur öncesi içeriği, oluşan dosyanın da "yoktu" bilgisi tur yedeğine
 * yazılır. Tur öncesi içeriğin kaynağı:
 *
 * - Git deposunda izlenen ve index'e göre temiz dosya: index'teki blob. Bu dosyalar ne
 *   kopyalanır ne `stat` edilir (büyük depoda bedel git'in kendi listesidir); değişim, komut
 *   sonrası index nesnesinin değişmesi ya da dosyanın kirli/silinmiş görünmesiyle anlaşılır
 *   (`git add`/`commit` ile index'e alınan değişiklik de yakalanır). İçerik komut sonrası
 *   `git cat-file --filters` ile çalışma kopyası biçiminde okunur; okunamazsa dosya
 *   "yedeklenemedi" diye bildirilir.
 * - Diğerleri (git dışı klasör, izlenmeyen ya da kirli dosya): komuttan önce kopyalanır. Kopya
 *   APFS/Btrfs'te klon (`COPYFILE_FICLONE`) olduğundan ucuzdur; yine de tur başına bayt bütçesi
 *   vardır ve aynı tur içinde değişmeyen dosya yeniden kopyalanmaz.
 *
 * Bedel: her komut iki tarama ister; çok büyük klasörde tarama dosya/süre sınırında kesilir ve tur
 * yedeği "eksik" işaretlenir (geri alma bunu bildirir). Liste eksikken yeni oluşan dosya ile
 * taranmamış eski dosya ayırt edilemez: o durumda oluşan dosyalar **silinmek üzere kaydedilmez**
 * (yanlışlıkla kullanıcı dosyası silmektense eksik geri alma). Git deposunda `.gitignore`'daki
 * dosyalar, git dışında ağır klasörler (`node_modules`, sanal ortamlar, önbellekler) ve çıktı
 * klasörü taranmaz. Arka plana alınan komutun (90 sn penceresi, `bash_background`) araç sonucu
 * döndükten sonraki yazımları kapsanmaz.
 */

/** Komut öncesi taramada en çok bu kadar dosya ölçülür; aşılırsa tur yedeği "eksik" sayılır. */
export const BASH_INDEX_MAX_FILES = 20_000;
/** Tarama ve kopyalama süre sınırı (ms): ağ diski ya da dev klasörde komut beklemesin. */
export const BASH_SCAN_BUDGET_MS = 3_000;
/** Bir turda komut öncesi kopyalanan toplam bayt (git nesnesiyle kapsanmayan dosyalar). */
export const BASH_STAGE_MAX_BYTES = 64 * 1024 * 1024;
/** Tek komut sonrası kaydedilen değişiklik sınırı; `git checkout` binlerce dosyayı çevirebilir. */
export const BASH_MAX_CHANGES = 2_000;

/** Git dışı klasörde inilmeyen ağır ya da üretilmiş klasörler (git deposunda `.gitignore` geçerli). */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  "Pods",
  "DerivedData",
]);

export interface FileSig {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface TreeScan {
  /** Taramanın başladığı an; oluşma zamanı bundan eski dosya "yeni" sayılmaz. */
  startedAt: number;
  /** Taranan klasörün mutlak yolu (yeniden adlandırma tespitinde `git hash-object` için). */
  root: string;
  mode: "git" | "walk";
  /** Listelenen bütün yollar (oluşan dosya tespiti için). */
  all: Set<string>;
  /** Liste tam mı; değilse oluşan dosyalar güvenle ayırt edilemez. */
  listComplete: boolean;
  /** Ölçülen dosyalar: git dışında hepsi, git'te kirli ve izlenmeyenler. */
  files: Map<string, FileSig>;
  /** Git deposunda index'e göre temiz izlenen dosyaların blob'u (mutlak yol → nesne). */
  blobs: Map<string, string>;
  /** cwd'nin depo köküne göre öneki (`alt/`); `cat-file --path` kök-göreli yol ister. */
  prefix: string;
  /** Dosya ya da süre sınırı aşıldı: dizin eksik. */
  partial: boolean;
}

export interface ScanOptions {
  /** Taranmayacak mutlak klasörler (çıktı klasörü vb.). */
  skip?: readonly string[];
  maxFiles?: number;
  budgetMs?: number;
}

export interface TreeDiff {
  created: string[];
  modified: string[];
  deleted: string[];
  /** Fark eksik: oluşan dosyalar güvenle ayırt edilemedi. */
  partial: boolean;
}

export type FileChangeKind = "create" | "edit" | "delete";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
}

/** Yedeğin yazılacağı yer: oturum + kullanıcı mesajı sırası (alt ajanda ana oturumun turu). */
export interface CheckpointRoute {
  sessionId: string;
  turn: number;
}

function sigOf(stat: Stats): FileSig {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sameSig(a: FileSig, b: FileSig): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function under(path: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
        // Kullanıcının git işlemleriyle `index.lock` yarışına girilmesin: index tazelenip yazılmaz.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
  });
}

function nulList(out: Buffer): string[] {
  return out.toString("utf8").split("\0").filter(Boolean);
}

/** Yolları sınırlı eşzamanlılıkla `lstat`'lar; yalnız normal dosyalar (bağlar atlanır) döner. */
async function statFiles(
  paths: readonly string[],
  deadline: number,
): Promise<{ files: Map<string, FileSig>; partial: boolean }> {
  const files = new Map<string, FileSig>();
  const BATCH = 64;
  for (let i = 0; i < paths.length; i += BATCH) {
    if (Date.now() > deadline) return { files, partial: true };
    const chunk = paths.slice(i, i + BATCH);
    const stats = await Promise.all(chunk.map((p) => lstat(p).catch(() => null)));
    chunk.forEach((p, j) => {
      const stat = stats[j];
      if (stat?.isFile()) files.set(p, sigOf(stat));
    });
  }
  return { files, partial: false };
}

async function scanGit(
  cwd: string,
  skip: readonly string[],
  maxFiles: number,
  deadline: number,
): Promise<Omit<TreeScan, "startedAt" | "root"> | null> {
  let prefix: string;
  try {
    prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).toString("utf8").trim();
  } catch {
    return null;
  }
  const [staged, modified, untracked] = await Promise.all([
    git(cwd, ["ls-files", "-s", "-z"]),
    git(cwd, ["ls-files", "-m", "-z"]),
    git(cwd, ["ls-files", "-o", "--exclude-standard", "-z"]),
  ]);
  const abs = (rel: string) => join(cwd, rel);
  const dirty = new Set(nulList(modified).map(abs));
  const all = new Set<string>();
  const blobs = new Map<string, string>();
  for (const line of nulList(staged)) {
    // Biçim: "<mod> <nesne> <aşama>\t<yol>"; alt modül (160000) ve sembolik bağ (120000) atlanır.
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, hash, stage] = line.slice(0, tab).split(" ");
    if (mode === "160000" || mode === "120000") continue;
    const path = abs(line.slice(tab + 1));
    if (under(path, skip)) continue;
    all.add(path);
    // Çakışmalı (aşama ≠ 0) ya da kirli dosyanın blob'u çalışma kopyasını temsil etmez.
    if (stage === "0" && hash && !dirty.has(path)) blobs.set(path, hash);
    else {
      blobs.delete(path);
      dirty.add(path);
    }
  }
  const measured: string[] = [];
  for (const path of dirty) if (all.has(path)) measured.push(path);
  for (const rel of nulList(untracked)) {
    const path = abs(rel);
    if (under(path, skip)) continue;
    all.add(path);
    measured.push(path);
  }
  const partial = measured.length > maxFiles;
  const stat = await statFiles(measured.slice(0, maxFiles), deadline);
  return {
    mode: "git",
    all,
    listComplete: true,
    files: stat.files,
    blobs,
    prefix,
    partial: partial || stat.partial,
  };
}

async function scanWalk(
  cwd: string,
  skip: readonly string[],
  maxFiles: number,
  deadline: number,
): Promise<Omit<TreeScan, "startedAt" | "root">> {
  const files = new Map<string, FileSig>();
  const queue = [cwd];
  let partial = false;
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const paths: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (under(path, skip)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) paths.push(path);
    }
    const room = Math.max(maxFiles - files.size, 0);
    if (paths.length > room) partial = true;
    const stat = await statFiles(paths.slice(0, room), deadline);
    for (const [path, sig] of stat.files) files.set(path, sig);
    if (stat.partial) partial = true;
    // Sınır aşıldı: kalan klasörlere inilmez, dizin "eksik" kalır.
    if (partial) break;
  }
  return {
    mode: "walk",
    all: new Set(files.keys()),
    listComplete: !partial,
    files,
    blobs: new Map(),
    prefix: "",
    partial,
  };
}

/**
 * Çalışma klasörünün dizini. Git deposunda dosya listesi git'ten gelir (`.gitignore` geçerli),
 * aksi hâlde klasör gezilir. Git komutu düşerse (kilit, zaman aşımı) gezmeye dönülür; hata
 * fırlatılmaz, en kötü ihtimalle dizin "eksik" döner.
 */
export async function scanTree(cwd: string, options: ScanOptions = {}): Promise<TreeScan> {
  const startedAt = Date.now();
  const root = resolve(cwd);
  const skip = (options.skip ?? []).map((dir) => resolve(dir));
  const maxFiles = options.maxFiles ?? BASH_INDEX_MAX_FILES;
  const deadline = startedAt + (options.budgetMs ?? BASH_SCAN_BUDGET_MS);
  const viaGit = await scanGit(root, skip, maxFiles, deadline).catch(() => null);
  const scan = viaGit ?? (await scanWalk(root, skip, maxFiles, deadline));
  return { startedAt, root, ...scan };
}

/**
 * Oluşma zamanı komuttan eski görünen yeni yol, komutun sildiği bir dosyanın yeni adı mı?
 * `mv`/`git mv` inode'u ve oluşma zamanını korur; aynı inode ya da aynı git nesnesi yeniden
 * adlandırmadır. Böyle dosya "oluştu" sayılır: geri alma yeni adı siler, eski adı yedekten yazar.
 */
async function isRenameTarget(
  path: string,
  stat: Stats,
  root: string,
  after: TreeScan,
  goneInos: ReadonlySet<number>,
  goneBlobs: ReadonlySet<string>,
): Promise<boolean> {
  if (goneInos.has(stat.ino)) return true;
  if (goneBlobs.size === 0) return false;
  const staged = after.blobs.get(path);
  if (staged) return goneBlobs.has(staged);
  try {
    const hash = (await git(root, ["hash-object", "--", path])).toString("utf8").trim();
    return goneBlobs.has(hash);
  } catch {
    return false;
  }
}

/**
 * İki dizin arasındaki fark. Önceki dizinde ölçülen her yol yeniden ölçülür (sonraki dizinde
 * yoksa doğrudan `lstat`); temiz izlenen dosya, index nesnesi aynı ve hâlâ temizse değişmemiş
 * sayılır. Oluşan dosyalar yalnız önceki liste tamsa ve iki tarama aynı yolla yapıldıysa sayılır;
 * oluşma zamanı komuttan eski olan dosya da, silinen bir dosyanın yeni adı değilse "yeni"
 * sayılmaz (geri alma onu silerdi).
 */
export async function diffScans(before: TreeScan, after: TreeScan): Promise<TreeDiff> {
  const modified: string[] = [];
  const deleted: string[] = [];
  let partial = false;
  const recheck = async (path: string, sig: FileSig | undefined) => {
    const stat = await lstat(path).catch(() => null);
    if (!stat) deleted.push(path);
    else if (stat.isFile() && (!sig || !sameSig(sig, sigOf(stat)))) modified.push(path);
  };
  for (const [path, sig] of before.files) {
    const now = after.files.get(path);
    if (now) {
      if (!sameSig(sig, now)) modified.push(path);
    } else await recheck(path, sig);
  }
  for (const [path, hash] of before.blobs) {
    if (after.blobs.get(path) === hash) continue;
    await recheck(path, undefined);
  }
  const created: string[] = [];
  if (!before.listComplete || before.mode !== after.mode) {
    partial = true;
  } else {
    if (!after.listComplete) partial = true;
    const goneInos = new Set<number>();
    const goneBlobs = new Set<string>();
    for (const path of deleted) {
      const sig = before.files.get(path);
      if (sig) goneInos.add(sig.ino);
      const hash = before.blobs.get(path);
      if (hash) goneBlobs.add(hash);
    }
    for (const path of after.all) {
      if (before.all.has(path)) continue;
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile()) continue;
      // Oluşma zamanı biliniyorsa ve komuttan eskiyse dosya önceden vardı (ör. `git add -f` ile
      // dizine giren yok sayılan dosya): silinmek üzere kaydedilmez.
      if (
        stat.birthtimeMs > 0 &&
        stat.birthtimeMs < before.startedAt - 2_000 &&
        !(await isRenameTarget(path, stat, after.root, after, goneInos, goneBlobs))
      ) {
        partial = true;
        continue;
      }
      created.push(path);
    }
  }
  return { created, modified, deleted, partial };
}

/** Git index'indeki blob'u çalışma kopyası biçiminde (satır sonu/filtre uygulanmış) okur. */
async function readBlob(
  cwd: string,
  prefix: string,
  path: string,
  hash: string,
): Promise<Buffer | null> {
  const rel = `${prefix}${relative(cwd, path).split(sep).join("/")}`;
  try {
    return await git(cwd, ["cat-file", "--filters", `--path=${rel}`, hash]);
  } catch {
    return null;
  }
}

export interface CheckpointLimits {
  maxFiles: number;
  budgetMs: number;
  stageBytes: number;
  maxChanges: number;
}

interface Staged {
  sig: FileSig;
  file: string;
}

interface TurnStage {
  route: CheckpointRoute;
  dir: string;
  files: Map<string, Staged>;
  bytes: number;
  seq: number;
  /** Süren komut sayısı (alt ajanlar aynı tura yazar). */
  inflight: number;
}

interface Pending {
  route: CheckpointRoute;
  cwd: string;
  skip: readonly string[];
  before: TreeScan;
  stage: TurnStage;
}

/**
 * Komut başına öncesi/sonrası ölçümünü yürütür ve sonucu `SnapshotStore`'a yazar. Pi bir yanıttaki
 * paralel araç çağrılarının bütün `tool_call` kancalarını hiçbirini çalıştırmadan önce sıraladığı
 * için kardeş komutların öncesi taraması aynı (toplu çalıştırma öncesi) hâli görür.
 */
export class BashCheckpoints {
  readonly #store: SnapshotStore;
  readonly #limits: CheckpointLimits;
  readonly #stages = new Map<string, TurnStage>();
  readonly #pending = new Map<string, Pending>();

  constructor(store: SnapshotStore, limits: Partial<CheckpointLimits> = {}) {
    this.#store = store;
    this.#limits = {
      maxFiles: limits.maxFiles ?? BASH_INDEX_MAX_FILES,
      budgetMs: limits.budgetMs ?? BASH_SCAN_BUDGET_MS,
      stageBytes: limits.stageBytes ?? BASH_STAGE_MAX_BYTES,
      maxChanges: limits.maxChanges ?? BASH_MAX_CHANGES,
    };
  }

  #stageFor(route: CheckpointRoute): TurnStage {
    const key = `${route.sessionId}\0${route.turn}`;
    const existing = this.#stages.get(key);
    if (existing) return existing;
    // Aynı oturumun eski turlarına ait kopyalar artık gerekmez (o turun yedeği kapandı); süren
    // komutu olan tur (ör. önceki turda başlatılmış alt ajan) korunur.
    for (const [other, stage] of this.#stages) {
      if (stage.route.sessionId !== route.sessionId || stage.inflight > 0) continue;
      removeQuietly(stage.dir, { recursive: true });
      this.#stages.delete(other);
    }
    const fresh: TurnStage = {
      route,
      dir: this.#store.stageDir(route.sessionId, route.turn),
      files: new Map(),
      bytes: 0,
      seq: 0,
      inflight: 0,
    };
    this.#stages.set(key, fresh);
    return fresh;
  }

  /** Komut çalışmadan önce: dizin çıkarılır, git'le kapsanmayan dosyalar kopyalanır. */
  async begin(
    callId: string,
    route: CheckpointRoute,
    cwd: string,
    skip: readonly string[] = [],
  ): Promise<void> {
    const stage = this.#stageFor(route);
    stage.inflight += 1;
    try {
      const before = await scanTree(cwd, {
        skip,
        maxFiles: this.#limits.maxFiles,
        budgetMs: this.#limits.budgetMs,
      });
      const deadline = Date.now() + this.#limits.budgetMs;
      const recorded = this.#store.recordedPaths(route.sessionId, route.turn);
      let made = false;
      for (const [path, sig] of before.files) {
        if (recorded.has(path)) continue;
        const prev = stage.files.get(path);
        // Başka komut sürerken var olan kopya ezilmez: o komutun değiştirdiği ara hâl tur öncesi
        // içeriğin yerine geçmesin. Komut yokken değişmiş dosya yeniden kopyalanır.
        if (prev && (sameSig(prev.sig, sig) || stage.inflight > 1)) continue;
        if (sig.size > MAX_SNAPSHOT_BYTES) continue;
        const extra = sig.size - (prev?.sig.size ?? 0);
        if (stage.bytes + extra > this.#limits.stageBytes || Date.now() > deadline) continue;
        const file = prev?.file ?? join(stage.dir, `${stage.seq++}.bin`);
        try {
          if (!made) await mkdir(stage.dir, { recursive: true });
          made = true;
          await copyFile(path, file, constants.COPYFILE_FICLONE);
          stage.files.set(path, { sig, file });
          stage.bytes += extra;
        } catch {
          // Kopyalanamayan dosya değişirse "yedeklenemedi" olarak bildirilir.
        }
      }
      this.#pending.set(callId, { route, cwd, skip, before, stage });
    } catch {
      stage.inflight -= 1;
    }
  }

  /**
   * Komut bittikten sonra: fark ölçülür ve tur yedeğine yazılır. Değişen dosyalar (araç kartı ve
   * tur dosya listesi için) döner. Komut hata koduyla bitse de çağrılmalıdır: dosyalar yine
   * değişmiş olabilir.
   */
  async finish(callId: string): Promise<FileChange[]> {
    const pending = this.#pending.get(callId);
    if (!pending) return [];
    this.#pending.delete(callId);
    const { route, cwd, before, stage } = pending;
    try {
      const after = await scanTree(cwd, {
        skip: pending.skip,
        maxFiles: this.#limits.maxFiles,
        budgetMs: this.#limits.budgetMs,
      });
      const diff = await diffScans(before, after);
      let partial = before.partial || after.partial || diff.partial;
      let changes: FileChange[] = [
        ...diff.modified.map((path): FileChange => ({ path, kind: "edit" })),
        ...diff.deleted.map((path): FileChange => ({ path, kind: "delete" })),
        ...diff.created.map((path): FileChange => ({ path, kind: "create" })),
      ];
      if (changes.length > this.#limits.maxChanges) {
        changes = changes.slice(0, this.#limits.maxChanges);
        partial = true;
      }
      const root = resolve(cwd);
      const items: BatchItem[] = [];
      for (const change of changes) {
        if (change.kind === "create") {
          items.push({ path: change.path, kind: "created" });
          continue;
        }
        const hash = before.blobs.get(change.path);
        if (hash) {
          const data = await readBlob(root, before.prefix, change.path, hash);
          items.push(
            data && data.length <= MAX_SNAPSHOT_BYTES
              ? { path: change.path, kind: "content", data }
              : { path: change.path, kind: "skipped" },
          );
          continue;
        }
        const staged = stage.files.get(change.path);
        items.push(
          staged
            ? { path: change.path, kind: "content", file: staged.file }
            : { path: change.path, kind: "skipped" },
        );
      }
      if (items.length > 0 || partial) {
        this.#store.recordBatch(route.sessionId, route.turn, items, partial);
      }
      return changes;
    } catch {
      return [];
    } finally {
      stage.inflight -= 1;
    }
  }

  /** Sonucu hiç gelmeyen komut (tur kesildi): bekleyen ölçüm bırakılır. */
  drop(callId: string): void {
    const pending = this.#pending.get(callId);
    if (!pending) return;
    this.#pending.delete(callId);
    pending.stage.inflight -= 1;
  }

  /** Oturum kapandı/silindi: kopyalar ve bekleyen ölçümler bırakılır. */
  forgetSession(sessionId: string): void {
    for (const [callId, pending] of this.#pending) {
      if (pending.route.sessionId === sessionId) this.#pending.delete(callId);
    }
    for (const [key, stage] of this.#stages) {
      if (stage.route.sessionId !== sessionId) continue;
      removeQuietly(stage.dir, { recursive: true });
      this.#stages.delete(key);
    }
  }
}
