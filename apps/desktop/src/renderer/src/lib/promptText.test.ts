import { promptQuotes } from "@codezal/contracts";
import { dict } from "@codezal/i18n";
import { describe, expect, it } from "vitest";
import {
  clipParts,
  collapsePrompt,
  expandPrompt,
  mentionedPaths,
  mentionText,
  promptParts,
  withQuotes,
} from "./promptText";

const tr = dict("tr").prompt;
const en = dict("en").prompt;

describe("expandPrompt", () => {
  it("kısayol komutu etiketli talimat bloğuna genişler, istek arkasında kalır", () => {
    const text = expandPrompt("/plan giriş ekranını yenile");
    expect(text).toBe(
      `<codezal-command name="plan">\n${tr.plan}\n</codezal-command>\n\ngiriş ekranını yenile`,
    );
    expect(expandPrompt("/ask bu ne yapıyor?")).toContain(tr.ask);
    expect(expandPrompt("/debug testler kırık")).toContain(tr.debug);
  });

  it("/interview plan moduna geçip sorularla netleştiren talimata genişler", () => {
    const text = expandPrompt("/interview karanlık tema zamanlayıcısı");
    expect(text).toBe(
      `<codezal-command name="interview">\n${tr.interview}\n</codezal-command>\n\nkaranlık tema zamanlayıcısı`,
    );
    // Talimat mevcut araçlara dayanır: koda dokunmadan plan modu, sorular kartla, onay plan_exit ile.
    for (const tool of ["plan_enter", "question", "plan_exit"]) {
      expect(tr.interview).toContain(tool);
      expect(en.interview).toContain(tool);
    }
    expect(expandPrompt("/görüşme x")).toMatch(/^<codezal-command name="interview">/);
    expect(collapsePrompt(text)).toBe("/interview karanlık tema zamanlayıcısı");
  });

  it("Türkçe takma ad da kanonik adla etiketlenir", () => {
    expect(expandPrompt("/sor neden?")).toMatch(/^<codezal-command name="ask">/);
    const audit = expandPrompt("/denetim yalnızca apps/desktop");
    expect(audit).toContain("audit_start");
    expect(audit).toMatch(/yalnızca apps\/desktop$/);
    expect(expandPrompt("/audit", "en")).toContain(en.auditStart);
  });

  it("Pi komutları ve düz metin olduğu gibi geçer", () => {
    expect(expandPrompt("/skill:tdd-mastery testleri yaz")).toBe("/skill:tdd-mastery testleri yaz");
    expect(expandPrompt("/review src/a.ts")).toBe("/review src/a.ts");
    expect(expandPrompt("  merhaba ")).toBe("merhaba");
  });

  it("@dosya bahisleri metinde kalır, okuma listesi sona eklenir; e-postaya dokunmaz", () => {
    const text = expandPrompt("@/tmp/a.ts ve @~/b.md dosyalarına bak; ali@ornek.dev yazsın");
    expect(text).toContain("@/tmp/a.ts ve @~/b.md dosyalarına bak");
    expect(text).toMatch(
      new RegExp(
        `<codezal-files>\\n${tr.readFirst}\\n- /tmp/a\\.ts\\n- ~/b\\.md\\n</codezal-files>$`,
      ),
    );
    // Liste satırlarında `@` yok: bahisler yalnız metinden okunur.
    expect(mentionedPaths(text)).toEqual(["/tmp/a.ts", "~/b.md"]);
    expect(text).not.toContain("- ornek.dev");
  });

  it("addan sonra noktalama gelse de kısayol genişler; yol komut sanılmaz", () => {
    expect(expandPrompt("/plan: ekranı yenile")).toBe(expandPrompt("/plan ekranı yenile"));
    expect(expandPrompt("/plan, şunu yap")).toMatch(/\n\nşunu yap$/);
    expect(expandPrompt("/talimat")).toMatch(/^<codezal-command name="init">/);
    expect(expandPrompt("/plan.md dosyasını oku")).toBe("/plan.md dosyasını oku");
  });

  it("okuma listesi tekrarsızdır; yerel komut argümanına eklenmez", () => {
    const twice = expandPrompt("@/a.ts ve yine @/a.ts");
    expect(twice.match(/- \/a\.ts/g)).toHaveLength(1);
    expect(expandPrompt("/goal @/a.ts dosyasını düzelt")).toBe("/goal @/a.ts dosyasını düzelt");
    // Beceri gövdesi argümanı sona ekler; liste orada zararsızdır.
    expect(expandPrompt("/skill:tdd @/a.ts")).toContain("<codezal-files>");
  });

  it("boşluklu yol tırnaklı bahis olarak tek yol sayılır", () => {
    expect(mentionText("/a/My Project/x.ts")).toBe('@"/a/My Project/x.ts"');
    expect(mentionText("/a/b.ts")).toBe("@/a/b.ts");
    expect(mentionedPaths('bak @"/a/My Project/x.ts" ve @/b.ts')).toEqual([
      "/a/My Project/x.ts",
      "/b.ts",
    ]);
  });
});

