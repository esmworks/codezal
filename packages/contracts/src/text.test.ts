import { describe, expect, it } from "vitest";
import {
  cleanGeneratedTitle,
  collapsePromptMarkup,
  deriveSessionTitle,
  GENERATED_TITLE_MAX,
  promptQuotes,
  quoteBlock,
  SESSION_TITLE_MAX,
  stripPromptQuotes,
} from "./text.js";

describe("deriveSessionTitle", () => {
  it("ilk boş olmayan satırı tek boşluklu hâle getirir", () => {
    expect(deriveSessionTitle("\n  \n  docker   ps  \nikinci satır", "Yeni görev")).toBe(
      "docker ps",
    );
  });

  it("kısa tek satırı olduğu gibi döndürür", () => {
    expect(deriveSessionTitle("Merhaba", "Yeni görev")).toBe("Merhaba");
  });

  it("80 karakteri kelime sınırında keser", () => {
    const title = deriveSessionTitle("kelime ".repeat(20).trim(), "Yeni görev");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX + 1);
    expect(title.includes("  ")).toBe(false);
  });

  it("boşluksuz uzun metni sert keser", () => {
    expect(deriveSessionTitle("a".repeat(120), "Yeni görev")).toBe(
      `${"a".repeat(SESSION_TITLE_MAX)}…`,
    );
  });

  it("boş mesajda geri dönüş başlığını verir", () => {
    expect(deriveSessionTitle("  \n \n", "Yeni görev")).toBe("Yeni görev");
  });

  it("emojiyi vekil çiftin ortasından kesmez", () => {
    // 45 emoji UTF-16'da 90 birim, ama 80 **kod noktası** sınırının altında: kesilmemeli.
    expect(deriveSessionTitle("👍".repeat(45), "Yeni görev")).toBe("👍".repeat(45));
    const cut = deriveSessionTitle(`${"a".repeat(SESSION_TITLE_MAX - 1)}👍👍`, "Yeni görev");
    expect(cut.endsWith("👍…")).toBe(true);
  });
});

describe("collapsePromptMarkup", () => {
  it("komut bloğunu, Pi beceri bloğunu ve okuma listesini çözer", () => {
    expect(
      collapsePromptMarkup(
        '<codezal-command name="plan">\nTalimat\n</codezal-command>\n\nekranı yenile @/a.ts\n\n<codezal-files>\nOku:\n- /a.ts\n</codezal-files>',
      ),
    ).toBe("/plan ekranı yenile @/a.ts");
    expect(
      collapsePromptMarkup('<skill name="tdd" location="/s/SKILL.md">\nGövde\n</skill>\n\nyaz'),
    ).toBe("/skill:tdd yaz");
    expect(collapsePromptMarkup("düz metin")).toBe("düz metin");
  });

  it("başlık talimat metninden değil yazılan istekten türer", () => {
    expect(
      deriveSessionTitle(
        '<codezal-command name="ask">\nDeğişiklik yapmadan yanıtla.\n</codezal-command>\n\nbu ne?',
        "Yeni görev",
      ),
    ).toBe("/ask bu ne?");
  });
});

describe("alıntı bloğu", () => {
  const block = quoteBlock(["ilk satır\n\nikinci paragraf", "  ", "tek satır"], "Alıntılar:");

  it("alıntıları `> ` önekli, boş satırla ayrılmış bloğa yazar", () => {
    expect(block).toBe(
      "<codezal-quote>\nAlıntılar:\n\n> ilk satır\n>\n> ikinci paragraf\n\n> tek satır\n</codezal-quote>",
    );
    expect(quoteBlock([" "], "Alıntılar:")).toBe("");
  });

  it("gönderilen metinden alıntıları geri okur, okuma listesi araya girmez", () => {
    const sent = `düzelt @/a.ts\n\n${block}\n\n<codezal-files>\nOku:\n- /a.ts\n</codezal-files>`;
    expect(promptQuotes(sent)).toEqual(["ilk satır\n\nikinci paragraf", "tek satır"]);
    expect(collapsePromptMarkup(sent)).toBe("düzelt @/a.ts");
    expect(stripPromptQuotes(`soru\n\n${block}`)).toBe("soru");
    expect(promptQuotes("düz metin")).toEqual([]);
  });

  it("komutlu mesajda komut başta kalır, başlık alıntıdan türemez", () => {
    const sent = `<codezal-command name="ask">\nT\n</codezal-command>\n\nbu ne?\n\n${block}`;
    expect(collapsePromptMarkup(sent)).toBe("/ask bu ne?");
    expect(deriveSessionTitle(sent, "Yeni görev")).toBe("/ask bu ne?");
  });
});

describe("cleanGeneratedTitle", () => {
  it("tırnak, etiket ve sondaki noktayı atar", () => {
    expect(cleanGeneratedTitle('"Codezal tanıtım tweeti."')).toBe("Codezal tanıtım tweeti");
    expect(cleanGeneratedTitle("Başlık: Windows sürümünü düzelt")).toBe("Windows sürümünü düzelt");
    expect(cleanGeneratedTitle("**Pi motoruna geçiş**")).toBe("Pi motoruna geçiş");
  });

  it("düşünme bloğunu ve boş satırları atlayıp ilk dolu satırı alır", () => {
    expect(cleanGeneratedTitle("<think>kısa bir şey</think>\n\n  Satış raporu  \nikinci")).toBe(
      "Satış raporu",
    );
  });

  it("boş ya da paragraf gibi uzun yanıtta başlık üretmez", () => {
    expect(cleanGeneratedTitle("  \n ")).toBeUndefined();
    expect(cleanGeneratedTitle("a".repeat(GENERATED_TITLE_MAX + 1))).toBeUndefined();
  });
});
