import { describe, expect, it } from "vitest";
import { clampText } from "./clamp";

describe("clampText", () => {
  it("sınırın altındaki metni kırpmaz", () => {
    const text = "kısa mesaj";
    expect(clampText(text)).toEqual({
      preview: text,
      hiddenLines: 0,
      totalLines: 1,
      clamped: false,
    });
  });

  it("satır sınırını aşınca ilk satırları önizler", () => {
    const text = Array.from({ length: 20 }, (_, i) => `satır ${i + 1}`).join("\n");
    const c = clampText(text, { lines: 4 });
    expect(c.clamped).toBe(true);
    expect(c.preview).toBe("satır 1\nsatır 2\nsatır 3\nsatır 4");
    expect(c.hiddenLines).toBe(16);
    expect(c.totalLines).toBe(20);
  });

  it("tek uzun satırı karakter sınırında keser", () => {
    const c = clampText("a".repeat(50), { chars: 10 });
    expect(c.clamped).toBe(true);
    expect(c.preview).toBe("a".repeat(10));
    expect(c.hiddenLines).toBe(0);
  });

  it("sondaki satır sonunu boş satır saymaz", () => {
    const c = clampText("a\nb\nc\n", { lines: 2 });
    expect(c.preview).toBe("a\nb");
    expect(c.hiddenLines).toBe(1);
    expect(c.totalLines).toBe(3);
  });
});
