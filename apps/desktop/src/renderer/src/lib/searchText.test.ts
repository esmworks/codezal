import { describe, expect, it } from "vitest";
import { foldForSearch, matchesFold } from "./searchText";

describe("foldForSearch", () => {
  /**
   * Regresyon: arama `toLocaleLowerCase("tr")` kullanıyordu; `I → ı` dönüşümü yüzünden ASCII
   * kısaltmalar hiç bulunamıyordu.
   */
  it("ASCII kısaltmaları Türkçe yazımdan bağımsız eşler", () => {
    for (const text of ["Fix IPC timeout", "Fix ıpc timeout", "Fix İpc timeout", "fix ipc"]) {
      expect(foldForSearch(text)).toContain(foldForSearch("ipc"));
    }
  });

  it("Türkçe aksanlı harfleri sadeleştirir", () => {
    expect(matchesFold("İstanbul toplantısı", "istanbul")).toBe(true);
    expect(matchesFold("ÇĞİÖŞÜ", "cgiosu")).toBe(true);
    expect(matchesFold("ığüşöç", "igusoc")).toBe(true);
  });

  it("büyük harfli Türkçe metinde İngilizce sorguyu bulur", () => {
    expect(matchesFold("UI İyileştirmesi", "ui")).toBe(true);
    expect(matchesFold("IDE ayarları", "ide")).toBe(true);
  });

  it("sağlayıcı adını Türkçe küçültmeden bağımsız bulur (OpenAI → openai)", () => {
    // Regresyon: Ayarlar aramaları `toLocaleLowerCase("tr")` ile "OpenAI"yi `openaı` yapıyordu.
    expect(matchesFold("OpenAI", "openai")).toBe(true);
    expect(matchesFold("OpenAI", "OPENAI")).toBe(true);
    expect(matchesFold("Kod İncelemesi", "inceleme")).toBe(true);
  });

  it("eşleşmeyen sorguda false döner", () => {
    expect(matchesFold("Kodlama", "asistan")).toBe(false);
  });
});

/**
 * Kapı: Ayarlar ve kabuk aramaları `matchesFold` kullanır. `toLocaleLowerCase` yeniden sızarsa
 * (Türkçe küçültme `I → ı`, yerelsiz küçültme `İ → i̇`) arama sessizce eşleşmemeye başlar.
 */
const SEARCH_SOURCES = import.meta.glob(
  ["/src/renderer/src/settings/**/*.tsx", "/src/renderer/src/shell/**/*.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("arama katlama kapısı", () => {
  it("Ayarlar ve kabuk dosyalarında küçük harf katlaması yalnız searchText'ten gelir", () => {
    const offenders = Object.entries(SEARCH_SOURCES)
      .filter(([, src]) => /\.toLocaleLowerCase\(/.test(src))
      .map(([file]) => file);
    expect(Object.keys(SEARCH_SOURCES).length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
