import { describe, expect, it } from "vitest";
import { TITLE_INPUT_MAX, titlePrompt } from "./title.js";

const labels = { user: "Mesajlar:", reply: "Son yanıt:" };

describe("titlePrompt", () => {
  it("ilk turda ilk mesajı ve yanıtı yazar", () => {
    expect(titlePrompt(["merhaba bana projeyi anlat"], "Bu bir Next.js projesi.", labels)).toBe(
      "Mesajlar:\n- merhaba bana projeyi anlat\n\nSon yanıt:\nBu bir Next.js projesi.",
    );
  });

  it("ilk mesajı ve son üç mesajı alır, aradakileri atlar", () => {
    const out = titlePrompt(["a", "b", "c", "d", "e"], "", labels);
    expect(out).toBe("Mesajlar:\n- a\n- c\n- d\n- e");
  });

  it("boş mesajları atar; hiç mesaj yoksa istem kurmaz", () => {
    expect(titlePrompt(["  ", ""], "yanıt", labels)).toBeUndefined();
    expect(titlePrompt(["", "soru"], "", labels)).toBe("Mesajlar:\n- soru");
  });

  it("uzun metni kısaltır", () => {
    const out = titlePrompt(["x".repeat(TITLE_INPUT_MAX + 50)], "", labels) ?? "";
    expect(out.length).toBe("Mesajlar:\n- ".length + TITLE_INPUT_MAX);
  });
});
