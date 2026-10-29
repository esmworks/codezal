import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SESSION_MARKS, SessionMetaStore } from "./session-meta.js";

const dirs: string[] = [];
function store(): { store: SessionMetaStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "codezal-meta-"));
  dirs.push(dir);
  const path = join(dir, "meta.json");
  return { store: new SessionMetaStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionMetaStore kaldırılan mod göçü", () => {
  it("eski design kaydını kodlama'ya kırpar ve arşive alır, diğer kayıtlar bozulmaz", () => {
    const { store: first, path } = store();
    first.set("s1", { mode: "kodlama", pinned: true });
    // Modül kaldırılmadan önce yazılmış kayıt: tanınmayan mod + bütün dosyayı düşüren risk.
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      sessions: Record<string, Record<string, unknown>>;
    };
    raw.sessions.s2 = { mode: "design", pinned: false, archived: false, marks: [] };
    writeFileSync(path, JSON.stringify(raw));

    const reopened = new SessionMetaStore(path);
    expect(reopened.get("s2").mode).toBe("kodlama");
    expect(reopened.get("s2").archived).toBe(true);
    // Göç kalıcı: yeni örnekte kayıt artık kodlama + arşiv olarak okunur.
    expect(new SessionMetaStore(path).get("s2").archived).toBe(true);
    expect(reopened.get("s1").mode).toBe("kodlama");
    expect(reopened.get("s1").pinned).toBe(true);
  });

  it("tanınmayan mod tek kaydı düşürmez, yalnız o kaydın modunu kırpar", () => {
    const { store: first, path } = store();
    first.set("s1", { mode: "asistan" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      sessions: Record<string, Record<string, unknown>>;
    };
    raw.sessions.s2 = { mode: "bilinmeyen", pinned: true, archived: false, marks: [] };
    writeFileSync(path, JSON.stringify(raw));

    const reopened = new SessionMetaStore(path);
    expect(reopened.get("s1").mode).toBe("asistan");
    // Bilinmeyen mod kodlama'ya kırpılır ama arşive alınmaz; kullanıcı oturumu kaybolmaz.
    expect(reopened.get("s2").mode).toBe("kodlama");
    expect(reopened.get("s2").archived).toBe(false);
    expect(reopened.get("s2").pinned).toBe(true);
  });
});

describe("SessionMetaStore işaretleri", () => {
  it("işaretleri eskiden yeniye ekler, sınırı aşınca en eskileri düşürür", () => {
    const { store: meta } = store();
    const total = MAX_SESSION_MARKS + 5;
    for (let i = 0; i < total; i += 1) {
      meta.mark("s1", { id: `mk-${i}`, kind: "compact", at: i, outcome: "done" });
    }
    const marks = meta.get("s1").marks;
    expect(marks).toHaveLength(MAX_SESSION_MARKS);
    // Kırpma baştan olur: yeni işaret her zaman görünür kalır.
    expect(marks[0]?.id).toBe(`mk-${total - MAX_SESSION_MARKS}`);
    expect(marks.at(-1)?.id).toBe(`mk-${total - 1}`);
  });

  it("işaret eklemek oturumun öteki alanlarını silmez", () => {
    const { store: meta } = store();
    meta.set("s1", { thinking: "max", permission: "plan" });
    meta.mark("s1", { id: "mk-1", kind: "thinking", from: "low", to: "max", at: 5 });
    expect(meta.get("s1")).toMatchObject({ thinking: "max", permission: "plan" });
    expect(meta.get("s1").marks).toHaveLength(1);
  });

  it("işaretsiz eski meta dosyası okunur (alan yoksa boş liste)", () => {
    const { store: meta, path } = store();
    meta.set("s1", { thinking: "high" });
    // Eski sürümün yazdığı dosya: `marks` alanı hiç yok.
    writeFileSync(path, JSON.stringify({ sessions: { s1: { thinking: "high" } } }));
    const reopened = new SessionMetaStore(path);
    expect(reopened.get("s1").marks).toEqual([]);
    reopened.mark("s1", { id: "mk-1", kind: "model", to: "acme/a", at: 1 });
    expect(reopened.get("s1").marks.map((m) => m.id)).toEqual(["mk-1"]);
  });
});

describe("SessionMetaStore atomik yazım", () => {
  /**
   * Düz `writeFileSync` dosyayı yerinde kırpıp yeniden yazıyordu; arada çökme ya da okuma yarım
   * JSON görüyor ve bütün oturum meta'sı kayboluyordu. Atomik yazım yeni dosyayı yerine taşır:
   * dosya kimliği (inode) değişir, geride `.tmp` kalmaz.
   */
  it("meta.json yerinde kırpılmaz, geçici dosyadan taşınarak değişir", () => {
    const { store: s, path } = store();
    s.set("s1", { mode: "kodlama" });
    const before = statSync(path).ino;
    s.set("s1", { pinned: true });
    expect(statSync(path).ino).not.toBe(before);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(new SessionMetaStore(path).get("s1").pinned).toBe(true);
  });
});
