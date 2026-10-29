import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { removeQuietly, slugify } from "@codezal/agent";
import type {
  FileBadge,
  GitBranch,
  GitFileChange,
  GitStatus,
  WorktreeInfo,
} from "@codezal/contracts";
import { type SimpleGit, simpleGit } from "simple-git";
import { i18n } from "./i18n.js";

/**
 * simple-git, komutu çalıştırmadan önce ortamı denetler ve editör/sayfalayıcı değişkenlerini
 * görürse "allowUnsafeEditor" isteyerek reddeder (`@simple-git/argv-parser` güvenlik listesi).
 * Codezal git için editör açmaz; bu yüzden bu değişkenler git sürecine hiç verilmez. `GIT_*`
 * zaten verilmez: hata tespiti İngilizce çıktıya bakar, yerelleştirilmiş git (TR) yanlış sonuç
 * verirdi, ayrıca SSH ajanı gibi gereken değişkenler korunur.
 */
const UNSAFE_ENV = new Set([
  "EDITOR",
  "PAGER",
  "PREFIX",
  "SSH_ASKPASS",
  "GIT_EDITOR",
  "GIT_PAGER",
  "GIT_SEQUENCE_EDITOR",
]);

function open(cwd: string): SimpleGit {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    if (UNSAFE_ENV.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return simpleGit({ baseDir: cwd, maxConcurrentProcesses: 2 }).env({
    ...env,
    LC_ALL: "C",
    LANG: "C",
  });
}

const EMPTY: GitStatus = {
  isRepo: false,
  branch: "",
  ahead: 0,
  behind: 0,
  hasRemote: false,
  files: [],
  additions: 0,
  deletions: 0,
};

function badgeOf(index: string, working: string): FileBadge {
  const code = working !== " " && working !== "" ? working : index;
  if (code === "?" || code === "A") return code === "?" ? "?" : "A";
  if (code === "D") return "D";
  return "M";
}

async function numstat(git: SimpleGit, args: string[]): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>();
  let raw = "";
  try {
    raw = await git.raw(["diff", "--numstat", ...args]);
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    out.set(path, [Number(a) || 0, Number(d) || 0]);
  }
  return out;
}

/**
 * İzlenmeyen dosyanın satır sayısı. `git diff --no-index /dev/null <dosya>` Git for Windows'ta
 * her zaman çalışmaz; o hâlde satırları burada sayarız (ikili/çok büyük dosyada 0).
 */
