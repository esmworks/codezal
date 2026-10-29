import { describe, expect, it } from "vitest";
import { applyReorder, dropAfter, dropIndex } from "./reorder";

describe("applyReorder", () => {
  it("görünen liste tam listeyse taşımayı uygular", () => {
    const all = ["a", "b", "c", "d"];
    expect(applyReorder(all, all, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(applyReorder(all, all, "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(applyReorder(all, all, "b", 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("kayıtta olmayan görünen öğe sıraya girmez", () => {
    const all = ["a", "b"];
    // "x" henüz kayıtlı değil (yolu silinmiş olabilir): sıraya yazılmaz, indeks kaydırmaz.
    expect(applyReorder(all, ["x", "a", "b"], "b", 0)).toEqual(["b", "a"]);
  });

  it("gizli öğelerin göreli konumunu korur", () => {
    const all = ["a", "gizli1", "b", "c", "gizli2"];
    const visible = ["a", "b", "c"];
    // c, a'nın önüne: gizli1 ve gizli2 yerlerinde kalır.
    expect(applyReorder(all, visible, "c", 0)).toEqual(["c", "gizli1", "a", "b", "gizli2"]);
  });

  it("aynı konuma bırakıldığında listeyi değiştirmez", () => {
    const all = ["a", "b", "c"];
    expect(applyReorder(all, all, "b", 1)).toEqual(all);
  });

  it("bilinmeyen anahtarda listeyi değiştirmez", () => {
    const all = ["a", "b"];
    expect(applyReorder(all, all, "yok", 0)).toEqual(all);
  });

  it("hedef indeksi sınırlara kırpar", () => {
    const all = ["a", "b", "c"];
    expect(applyReorder(all, all, "a", 99)).toEqual(["b", "c", "a"]);
    expect(applyReorder(all, all, "c", -5)).toEqual(["c", "a", "b"]);
  });
});

describe("dropAfter / dropIndex", () => {
  it("imlecin alt yarısı 'arkasına' sayılır", () => {
    expect(dropAfter({ top: 100, height: 30 }, 110)).toBe(false);
    expect(dropAfter({ top: 100, height: 30 }, 120)).toBe(true);
  });

  it("hedef indeksi sürüklenenin çıkarılmasına göre düzeltir", () => {
    const visible = ["a", "b", "c", "d"];
    expect(dropIndex(visible, "a", "c", false)).toBe(1);
    expect(dropIndex(visible, "a", "c", true)).toBe(2);
    expect(dropIndex(visible, "d", "b", false)).toBe(1);
    expect(dropIndex(visible, "d", "b", true)).toBe(2);
    expect(dropIndex(visible, "a", "yok", false)).toBe(-1);
  });
});
