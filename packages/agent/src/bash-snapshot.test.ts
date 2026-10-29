import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashCheckpoints, diffScans, scanTree } from "./bash-snapshot.js";
import { SnapshotStore } from "./snapshots.js";

const roots: string[] = [];
function tmp(prefix = "codezal-bash-snap-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@codezal.dev");
  git(dir, "config", "user.name", "Codezal Test");
  git(dir, "config", "core.autocrlf", "false");
}

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Dosyayı bir saat önce oluşmuş gösterir: macOS'ta değiştirme zamanı oluşma zamanından eskiye
 * çekilince oluşma zamanı da geri gider. `mv` oluşma zamanını koruduğu için yeniden adlandırılan
 * dosya "komuttan önce vardı" görünür; testler bu durumu kurar.
 */
function makeOld(path: string): void {
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path, old, old);
}

/** Yeniden adlandırma sonrası: eski ad silindi, yeni ad oluştu ve yedek tam. */
function expectRename(changes: { path: string; kind: string }[], from: string, to: string): void {
  const byPath = new Map(changes.map((c) => [c.path, c.kind]));
  expect(byPath.get(from)).toBe("delete");
  expect(byPath.get(to)).toBe("create");
}

describe("BashCheckpoints (git dışı klasör)", () => {
  it("komutun oluşturduğu/değiştirdiği/sildiği dosyalar tur geri alınınca eski hâline döner", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);
    writeFileSync(join(work, "a.txt"), "eski a");
    writeFileSync(join(work, "b.txt"), "eski b");
    mkdirSync(join(work, "alt"));
    writeFileSync(join(work, "alt", "c.txt"), "eski c");
    // Ağır klasör taranmaz: içindeki değişiklik kayda girmez.
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "node_modules", "dep.js"), "x");

    await checkpoints.begin("c1", { sessionId: "s1", turn: 2 }, work);
    // "Komut": değiştir, sil, oluştur (yeni klasörde de).
    writeFileSync(join(work, "a.txt"), "yeni a — daha uzun içerik");
    unlinkSync(join(work, "b.txt"));
    writeFileSync(join(work, "alt", "c.txt"), "yeni c!!");
    mkdirSync(join(work, "yeni"));
    writeFileSync(join(work, "yeni", "d.txt"), "oluştu");
    writeFileSync(join(work, "node_modules", "dep.js"), "değişti");
    const changes = await checkpoints.finish("c1");

    const byPath = new Map(changes.map((c) => [c.path, c.kind]));
    expect(byPath.get(join(work, "a.txt"))).toBe("edit");
    expect(byPath.get(join(work, "b.txt"))).toBe("delete");
    expect(byPath.get(join(work, "alt", "c.txt"))).toBe("edit");
    expect(byPath.get(join(work, "yeni", "d.txt"))).toBe("create");
    expect(byPath.has(join(work, "node_modules", "dep.js"))).toBe(false);

    const result = store.restore("s1", 2);
    expect(result.partial).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(read(join(work, "a.txt"))).toBe("eski a");
    expect(read(join(work, "b.txt"))).toBe("eski b");
    expect(read(join(work, "alt", "c.txt"))).toBe("eski c");
    expect(existsSync(join(work, "yeni", "d.txt"))).toBe(false);
  });

  it("aynı turda ikinci komut ilk hâli ezmez; yazma aracının yedeği de korunur", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);
    const a = join(work, "a.txt");
    const b = join(work, "b.txt");
    writeFileSync(a, "ilk");
    writeFileSync(b, "b ilk");
    // `edit` aracı önce b'yi yedekler ve değiştirir.
    store.record("s1", 1, b);
    writeFileSync(b, "b araçla değişti");

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    writeFileSync(a, "ikinci hâl");
    writeFileSync(b, "b komutla değişti");
    await checkpoints.finish("c1");
    await checkpoints.begin("c2", { sessionId: "s1", turn: 1 }, work);
    writeFileSync(a, "üçüncü hâl, daha uzun");
    await checkpoints.finish("c2");

    store.restore("s1", 1);
    expect(read(a)).toBe("ilk");
    expect(read(b)).toBe("b ilk");
  });

  it("taranan dosya sınırı aşılınca yedek eksik işaretlenir ve yeni dosya silinmek üzere kaydedilmez", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store, { maxFiles: 5 });
    for (let i = 0; i < 20; i += 1) writeFileSync(join(work, `f${i}.txt`), `dosya ${i}`);

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    writeFileSync(join(work, "yeni.txt"), "komut oluşturdu");
    const changes = await checkpoints.finish("c1");
    expect(changes.some((c) => c.kind === "create")).toBe(false);

    expect(store.has("s1", 1)).toBe(true);
    const result = store.restore("s1", 1);
    expect(result.partial).toBe(true);
    // Liste eksikken "yeni" ile "taranmamış eski" ayırt edilemez: dosya yerinde kalır.
    expect(existsSync(join(work, "yeni.txt"))).toBe(true);
    for (let i = 0; i < 20; i += 1) expect(read(join(work, `f${i}.txt`))).toBe(`dosya ${i}`);
  });

  it("kopyalama bütçesini aşan dosya değişirse 'yedeklenemedi' olarak bildirilir", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store, { stageBytes: 4 });
    const big = join(work, "buyuk.txt");
    writeFileSync(big, "bütçeden büyük içerik");

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    writeFileSync(big, "değişti");
    await checkpoints.finish("c1");

    const result = store.restore("s1", 1);
    expect(result.skipped).toEqual([big]);
    expect(result.restored).toEqual([]);
  });

  it("değişiklik sınırı aşılınca kayıt kesilir ve yedek eksik işaretlenir", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store, { maxChanges: 2 });
    for (let i = 0; i < 5; i += 1) writeFileSync(join(work, `f${i}.txt`), "x");

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    for (let i = 0; i < 5; i += 1) writeFileSync(join(work, `f${i}.txt`), `değişti ${i}`);
    const changes = await checkpoints.finish("c1");
    expect(changes).toHaveLength(2);
    expect(store.restore("s1", 1).partial).toBe(true);
  });

  it("atlanan klasör (çıktı klasörü) taranmaz", async () => {
    const work = tmp();
    const outputs = join(work, "outputs");
    mkdirSync(outputs);
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work, [outputs]);
    writeFileSync(join(outputs, "rapor.pdf"), "pdf");
    expect(await checkpoints.finish("c1")).toEqual([]);
    expect(store.has("s1", 1)).toBe(false);
  });

  it("sonucu gelmeyen komut bırakılır; yeni turda eski turun kopyaları temizlenir", async () => {
    const work = tmp();
    const snapshots = join(tmp(), "snapshots");
    const store = new SnapshotStore(snapshots);
    const checkpoints = new BashCheckpoints(store);
    writeFileSync(join(work, "a.txt"), "a");

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    expect(existsSync(store.stageDir("s1", 1))).toBe(true);
    checkpoints.drop("c1");
    expect(await checkpoints.finish("c1")).toEqual([]);

    await checkpoints.begin("c2", { sessionId: "s1", turn: 2 }, work);
    expect(existsSync(store.stageDir("s1", 1))).toBe(false);
    await checkpoints.finish("c2");
    checkpoints.forgetSession("s1");
    expect(existsSync(store.stageDir("s1", 2))).toBe(false);
  });
});

