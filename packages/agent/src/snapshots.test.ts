import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshots.js";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-snap-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("SnapshotStore", () => {
  it("düzenlenen dosyayı tur öncesine, oluşturulanı yokluğa döndürür", () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const edited = join(work, "a.txt");
    const created = join(work, "yeni", "b.txt");
    writeFileSync(edited, "eski");

    // Araç çalışmadan önce kayıt: biri var olan dosya, biri henüz yok.
    store.record("s1", 3, edited);
    store.record("s1", 3, created);
    writeFileSync(edited, "yeni içerik");
    mkdirSync(join(work, "yeni"), { recursive: true });
    writeFileSync(created, "oluşturuldu");

    expect(store.has("s1", 3)).toBe(true);
    expect(store.has("s1", 4)).toBe(false);
    const r = store.restore("s1", 3);
    expect(r.restored).toEqual([edited]);
    expect(r.removed).toEqual([created]);
    expect(readFileSync(edited, "utf8")).toBe("eski");
    expect(existsSync(created)).toBe(false);
  });

  it("aynı turda aynı dosyaya ikinci dokunuş ilk hâli korur", () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const file = join(work, "a.txt");
    writeFileSync(file, "1");
    store.record("s1", 1, file);
    writeFileSync(file, "2");
    store.record("s1", 1, file);
    writeFileSync(file, "3");
    store.restore("s1", 1);
    expect(readFileSync(file, "utf8")).toBe("1");
  });

  it("yedek yoksa boş sonuç döner; clear oturumun yedeklerini siler", () => {
    const work = tmp();
    const root = join(tmp(), "snapshots");
    const store = new SnapshotStore(root);
    expect(store.restore("yok", 1)).toEqual({
      restored: [],
      removed: [],
      skipped: [],
      partial: false,
    });
    const file = join(work, "a.txt");
    writeFileSync(file, "x");
    store.record("s2", 1, file);
    expect(store.has("s2", 1)).toBe(true);
    store.clear("s2");
    expect(store.has("s2", 1)).toBe(false);
  });

  it("changedSince görev başladıktan sonra değişen dosyaları döner", () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const old = join(work, "eski.txt");
    const fresh = join(work, "yeni.txt");
    const removed = join(work, "silinen.txt");
    const created = join(work, "olusan.txt");
    for (const f of [old, fresh, removed]) writeFileSync(f, "x");
    store.record("s1", 1, old);
    store.record("s1", 1, fresh);
    store.record("s1", 1, removed);
    store.record("s1", 1, created);
    // Görev başlamadan önceki damga "değişmedi" sayılır; sonrakiler değişikliktir.
    utimesSync(old, new Date(1000), new Date(1000));
    utimesSync(fresh, new Date(3000), new Date(3000));
    unlinkSync(removed);
    writeFileSync(created, "y");
    utimesSync(created, new Date(4000), new Date(4000));
    expect(store.changedSince("s1", 2000).sort()).toEqual([created, fresh].sort());
    // Yedek klasörü hiç olmayan oturum boş döner.
    expect(store.changedSince("s2", 0)).toEqual([]);
  });

  it("restore `except` içindeki yollara dokunmaz (git geri alması onları döndürdü)", () => {
    const work = tmp();
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    const a = join(work, "a.txt");
    const b = join(work, "b.txt");
    writeFileSync(a, "a eski");
    writeFileSync(b, "b eski");
    store.record("s1", 1, a);
    store.record("s1", 1, b);
    writeFileSync(a, "a yeni");
    writeFileSync(b, "b yeni");

    const result = store.restore("s1", 1, new Set([a]));
    expect(result.restored).toEqual([b]);
    expect(readFileSync(a, "utf8")).toBe("a yeni");
    expect(readFileSync(b, "utf8")).toBe("b eski");
  });

  it("yalnız 'eksik' işaretli tur yedeği var sayılır ve geri almada bildirilir", () => {
    const store = new SnapshotStore(join(tmp(), "snapshots"));
    expect(store.recordBatch("s1", 1, [], true)).toEqual([]);
    expect(store.has("s1", 1)).toBe(true);
    expect(store.restore("s1", 1)).toEqual({
      restored: [],
      removed: [],
      skipped: [],
      partial: true,
    });
  });
});
