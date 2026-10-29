import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Kopyalama modülü yalnız çöp kutusu için Electron'a dokunur; gerisi saf dosya sistemidir.
const mocks = vi.hoisted(() => ({ trashItem: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({ shell: { trashItem: mocks.trashItem } }));

const { copyContext, freeTarget, inside, measure, trashContext } = await import(
  "./context-copy.js"
);

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cz-context-"));
  mocks.trashItem.mockClear();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("measure", () => {
  it("dosya boyutunu döner", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "12345");
    expect(await measure(file)).toBe(5);
  });

  it("klasör ağacını toplar", async () => {
    mkdirSync(join(root, "alt"));
    writeFileSync(join(root, "a.txt"), "123");
    writeFileSync(join(root, "alt", "b.txt"), "1234");
    expect(await measure(root)).toBe(7);
  });

  it("olmayan yolda sıfır döner", async () => {
    expect(await measure(join(root, "yok"))).toBe(0);
  });
});

describe("freeTarget", () => {
  it("boş klasörde kaynağın adını kullanır", async () => {
    expect(await freeTarget(root, "/a/rapor.pdf")).toBe(join(root, "rapor.pdf"));
  });

  it("dolu adda uzantıyı koruyup numaralar", async () => {
    writeFileSync(join(root, "rapor.pdf"), "x");
    expect(await freeTarget(root, "/a/rapor.pdf")).toBe(join(root, "rapor (2).pdf"));
    writeFileSync(join(root, "rapor (2).pdf"), "x");
    expect(await freeTarget(root, "/a/rapor.pdf")).toBe(join(root, "rapor (3).pdf"));
  });

  it("uzantısız adda sona numara ekler", async () => {
    mkdirSync(join(root, "arsiv"));
    expect(await freeTarget(root, "/a/arsiv")).toBe(join(root, "arsiv (2)"));
  });
});

describe("inside", () => {
  it("yalnız klasörün altındaki yolları içeride sayar", () => {
    expect(inside("/p/Bağlam", "/p/Bağlam/x.md")).toBe(true);
    expect(inside("/p/Bağlam", "/p/Bağlam/alt/x.md")).toBe(true);
    // Klasörün kendisi ve komşusu (Bağlam2) kopya yolu olamaz.
    expect(inside("/p/Bağlam", "/p/Bağlam")).toBe(false);
    expect(inside("/p/Bağlam", "/p/Bağlam2/x.md")).toBe(false);
    expect(inside("/p/Bağlam", "/p/Bağlam/../dış.md")).toBe(false);
    expect(inside("/p/Bağlam", "/başka/x.md")).toBe(false);
  });
});

describe("copyContext", () => {
  it("dosyayı bağlam klasörüne kopyalar ve hedef yolu döner", async () => {
    const src = join(root, "kaynak.md");
    writeFileSync(src, "içerik");
    const dest = join(root, "Baglam");
    const target = await copyContext(src, dest);
    expect(target).toBe(join(dest, "kaynak.md"));
    expect(readFileSync(target, "utf8")).toBe("içerik");
    // Kaynak yerinde kalır: kopyalama taşıma değildir.
    expect(readFileSync(src, "utf8")).toBe("içerik");
  });

  it("klasörü ağacıyla kopyalar", async () => {
    const src = join(root, "Projeler");
    mkdirSync(join(src, "alt"), { recursive: true });
    writeFileSync(join(src, "alt", "x.txt"), "x");
    const target = await copyContext(src, join(root, "Baglam"));
    expect(readFileSync(join(target, "alt", "x.txt"), "utf8")).toBe("x");
  });

  it("yenilemede aynı yolu korur, geçici dosya bırakmaz", async () => {
    const dest = join(root, "Baglam");
    const src = join(root, "kaynak.md");
    writeFileSync(src, "eski");
    const target = await copyContext(src, dest);
    writeFileSync(src, "yeni");
    const again = await copyContext(src, dest, target);
    expect(again).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("yeni");
    expect(readdirSync(dest)).toEqual(["kaynak.md"]);
  });

  it("kaynak okunamıyorsa eski kopya yerinde kalır", async () => {
    const dest = join(root, "Baglam");
    const src = join(root, "kaynak.md");
    writeFileSync(src, "eski");
    const target = await copyContext(src, dest);
    rmSync(src);
    await expect(copyContext(src, dest, target)).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("eski");
    expect(readdirSync(dest)).toEqual(["kaynak.md"]);
  });
});

describe("trashContext", () => {
  it("kopyayı çöp kutusuna taşır", async () => {
    expect(await trashContext("/p/Bağlam/x.md")).toBe(true);
    expect(mocks.trashItem).toHaveBeenCalledWith("/p/Bağlam/x.md");
  });

  it("başarısızlığı yutar, kaldırma akışını durdurmaz", async () => {
    mocks.trashItem.mockRejectedValueOnce(new Error("yok"));
    expect(await trashContext("/p/Bağlam/yok.md")).toBe(false);
  });
});