describe("BashCheckpoints (git deposu)", () => {
  it("temiz izlenen dosya blob'dan, kirli ve izlenmeyen dosya kopyadan geri gelir", async () => {
    const repo = tmp("codezal-bash-git-");
    initRepo(repo);
    writeFileSync(join(repo, "temiz.txt"), "temiz ilk\n");
    writeFileSync(join(repo, "kirli.txt"), "kirli ilk\n");
    writeFileSync(join(repo, ".gitignore"), "yoksay/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "ilk");
    writeFileSync(join(repo, "kirli.txt"), "kirli commit'lenmemiş\n");
    writeFileSync(join(repo, "izsiz.txt"), "izlenmeyen\n");
    mkdirSync(join(repo, "yoksay"));
    writeFileSync(join(repo, "yoksay", "z.txt"), "yok sayılan");

    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);
    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, repo);
    // Temiz izlenen dosya kopyalanmaz: kaynağı index'teki blob.
    const staged = existsSync(store.stageDir("s1", 1)) ? readdirSync(store.stageDir("s1", 1)) : [];
    expect(staged).toHaveLength(2);

    writeFileSync(join(repo, "temiz.txt"), "komut değiştirdi\n");
    // `git add` sonrası dosya index'e göre yine temiz görünür; index nesnesi değiştiği için yakalanır.
    git(repo, "add", "temiz.txt");
    writeFileSync(join(repo, "kirli.txt"), "komut kirliyi de değiştirdi\n");
    unlinkSync(join(repo, "izsiz.txt"));
    writeFileSync(join(repo, "olustu.txt"), "yeni\n");
    writeFileSync(join(repo, "yoksay", "z.txt"), "değişti");
    const changes = await checkpoints.finish("c1");
    const byPath = new Map(changes.map((c) => [c.path, c.kind]));
    expect(byPath.get(join(repo, "temiz.txt"))).toBe("edit");
    expect(byPath.get(join(repo, "kirli.txt"))).toBe("edit");
    expect(byPath.get(join(repo, "izsiz.txt"))).toBe("delete");
    expect(byPath.get(join(repo, "olustu.txt"))).toBe("create");
    // `.gitignore`'daki dosya kapsam dışı.
    expect(byPath.has(join(repo, "yoksay", "z.txt"))).toBe(false);

    const result = store.restore("s1", 1);
    expect(result.skipped).toEqual([]);
    expect(read(join(repo, "temiz.txt"))).toBe("temiz ilk\n");
    expect(read(join(repo, "kirli.txt"))).toBe("kirli commit'lenmemiş\n");
    expect(read(join(repo, "izsiz.txt"))).toBe("izlenmeyen\n");
    expect(existsSync(join(repo, "olustu.txt"))).toBe(false);
  });

  it("alt klasörde çalışan komutun blob içeriği satır sonu dönüşümüyle okunur", async () => {
    const repo = tmp("codezal-bash-git-");
    initRepo(repo);
    mkdirSync(join(repo, "alt"));
    writeFileSync(join(repo, ".gitattributes"), "alt/*.txt text eol=crlf\n");
    writeFileSync(join(repo, "alt", "f.txt"), "a\nb\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "ilk");
    // Çalışma kopyası CRLF'li çıkış hâline getirilir (checkout'un yazacağı biçim).
    rmSync(join(repo, "alt", "f.txt"));
    git(repo, "checkout", "--", "alt/f.txt");
    const before = read(join(repo, "alt", "f.txt"));
    expect(before).toBe("a\r\nb\r\n");

    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);
    const cwd = join(repo, "alt");
    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, cwd);
    writeFileSync(join(cwd, "f.txt"), "değişti\n");
    await checkpoints.finish("c1");

    store.restore("s1", 1);
    expect(read(join(cwd, "f.txt"))).toBe(before);
  });
});