describe("collapsePrompt", () => {
  it("genişlemenin tersidir", () => {
    for (const raw of [
      "/plan giriş ekranını yenile",
      "/ask",
      "/debug @/tmp/a.ts kırık",
      "düz metin @~/b.md",
      "/skill:tdd testleri yaz",
    ]) {
      expect(collapsePrompt(expandPrompt(raw))).toBe(raw);
    }
  });

  it("Pi beceri bloğunu `/skill:ad` yazımına çevirir", () => {
    const pi =
      '<skill name="tdd" location="/s/tdd/SKILL.md">\nReferences are relative to /s/tdd.\n\nGövde\n</skill>\n\ntestleri yaz';
    expect(collapsePrompt(pi)).toBe("/skill:tdd testleri yaz");
  });

  it("etiketsiz eski kayıtları da tanır (iki dilde)", () => {
    expect(collapsePrompt(`${tr.plan}\n\nekranı yenile`)).toBe("/plan ekranı yenile");
    expect(collapsePrompt(en.ask)).toBe("/ask");
    expect(collapsePrompt(`bak\n\n${tr.readFirst}\n- /tmp/a.ts\n- ~/b.md`)).toBe(
      "bak @/tmp/a.ts @~/b.md",
    );
  });

  it("tanınmayan metne dokunmaz", () => {
    expect(collapsePrompt("merhaba\n\ndünya")).toBe("merhaba\n\ndünya");
  });
});

describe("promptParts", () => {
  it("baştaki komutu ve her yerdeki dosya bahsini etikete ayırır", () => {
    expect(promptParts("/plan şunu @/a/b.ts ile yap")).toEqual([
      { kind: "command", value: "/plan" },
      { kind: "text", text: " şunu " },
      { kind: "file", path: "/a/b.ts", value: "@/a/b.ts" },
      { kind: "text", text: " ile yap" },
    ]);
  });

  it("takma ad kanonik yazıma iner; beceri ve şablon tanınır", () => {
    expect(promptParts("/düşünme high")[0]).toEqual({ kind: "command", value: "/effort" });
    expect(promptParts("/skill:tdd")[0]).toEqual({
      kind: "skill",
      name: "tdd",
      value: "/skill:tdd",
    });
    expect(promptParts("/review x")).toEqual([{ kind: "text", text: "/review x" }]);
  });

  it("tırnaklı bahis tek etikettir", () => {
    expect(promptParts('bak @"/a/b c.ts" şimdi')).toEqual([
      { kind: "text", text: "bak " },
      { kind: "file", path: "/a/b c.ts", value: '@"/a/b c.ts"' },
      { kind: "text", text: " şimdi" },
    ]);
  });

  it("önizleme sınırı etiketi bölmez, düz metni keser", () => {
    const parts = promptParts("baştan @/a/uzun/dosya.ts sonra");
    // Sınır bahsin ortasına düşüyor: etiket bütün kalır, sonrası çizilmez.
    expect(clipParts(parts, 12)).toEqual([
      { kind: "text", text: "baştan " },
      { kind: "file", path: "/a/uzun/dosya.ts", value: "@/a/uzun/dosya.ts" },
    ]);
    expect(clipParts(parts, 3)).toEqual([{ kind: "text", text: "baş" }]);
  });

  it("komut yalnız mesajın başında etiket olur", () => {
    expect(promptParts("şunu /plan et")).toEqual([{ kind: "text", text: "şunu /plan et" }]);
    expect(promptParts("/plan", { head: false })).toEqual([{ kind: "text", text: "/plan" }]);
  });
});

describe("withQuotes", () => {
  it("alıntıyı sona ekler; balon yazılanı, alıntıyı ayrı görür", () => {
    const sent = expandPrompt(withQuotes("/plan düzelt @/a.ts", ["bak @/b.ts"]), "tr");
    expect(sent.startsWith('<codezal-command name="plan">')).toBe(true);
    expect(sent).toContain(`${tr.quoteHead}\n\n> bak @/b.ts`);
    // Alıntıdaki yol okuma listesine girmez.
    expect(sent).toContain(`${tr.readFirst}\n- /a.ts\n</codezal-files>`);
    expect(sent).not.toContain("- /b.ts");
    expect(collapsePrompt(sent)).toBe("/plan düzelt @/a.ts");
    expect(promptQuotes(sent)).toEqual(["bak @/b.ts"]);
  });

  it("alıntı yoksa ya da yerel komutsa metni değiştirmez", () => {
    expect(withQuotes("soru", [])).toBe("soru");
    expect(withQuotes("/goal bitir", ["a"])).toBe("/goal bitir");
  });
});