function countLines(path: string): number {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return 0;
    const text = readFileSync(path, "utf8");
    if (text.length === 0 || text.includes("\u0000")) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

/** Çalışma ağacı durumu: dosyalar, +/- sayımı, dal, ahead/behind (TODO 2). */
export async function status(cwd: string): Promise<GitStatus> {
  if (!existsSync(cwd)) return EMPTY;
  const git = open(cwd);
  if (!(await git.checkIsRepo())) return EMPTY;
  const st = await git.status();
  const [staged, unstaged] = await Promise.all([numstat(git, ["--cached"]), numstat(git, [])]);
  // Yeniden adlandırma `files` içinde yeni yolun değişikliği olarak gelir; kimliği `renamed`ten
  // okunur ki liste "R eski → yeni" gösterebilsin (ZCode/GitHub aynı bilgiyi taşır).
  const renames = new Map(st.renamed.map((r) => [r.to, r.from]));
  const files: GitFileChange[] = [];
  for (const f of st.files) {
    const isStaged = f.index !== " " && f.index !== "?" && f.index !== "";
    const nums = unstaged.get(f.path) ?? staged.get(f.path) ?? [0, 0];
    let additions = nums[0];
    let deletions = nums[1];
    if (f.working_dir === "?" && additions === 0) {
      // İzlenmeyen dosya: satır sayısı numstat'ta yok, tahmini olarak dosyayı say.
      try {
        const n = await git
          .raw(["diff", "--numstat", "--no-index", "--", "/dev/null", f.path])
          .catch((e: { message?: string }) => e.message ?? "");
        const m = /^(\d+)\t/.exec(n.trim());
        // `f.path` depo köküne göre; süreç cwd'sine göre değil, çalışma klasörüyle birleştirilir.
        additions = m?.[1] ? Number(m[1]) : countLines(join(cwd, f.path));
      } catch {
        additions = 0;
      }
      deletions = 0;
    }
    const from = renames.get(f.path) ?? null;
    files.push({
      path: f.path,
      status: from ? "R" : badgeOf(f.index, f.working_dir),
      renamedFrom: from,
      staged: isStaged,
      additions,
      deletions,
    });
  }
  let hasRemote = false;
  try {
    hasRemote = (await git.getRemotes()).length > 0;
  } catch {
    hasRemote = false;
  }
  return {
    isRepo: true,
    branch: st.current ?? "",
    ahead: st.ahead,
    behind: st.behind,
    hasRemote,
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
  };
}

export async function badges(cwd: string): Promise<Map<string, FileBadge>> {
  const map = new Map<string, FileBadge>();
  try {
    const st = await status(cwd);
    for (const f of st.files) map.set(f.path, f.status);
  } catch {
    // git yoksa rozet yok
  }
  return map;
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const git = open(cwd);
  if (!(await git.checkIsRepo())) return [];
  const b = await git.branchLocal();
  return b.all.map((name) => ({ name, current: name === b.current }));
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  await open(cwd).checkout(branch);
}

/**
 * Değişiklikleri geri alır (dosya verilirse yalnız onu). `git restore --staged --worktree`
 * kullanılır: `checkout -- <yol>` index'e eklenmiş (staged) bir dosyada "did not match" ile
 * düşüyor, `clean` de yalnız izlenmeyenleri siliyordu — kullanıcı ↺'ye basıp onaylıyor, dosya
 * olduğu gibi kalıyordu. İzlenmeyen dosya için `clean` yedek olarak durur.
 */
export async function discard(cwd: string, path?: string): Promise<void> {
  const git = open(cwd);
  if (path) {
    await git.raw(["restore", "--staged", "--worktree", "--", path]).catch(async () => {
      // HEAD'i olmayan depoda (ilk commit öncesi) restore düşer; izlenmeyen dosya `clean` ile gider.
      await git.raw(["clean", "-f", "--", path]);
    });
    await git.raw(["clean", "-f", "--", path]).catch(() => undefined);
    return;
  }
  await git.raw(["reset", "--hard"]);
  await git.raw(["clean", "-fd"]);
}

export async function commit(
  cwd: string,
  message: string,
  includeUnstaged: boolean,
): Promise<{ hash: string }> {
  const git = open(cwd);
  if (includeUnstaged) await git.add(["-A"]);
  const r = await git.commit(message);
  return { hash: r.commit };
}

export async function push(cwd: string): Promise<void> {
  const git = open(cwd);
  const st = await git.status();
  if (st.tracking) {
    await git.push();
    return;
  }
  const remotes = await git.getRemotes();
  const remote = remotes[0]?.name;
  if (!remote) throw new Error(i18n.t("errors.noRemote"));
  await git.push(["-u", remote, st.current ?? "HEAD"]);
}

export async function diff(cwd: string, path?: string): Promise<string> {
  const git = open(cwd);
  const args = ["diff", "HEAD", "--"];
  const out = await git.raw(path ? [...args, path] : args).catch(() => "");
  return out.slice(0, 200_000);
}

/** Commit mesajı önerisi için kısaltılmış diff özeti. */
export async function diffForSummary(cwd: string, includeUnstaged: boolean): Promise<string> {
  const git = open(cwd);
  const stat = await git
    .raw(["diff", includeUnstaged ? "HEAD" : "--cached", "--stat"])
    .catch(() => "");
  const body = await git.raw(["diff", includeUnstaged ? "HEAD" : "--cached"]).catch(() => "");
  const untracked = includeUnstaged
    ? await git.raw(["ls-files", "--others", "--exclude-standard"]).catch(() => "")
    : "";
  return `${stat}\n${untracked ? `${i18n.t("heuristic.newFiles")}\n${untracked}\n` : ""}\n${body.slice(0, 12_000)}`;
}

/** Ajan yoksa kullanılan sezgisel commit mesajı. */
export function heuristicMessage(st: GitStatus, format: "conventional" | "free" | "short"): string {
  const files = st.files;
  if (files.length === 0) return "";
  const names = files.map((f) => basename(f.path));
  const added = files.filter((f) => f.status === "A" || f.status === "?").length;
  const deleted = files.filter((f) => f.status === "D").length;
  const verb =
    added === files.length
      ? i18n.t("heuristic.verbAdd")
      : deleted === files.length
        ? i18n.t("heuristic.verbRemove")
        : i18n.t("heuristic.verbUpdate");
  const scope = files.length === 1 ? names[0] : i18n.t("heuristic.files", { count: files.length });
  // Türkçe "3 dosya ekle", İngilizce "Add 3 files" sıralamasıyla yazılır.
  const subject = i18n.language === "en" ? `${capitalize(verb)} ${scope}` : `${scope} ${verb}`;
  if (format === "short") return subject;
  const type = added === files.length ? "feat" : deleted === files.length ? "chore" : "fix";
  const head = format === "conventional" ? `${type}: ${subject}` : subject;
  const list = files
    .slice(0, 12)
    .map((f) => `- ${f.status} ${f.path}`)
    .join("\n");
  return `${head}\n\n${list}${files.length > 12 ? `\n- ${i18n.t("heuristic.moreFiles", { count: files.length - 12 })}` : ""}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

// ---------- worktree ----------

const ADJ = ["daring", "quiet", "brisk", "calm", "swift", "bold", "keen", "wise"];
const ANIMAL = ["yak", "otter", "heron", "lynx", "finch", "ibis", "koala", "gecko"];

function slug(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)] ?? "swift";
  const b = ANIMAL[Math.floor(Math.random() * ANIMAL.length)] ?? "fox";
  return `${a}-${b}`;
}

export async function worktrees(cwd: string): Promise<WorktreeInfo[]> {
  const git = open(cwd);
  if (!(await git.checkIsRepo())) return [];
  const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  const flush = () => {
    if (cur.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? "(detached)",
        name: basename(cur.path),
        isMain: out.length === 0,
        changedFiles: 0,
      });
    }
    cur = {};
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur.path = line.slice(9);
    } else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "") flush();
  }
  flush();
  for (const w of out) {
    try {
      const st = await open(w.path).status();
      w.changedFiles = st.files.length;
    } catch {
      w.changedFiles = 0;
    }
  }
  return out;
}

/** Worktree kökü: ayar boşsa deponun içindeki `.worktrees`. */
/**
 * Ajan koşusunun worktree/dal adı: `ajan-<başlık>-<kimlik kuyruğu>`, yalnız ASCII. Türkçe harf
 * sadeleştirilir (ı→i, ü→u…): git kabul etse de terminal, kabuk ve bazı araçlar Unicode dal
 * adında sorun çıkarıyordu. Kimlik kuyruğu aynı adlı iki koşunun aynı dalı istemesini önler.
 */
export function agentWorktreeName(title: string, id: string): string {
  const unique = slugify(id.replace(/[^a-z0-9]/gi, "").slice(-5), 5, "");
  const tail = unique || Date.now().toString(36).slice(-5);
  return ["ajan", slugify(title, 24, ""), tail].filter((part) => part !== "").join("-");
}

export function worktreeBase(cwd: string, root: string | undefined): string {
  return root?.trim() ? resolve(root) : join(cwd, ".worktrees");
}

/**
 * Codezal'ın açtığı worktree mi: varsayılan `.worktrees` altında ya da ayardaki kökün hemen
 * altında. Kullanıcının kendi açtığı worktree'lerin dalına dokunulmaz.
 */
export function isManagedWorktree(path: string, root: string | undefined): boolean {
  const parent = dirname(resolve(path));
  if (basename(parent) === ".worktrees") return true;
  const custom = root?.trim();
  return custom ? real(parent) === real(resolve(custom)) : false;
}

/** Sembolik bağlar çözülmüş yol (macOS'ta `/tmp` → `/private/tmp`); yol yoksa olduğu gibi. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Depo içindeki worktree kökünü yerel dışlama listesine (`info/exclude`) yazar. Yazılmazsa kök ana
 * depoda izlenmeyen klasör görünür ve "tümünü ekle" commit'i worktree'yi gömülü depo (gitlink)
 * olarak içeri alır. Kullanıcının `.gitignore`'una dokunulmaz; kök depo dışındaysa iş yok.
 */
async function excludeWorktreeRoot(git: SimpleGit, cwd: string, base: string): Promise<void> {
  const top = real((await git.revparse(["--show-toplevel"])).trim());
  const rel = relative(top, real(base));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  const file = resolve(cwd, (await git.revparse(["--git-path", "info/exclude"])).trim());
  const pattern = `/${rel.split(sep).join("/")}/`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  const glue = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${glue}${pattern}\n`);
}