describe("BashCheckpoints (yeniden adlandırma)", () => {
  it("git dışı klasörde mv geri alınınca yalnız eski ad kalır", async () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);
    const from = join(work, "eski.txt");
    const to = join(work, "yeni.txt");
    writeFileSync(from, "içerik");
    makeOld(from);

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, work);
    renameSync(from, to);
    expectRename(await checkpoints.finish("c1"), from, to);

    const result = store.restore("s1", 1);
    expect(result.partial).toBe(false);
    expect(read(from)).toBe("içerik");
    expect(existsSync(to)).toBe(false);
  });

  it("git mv ve düz mv (temiz izlenen dosya) yedeği eksik saymaz, geri alınır", async () => {
    const repo = tmp();
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "a içerik\n");
    writeFileSync(join(repo, "b.txt"), "b içerik\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "ilk");
    makeOld(join(repo, "a.txt"));
    makeOld(join(repo, "b.txt"));
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, repo);
    git(repo, "mv", "a.txt", "a2.txt");
    renameSync(join(repo, "b.txt"), join(repo, "b2.txt"));
    const changes = await checkpoints.finish("c1");
    expectRename(changes, join(repo, "a.txt"), join(repo, "a2.txt"));
    expectRename(changes, join(repo, "b.txt"), join(repo, "b2.txt"));

    const result = store.restore("s1", 1);
    expect(result.partial).toBe(false);
    expect(read(join(repo, "a.txt"))).toBe("a içerik\n");
    expect(read(join(repo, "b.txt"))).toBe("b içerik\n");
    expect(existsSync(join(repo, "a2.txt"))).toBe(false);
    expect(existsSync(join(repo, "b2.txt"))).toBe(false);
  });

  it("önceden var olan ama yeniden adlandırma olmayan dosya silinmek üzere kaydedilmez", async () => {
    const repo = tmp();
    initRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "gizli.txt\n");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "ilk");
    writeFileSync(join(repo, "gizli.txt"), "kullanıcının\n");
    makeOld(join(repo, "gizli.txt"));
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const checkpoints = new BashCheckpoints(store);

    await checkpoints.begin("c1", { sessionId: "s1", turn: 1 }, repo);
    git(repo, "add", "-f", "gizli.txt");
    const changes = await checkpoints.finish("c1");
    expect(changes.some((c) => c.kind === "create")).toBe(false);
    store.restore("s1", 1);
    expect(existsSync(join(repo, "gizli.txt"))).toBe(true);
  });
});

describe("diffScans", () => {
  it("farklı yolla alınmış iki tarama arasında oluşan dosya sayılmaz", async () => {
    const work = tmp();
    writeFileSync(join(work, "a.txt"), "a");
    const before = await scanTree(work);
    writeFileSync(join(work, "b.txt"), "b");
    const after = { ...(await scanTree(work)), mode: "git" as const };
    const diff = await diffScans(before, after);
    expect(diff.created).toEqual([]);
    expect(diff.partial).toBe(true);
  });
});
