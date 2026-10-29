import { describe, expect, it } from "vitest";
import { boundTextBlocks, MAX_TOOL_RESULT_CHARS, truncateToolText } from "./tool-budget.js";

describe("truncateToolText", () => {
  it("sınırın altındaki metne dokunmaz", () => {
    expect(truncateToolText("kısa", 100)).toBe("kısa");
  });

  it("baştan kırpar ve özgün uzunluğu bildiren işaret ekler", () => {
    const text = "a".repeat(500);
    const out = truncateToolText(text, 100);
    expect(out.startsWith("a".repeat(100))).toBe(true);
    // İşaret makine okunur: özgün uzunluk ve strateji model tarafından görülebilir.
    expect(out).toContain("özgün 500 karakter");
    expect(out).toContain("strateji=head");
  });

  it("tail stratejisinde sonu korur", () => {
    const text = `${"a".repeat(400)}SON`;
    const out = truncateToolText(text, 100, "tail");
    expect(out.endsWith("SON")).toBe(true);
    expect(out).toContain("strateji=tail");
  });

  it("varsayılan sınır araç sonucu bütçesidir", () => {
    const out = truncateToolText("b".repeat(MAX_TOOL_RESULT_CHARS + 10));
    expect(out).toContain(`özgün ${MAX_TOOL_RESULT_CHARS + 10} karakter`);
  });
});

describe("boundTextBlocks", () => {
  it("toplam metni bütçeye indirir, görsel bloklara dokunmaz", () => {
    const blocks = [
      { type: "text", text: "x".repeat(80) },
      { type: "image", data: "AAAA" },
      { type: "text", text: "y".repeat(80) },
    ];
    const out = boundTextBlocks(blocks, 100);
    expect(out[0]?.text).toHaveLength(80);
    expect(out[1]).toEqual({ type: "image", data: "AAAA" });
    expect(out[2]?.text).toContain("kırpıldı");
  });

  it("bütçe tükendikten sonraki metin bloklarını düşürür", () => {
    const blocks = [
      { type: "text", text: "x".repeat(150) },
      { type: "text", text: "y".repeat(50) },
    ];
    const out = boundTextBlocks(blocks, 100);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toContain("kırpıldı");
    // Boş metin bloğu bırakılmaz: sağlayıcılar "text content blocks must be non-empty" ile
    // bütün turu reddeder.
    expect(out.every((b) => b.text !== "")).toBe(true);
  });

  it("görsel blokları bütçe tükense de korur", () => {
    const blocks = [
      { type: "text", text: "x".repeat(150) },
      { type: "image", data: "AAAA" },
      { type: "text", text: "y".repeat(50) },
    ];
    const out = boundTextBlocks(blocks, 100);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ type: "image", data: "AAAA" });
  });

  it("bütçe içindeyse diziyi olduğu gibi bırakır", () => {
    const blocks = [{ type: "text", text: "kısa" }];
    expect(boundTextBlocks(blocks, 100)).toEqual(blocks);
  });
});
