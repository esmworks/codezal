import { describe, expect, it } from "vitest";
import {
  buildSnippet,
  findAllFolded,
  foldForSearch,
  foldQuery,
  foldWithMap,
  matchesFold,
} from "./search.js";

describe("foldWithMap", () => {
  it("bütün metin katlamasıyla aynı sonucu verir (Türkçe ve ASCII)", () => {
    for (const text of ["Fix IPC timeout", "İstanbul toplantısı", "ÇĞİÖŞÜ ığüşöç", "OpenAI"]) {
      expect(foldWithMap(text).folded).toBe(foldForSearch(text));
    }
  });

  it("önceden ayrışık (NFD) metinde konumları özgün metne bağlar", () => {
    // "şeker" NFD: s + U+0327 birleşen çengel; katlamada işaret düşer, uzunluk kısalır.
    const text = "çay ve şeker";
    const source = foldWithMap(text);
    expect(source.folded).toBe("cay ve seker");
    const [hit] = findAllFolded(text, foldQuery("şeker"));
    expect(hit).toBeDefined();
    expect(text.slice(hit?.start, hit?.end)).toBe("şeker");
  });

  it("Hangul hecesi açılsa da eşleşme aralığı tam hecede kalır", () => {
    const text = "x 한국 y";
    const [hit] = findAllFolded(text, foldQuery("한국"));
    expect(text.slice(hit?.start, hit?.end)).toBe("한국");
  });

  it("vekil çift (emoji) eşleşmenin sonunda bölünmez", () => {
    const text = "merhaba 🎉 dünya";
    const [hit] = findAllFolded(text, foldQuery("🎉"));
    expect(text.slice(hit?.start, hit?.end)).toBe("🎉");
  });
});

describe("findAllFolded", () => {
  it("büyük/küçük harf ve aksan farkını yok sayar, her geçişi döner", () => {
    const text = "IPC hatası; ıpc yine. İpc!";
    const hits = findAllFolded(text, foldQuery("ipc"));
    expect(hits.map((h) => text.slice(h.start, h.end))).toEqual(["IPC", "ıpc", "İpc"]);
  });

  it("sınır verilince erken durur, boş sorguda boş döner", () => {
    expect(findAllFolded("a a a a", "a", 2)).toHaveLength(2);
    expect(findAllFolded("abc", "")).toEqual([]);
  });

  it("matchesFold ile tutarlıdır", () => {
    expect(matchesFold("Kod İncelemesi", "inceleme")).toBe(true);
    expect(findAllFolded("Kod İncelemesi", foldQuery("inceleme"))).toHaveLength(1);
  });
});

describe("buildSnippet", () => {
  it("kısa metni olduğu gibi döner, eşleşme aralığını işaretler", () => {
    const s = buildSnippet("merhaba dünya", 8, 13);
    expect(s.text).toBe("merhaba dünya");
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe("dünya");
  });

  it("uzun metinde uçlara üç nokta koyar ve kelime sınırından keser", () => {
    const words = Array.from({ length: 60 }, (_, i) => `kelime${i}`).join(" ");
    const start = words.indexOf("kelime30");
    const s = buildSnippet(words, start, start + "kelime30".length, 30);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe("kelime30");
    // Yarım kelimeyle başlamaz: üç noktadan sonra tam bir kelime gelir.
    expect(s.text.slice(1)).toMatch(/^kelime\d+ /);
  });

  it("satır sonlarını tek boşluğa indirir, aralık yine doğru kalır", () => {
    const text = "ilk satır\n\n  ikinci satır burada";
    const start = text.indexOf("ikinci");
    const s = buildSnippet(text, start, start + 6);
    expect(s.text).toBe("ilk satır ikinci satır burada");
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe("ikinci");
  });

  it("metnin başında ve sonunda eşleşmede üç nokta koymaz", () => {
    const head = buildSnippet("abc def", 0, 3);
    expect(head.text).toBe("abc def");
    expect(head.matchStart).toBe(0);
    const tail = buildSnippet("abc def", 4, 7);
    expect(tail.text.slice(tail.matchStart, tail.matchEnd)).toBe("def");
  });
});
