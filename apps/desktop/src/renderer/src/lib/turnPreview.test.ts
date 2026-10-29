import { describe, expect, it } from "vitest";
import {
  buildPreviewText,
  normalizePreviewParagraphs,
  resolveAssistantPreview,
  truncatePreview,
} from "./turnPreview";

describe("normalizePreviewParagraphs", () => {
  it("ilk iki paragrafı alır ve paragraf içi boşlukları sadeleştirir", () => {
    const text = "birinci   paragraf\nsatır iki\n\n\n  ikinci   paragraf  \n\nüçüncü paragraf";
    expect(normalizePreviewParagraphs(text)).toEqual([
      "birinci paragraf satır iki",
      "ikinci paragraf",
    ]);
  });

  it("yalnız boşluktan oluşan metinde boş dizi döner", () => {
    expect(normalizePreviewParagraphs("   \n\n  ")).toEqual([]);
  });
});

describe("truncatePreview", () => {
  it("sınırı aşmayan metni olduğu gibi bırakır", () => {
    expect(truncatePreview("kısa metin", 20)).toBe("kısa metin");
  });

  it("sınırı aşan metni üç nokta ile kısaltır", () => {
    expect(truncatePreview("a".repeat(30), 10)).toBe(`${"a".repeat(7)}...`);
  });

  it("sınırı en az 8 karaktere çeker", () => {
    expect(truncatePreview("a".repeat(30), 2)).toBe(`${"a".repeat(5)}...`);
  });
});

describe("buildPreviewText", () => {
  it("metinleri iki paragrafa indirir ve kendi satır kırıklarını korur", () => {
    const preview = buildPreviewText({
      texts: ["ilk satır\nikinci satır", "ikinci paragraf"],
      fallback: "yedek",
    });
    expect(preview).toBe("ilk satır ikinci satır\nikinci paragraf");
  });

  it("hiç metin yoksa yedeği döner", () => {
    expect(buildPreviewText({ texts: [], fallback: "yedek" })).toBe("yedek");
    expect(buildPreviewText({ texts: ["   ", "\n"], fallback: "yedek" })).toBe("yedek");
  });

  it("karakter sınırında kısaltır", () => {
    const preview = buildPreviewText({ texts: ["b".repeat(500)], fallback: "yedek" });
    expect(preview).toBe(`${"b".repeat(217)}...`);
  });
});

describe("resolveAssistantPreview", () => {
  it("metin varsa özetler ve durumu metin sayar", () => {
    expect(
      resolveAssistantPreview({
        texts: ["yanıt metni"],
        running: true,
        emptyFallback: "boş",
        runningFallback: "sürüyor",
      }),
    ).toEqual({ assistantPreview: "yanıt metni", assistantPreviewKind: "text" });
  });

  it("metin yokken tur sürüyorsa sürüyor ikamesini döner", () => {
    expect(
      resolveAssistantPreview({
        texts: ["  "],
        running: true,
        emptyFallback: "boş",
        runningFallback: "sürüyor",
      }),
    ).toEqual({ assistantPreview: "sürüyor", assistantPreviewKind: "running" });
  });

  it("metin yokken tur bitmişse boş ikamesini döner", () => {
    expect(
      resolveAssistantPreview({
        texts: [],
        running: false,
        emptyFallback: "boş",
        runningFallback: "sürüyor",
      }),
    ).toEqual({ assistantPreview: "boş", assistantPreviewKind: "empty" });
  });
});