/**
 * Dal ya da klasör adı doluysa sonuna sayı ekler. Silinen worktree'nin birleştirilmemiş dalı
 * kalabilir; aynı ad yeniden seçilince `worktree add -b` "dal zaten var" diye düşmesin.
 */
async function freeWorktreeName(git: SimpleGit, base: string, name: string): Promise<string> {
  const branches = new Set((await git.branchLocal()).all);
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? name : `${name}-${i}`;
    if (!branches.has(candidate) && !existsSync(join(base, candidate))) return candidate;
  }
  return `${name}-${Date.now().toString(36)}`;
}

export async function createWorktree(
  cwd: string,
  root: string | undefined,
  name?: string,
): Promise<WorktreeInfo> {
  const git = open(cwd);
  if (!(await git.checkIsRepo())) throw new Error(i18n.t("changes.notRepo"));
  const base = worktreeBase(cwd, root);
  mkdirSync(base, { recursive: true });
  // Dışlama yazılamasa da worktree açılır; en kötü ihtimalle kök izlenmeyen klasör görünür.
  await excludeWorktreeRoot(git, cwd, base).catch(() => undefined);
  const wtName = await freeWorktreeName(git, base, name?.trim() || `cz-${slug()}`);
  const path = join(base, wtName);
  await git.raw(["worktree", "add", "-b", wtName, path]);
  return {
    path,
    branch: wtName,
    name: wtName,
    isMain: false,
    changedFiles: 0,
    createdAt: Date.now(),
  };
}

