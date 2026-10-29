import { describe, expect, it } from "vitest";
import { looksLikePath, resolveMention } from "./mentions";

const OUT = "/Users/e/Documents/Codezal Asistan/Elektrik Projesi/Çıktılar";

describe("looksLikePath", () => {
  it("klasörlü ya da belge uzantılı adları yol sayar", () => {
    expect(looksLikePath("Çıktılar/type-h-revize-proje.pdf")).toBe(true);
    expect(looksLikePath("src/index.ts")).toBe(true);
    expect(looksLikePath("src/index.ts:42")).toBe(true);
    expect(looksLikePath("./docs/plan.md")).toBe(true);
    expect(looksLikePath("/Users/e/rapor.md")).toBe(true);
    expect(looksLikePath("~/Desktop/ekstre.pdf")).toBe(true);
    expect(looksLikePath("C:\\Users\\e\\rapor.docx")).toBe(true);
    expect(looksLikePath("inceleme.md")).toBe(true);
    // Ara klasörde nokta olabilir: alan adı kalıbı son parçada harf ister, `v2` bunu sağlamaz.
    expect(looksLikePath("desktop.v2/src/a.ts")).toBe(true);
  });

  it("komut, sürüm, kod ve adresleri yol saymaz", () => {
    expect(looksLikePath("pnpm test")).toBe(false);
    expect(looksLikePath("v1.2.3")).toBe(false);
    expect(looksLikePath("Qwen3.8")).toBe(false);
    expect(looksLikePath("Math.max")).toBe(false);
    expect(looksLikePath("engine.ts")).toBe(false);
    expect(looksLikePath("https://example.com/a.pdf")).toBe(false);
    expect(looksLikePath("--out=a.pdf")).toBe(false);
    expect(looksLikePath("apps/desktop")).toBe(false);
    expect(looksLikePath(".gitignore")).toBe(false);
    expect(looksLikePath("fn(a.b)")).toBe(false);
    // Şemasız yazılmış adresler de yol değil: son parçaları noktalı olduğunda (`v44.0.0`) yol
    // sanılıyorlardı ve tıklayınca olmayan bir yerel dosya açılmaya çalışılıyordu.
    expect(looksLikePath("releases.electronjs.org/release/v44.0.0")).toBe(false);
    expect(looksLikePath("electronjs.org/blog/electron-44-0")).toBe(false);
    expect(looksLikePath("electronjs.org/rapor.pdf")).toBe(false);
  });

  it("konuşmada geçen dosyanın çıplak adını yol sayar", () => {
    expect(looksLikePath("engine.ts", ["/p/packages/agent/src/engine.ts"])).toBe(true);
  });
});

describe("resolveMention", () => {
  const ctx = { home: "/Users/e", known: [`${OUT}/proje.pdf`], roots: [OUT, "/tmp/cwd"] };
  it("mutlak ve ev dizini yollarını olduğu gibi çözer", () => {
    expect(resolveMention("/a/b.md", ctx)).toBe("/a/b.md");
    expect(resolveMention("~/x.md", ctx)).toBe("/Users/e/x.md");
  });
  it("bilinen dosyaya sonu uyan bahsi ona bağlar", () => {
    expect(resolveMention("proje.pdf", ctx)).toBe(`${OUT}/proje.pdf`);
    expect(resolveMention("Çıktılar/proje.pdf", ctx)).toBe(`${OUT}/proje.pdf`);
    expect(resolveMention("baska/proje.pdf", ctx)).toBe(`${OUT}/baska/proje.pdf`);
  });
  it("bilinmeyen göreli yolu ilk köke ekler, satır ekini atar", () => {
    expect(resolveMention("./notlar.md:3", ctx)).toBe(`${OUT}/notlar.md`);
    expect(resolveMention("a.md", { home: "", known: [], roots: ["", "/cwd"] })).toBe("/cwd/a.md");
  });
});
