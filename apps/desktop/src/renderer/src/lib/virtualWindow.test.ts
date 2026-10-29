import { describe, expect, it } from "vitest";
import {
  ROW_HEIGHT_ESTIMATE,
  RowHeightCache,
  VIRTUAL_MIN_ROWS,
  VIRTUAL_OVERSCAN,
  virtualWindow,
} from "./virtualWindow";

const heights = (n: number, h = 100): number[] => Array.from({ length: n }, () => h);

describe("virtualWindow", () => {
  it("eşik altındaki listede pencere uygulamaz", () => {
    const count = VIRTUAL_MIN_ROWS;
    const w = virtualWindow({ count, scrollTop: 5_000, viewport: 800, heights: heights(count) });
    expect(w).toEqual({ start: 0, end: count, padTop: 0, padBottom: 0 });
  });

  it("görünen bölgeyi payıyla birlikte çizer, kalanı boşlukla tutar", () => {
    const count = 1_000;
    const h = 100;
    // 50. satırın başı görünür alanın tepesinde.
    const w = virtualWindow({
      count,
      scrollTop: 50 * h,
      viewport: 800,
      heights: heights(count, h),
      overscan: 2,
    });
    // 50..57 tam görünür (800px / 100px), iki yandan pay düşülünce 48..59.
    expect(w.start).toBe(48);
    expect(w.end).toBe(60);
    expect(w.padTop).toBe(48 * h);
    expect(w.padBottom).toBe((count - 60) * h);
  });

  it("boşluklar + çizilen satırlar toplam yüksekliği korur", () => {
    // Kaydırma çapası bu eşitliğe güvenir: toplam yükseklik değişirse sohbet zıplar.
    const count = 500;
    const list = heights(count, 120);
    const w = virtualWindow({ count, scrollTop: 12_000, viewport: 900, heights: list });
    const drawn = list.slice(w.start, w.end).reduce((a, b) => a + b, 0);
    expect(w.padTop + drawn + w.padBottom).toBe(count * 120);
  });

  it("ölçülmemiş satırlar için tahmin kullanılır", () => {
    const count = 300;
    const list: (number | undefined)[] = Array.from({ length: count }, () => undefined);
    const w = virtualWindow({ count, scrollTop: 0, viewport: 800, heights: list, overscan: 0 });
    expect(w.padTop).toBe(0);
    // 800px / 116px tahmin ≈ 7 satır görünür.
    expect(w.end).toBeGreaterThanOrEqual(7);
    expect(w.padBottom).toBeGreaterThan(0);
    expect(w.padTop + w.end * ROW_HEIGHT_ESTIMATE + w.padBottom).toBe(count * ROW_HEIGHT_ESTIMATE);
  });

  it("listenin sonundayken pencereyi taşırmaz", () => {
    const count = 400;
    const w = virtualWindow({
      count,
      scrollTop: 39_000,
      viewport: 1_000,
      heights: heights(count, 100),
    });
    expect(w.end).toBe(count);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBeLessThan(count);
  });

  it("kap ölçülmemişken listenin sonunu çizer (sohbet dibe yapışıktır)", () => {
    // İlk karede `viewport` sıfırdır. Baştan çizmek eski mesajları gösterip bir sonraki karede
    // aşağı atlardı; sohbetin doğal konumu sondur.
    const count = 200;
    const w = virtualWindow({ count, scrollTop: 0, viewport: 0, heights: heights(count) });
    expect(w.end).toBe(count);
    expect(w.start).toBe(count - VIRTUAL_OVERSCAN * 3);
    expect(w.padTop + (count - w.start) * 100).toBe(count * 100);
    expect(w.padBottom).toBe(0);
  });

  it("varyanslı yüksekliklerde de toplamı korur", () => {
    const count = 600;
    const list = Array.from({ length: count }, (_, i) => 40 + (i % 7) * 90);
    const w = virtualWindow({ count, scrollTop: 20_000, viewport: 700, heights: list });
    const drawn = list.slice(w.start, w.end).reduce((a, b) => a + b, 0);
    expect(w.padTop + drawn + w.padBottom).toBe(list.reduce((a, b) => a + b, 0));
    expect(w.end - w.start).toBeLessThan(VIRTUAL_MIN_ROWS);
  });
});

describe("RowHeightCache", () => {
  it("ölçümü saklar ve tur sırasına göre seri üretir", () => {
    const cache = new RowHeightCache();
    cache.set("a", 120);
    cache.set("c", 80);
    expect(cache.series(["a", "b", "c"])).toEqual([120, undefined, 80]);
  });

  it("sıfır/negatif yüksekliği yok sayar", () => {
    const cache = new RowHeightCache();
    cache.set("a", 0);
    cache.set("b", -5);
    expect(cache.size).toBe(0);
  });

  it("kapasiteyi aşınca en eski kaydı düşürür", () => {
    const cache = new RowHeightCache(3);
    for (const k of ["a", "b", "c", "d"]) cache.set(k, 100);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe(100);
  });

  it("aynı tur yeniden ölçülünce sırası tazelenir (LRU)", () => {
    const cache = new RowHeightCache(2);
    cache.set("a", 100);
    cache.set("b", 100);
    cache.set("a", 110); // "a" artık en yeni
    cache.set("c", 100); // "b" düşer
    expect(cache.get("a")).toBe(110);
    expect(cache.get("b")).toBeUndefined();
  });
});