/**
 * Worktree'yi kaldırır. `deleteBranch` yalnız Codezal'ın açtığı worktree'ler içindir ve `-d` ile
 * siler: birleştirilmemiş commit'i olan dal kalır, iş kaybolmaz.
 */
export async function removeWorktree(
  cwd: string,
  path: string,
  options: { deleteBranch?: boolean } = {},
): Promise<void> {
  const git = open(cwd);
  // Dal adı klasör silinmeden okunur; sonrasında bulunamaz.
  const branch = options.deleteBranch ? await branchOf(path) : undefined;
  await git.raw(["worktree", "remove", "--force", path]).catch(() => {
    if (existsSync(path)) removeQuietly(path, { recursive: true });
  });
  await git.raw(["worktree", "prune"]).catch(() => undefined);
  if (branch) await git.raw(["branch", "-d", branch]).catch(() => undefined);
}

/** Worktree'de açık dal; klasör yoksa ya da HEAD ayrıksa yok. */
async function branchOf(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const name = await open(path)
    .revparse(["--abbrev-ref", "HEAD"])
    .then(
      (out) => out.trim(),
      () => "",
    );
  return name === "" || name === "HEAD" ? undefined : name;
}

/**
 * "Bitince temizle": oturumu silinen worktree'yi kaldırır, ama yalnız kaybolacak iş yoksa —
 * commit'lenmemiş değişiklik yok ve dal ana depoya birleştirilmiş. Aksi hâlde worktree yerinde
 * kalır ve Ayarlar > Worktree'de görünür. Kaldırıldıysa true.
 */
export async function cleanupWorktree(path: string, root: string | undefined): Promise<boolean> {
  if (!existsSync(path) || !isManagedWorktree(path, root)) return false;
  const wt = open(path);
  try {
    const list = await wt.raw(["worktree", "list", "--porcelain"]);
    const main = list
      .split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (!main || real(main) === real(path)) return false;
    if (!(await wt.status()).isClean()) return false;
    const branch = await branchOf(path);
    if (!branch) return false;
    const merged = await open(main).raw(["branch", "--merged", "HEAD", "--list", branch]);
    if (merged.trim() === "") return false;
    await removeWorktree(main, path, { deleteBranch: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Worker'ın worktree'sinde değiştirdiği dosyalar (depo-göreli). Bitiş özetinde ve `review`
 * satırında gösterilir; worktree yoksa boş liste döner (koşu sonucu bu yüzden kaybolmaz).
 */
export async function worktreeChangedFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    const status = await open(path).status();
    return status.files.map((f) => f.path);
  } catch {
    return [];
  }
}

/**
 * Worker'ın worktree'sindeki değişikliklerin diff'i (F10). İzlenmeyen (yeni) dosyalar da
 * görünsün diye önce niyet kaydı yazılır; commit yapılmaz, izin çalışma ağacı değişmez.
 */
export async function worktreeDiff(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  const git = open(path);
  await git.raw(["add", "--intent-to-add", "--", "."]).catch(() => undefined);
  try {
    return await git.diff(["HEAD"]);
  } catch {
    // HEAD yoksa (boş depo) çalışma ağacı farkı yeter.
    return git.diff().catch(() => "");
  }
}

/**
 * Worker dalını ana dala uygular (F10). Değişiklikler önce worker dalına commit'lenir; commit yoksa
 * merge boş geçerdi. Çakışmada birleştirme geri alınır ve hata çağırana döner: ana depo MERGING
 * durumunda, dosyalarında çakışma işaretleriyle kalmaz; worker dalı ve worktree korunur.
 */
export async function applyWorktree(cwd: string, path: string): Promise<void> {
  const worker = open(path);
  const branch = (await worker.branchLocal()).current;
  const status = await worker.status();
  if (status.files.length > 0) {
    await worker.add(["-A"]);
    await worker.commit(`Codezal ajan: ${branch}`);
  }
  const main = open(cwd);
  try {
    await main.merge(["--no-edit", branch]);
  } catch (e) {
    const merging = await main.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      (out) => out.trim() !== "",
      () => false,
    );
    if (!merging) throw e;
    await main.raw(["merge", "--abort"]).catch(() => undefined);
    throw new Error(i18n.t("changes.mergeConflict", { branch }));
  }
}

/**
 * Deponun kök commit'i: klasör taşınsa ya da yeniden adlansa da değişmeyen proje parmak izi.
 * Depo değilse ya da commit yoksa yok; birden çok kök varsa sıralı ilki (kararlı olsun diye).
 */
export async function rootCommit(cwd: string): Promise<string | undefined> {
  try {
    const git = open(cwd);
    if (!(await git.checkIsRepo())) return undefined;
    const raw = await git.raw(["rev-list", "--max-parents=0", "HEAD"]);
    const roots = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    return roots[0];
  } catch {
    return undefined;
  }
}

// ---------- tur kaydı (geri alma) ----------

/**
 * Tur kaydı git çağrıları tek yerden geçer:
 * - `--literal-pathspecs`: `restore`/`rm` dosya adını desen sanmasın (`a[1].txt` `a1.txt`'yi de
 *   eşleyip kullanıcının değişikliğini ezerdi);
 * - listeler `-z` ile alınır (`nulList`): `core.quotePath` Türkçe adları `"\303..."` diye tırnaklar,
 *   satır kırpma da başı/sonu boşluklu adı başka dosyaya çevirirdi;
 * - farklar `--no-renames` ile alınır: yeniden adlandırmada yalnız yeni ad listelenir, eski dosya
 *   hiç geri getirilmezdi.
 * Yollar `cwd`'ye göredir ve `cwd` ile sınırlıdır (`--relative`; `ls-files` zaten öyle): oturum
 * deponun alt klasöründeyse `restore`/`rm` de yolu `cwd`'ye göre yorumlar.
 */
function turnGit(cwd: string, args: string[]): Promise<string> {
  return open(cwd).raw(["--literal-pathspecs", ...args]);
}

/** `-z` çıktısı: NUL ayraçlı yollar; kırpma yok (boşluklu adlar korunur). */
function nulList(out: string): string[] {
  return out.split("\0").filter((path) => path.length > 0);
}

/**
 * Deponun kökü ve `cwd`'nin köke göre öneki (`alt/`; kökte boş). Alt klasör oturumunda tur
 * kaydı klasör dışındaki değişiklikleri ayrıca ölçer: geri alınmazlar ama kullanıcıya söylenir.
 */
export async function repoLocation(cwd: string): Promise<{ top: string; prefix: string }> {
  const top = (await turnGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const prefix = (await turnGit(cwd, ["rev-parse", "--show-prefix"])).replace(/\n$/, "");
  return { top, prefix };
}

/**
 * Tur öncesi ağaç kaydı: `git stash create` commit'i. Stash listesine EKLENMEZ (kullanıcının
 * stash'i bozulmaz); çalışma ağacı temizse boş döner → null.
 */
export async function snapshotTree(cwd: string): Promise<string | null> {
  const out = await open(cwd).raw(["stash", "create"]);
  const hash = out.trim();
  return hash.length > 0 ? hash : null;
}

/** Snapshot'tan bu yana değişen izlenen dosyalar (staged ve unstaged; untracked hariç). */
export async function changedSince(cwd: string, hash: string): Promise<string[]> {
  return nulList(
    await turnGit(cwd, ["diff", "--name-only", "-z", "--no-renames", "--relative", hash]),
  );
}

/** HEAD'e göre değişen izlenen dosyalar; tur kaydı alınamadığında (ağaç temizdi) referans. */
export async function changedFromHead(cwd: string): Promise<string[]> {
  const flags = ["--name-only", "-z", "--no-renames", "--relative"];
  const unstaged = nulList(await turnGit(cwd, ["diff", ...flags, "HEAD"]));
  const staged = nulList(await turnGit(cwd, ["diff", "--cached", ...flags]));
  return [...new Set([...unstaged, ...staged])];
}

/** İzlenmeyen dosyalar (`.gitignore` dışı). */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  return nulList(await turnGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

/** Dosya kayıtta var mı; silinmişse ya da hiç yoksa false. `path` `cwd`'ye göredir (`./`). */
export async function existsInSnapshot(cwd: string, ref: string, path: string): Promise<boolean> {
  try {
    await turnGit(cwd, ["cat-file", "-e", `${ref}:./${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Dosyayı kayıt hâline döndürür (worktree + index birlikte). */
export async function restoreFromSnapshot(cwd: string, ref: string, path: string): Promise<void> {
  await turnGit(cwd, ["restore", "--source", ref, "--worktree", "--staged", "--", path]);
}

/** İzlenen ama çalışma ağacında olmayan dosyayı index'ten de düşürür (turda oluşturulmuştu). */
export async function unstageMissing(cwd: string, path: string): Promise<void> {
  await turnGit(cwd, ["rm", "--cached", "--force", "--", path]).catch(() => undefined);
}
