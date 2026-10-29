import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docxToMarkdown } from "./docx.js";
import { imageInfo, markdownToDocx, parseInline, parseMarkdown } from "./docx-build.js";
import { docxCreateTool, resolveDocxPath } from "./docx-create.js";

/** Paketten tek bir XML girdisini okur (testte yapıyı doğrulamak için; yalnız deflate). */
function entry(bytes: Buffer, name: string): string {
  const at = bytes.indexOf(Buffer.from(name, "utf8"));
  let p = at;
  while (p > 0 && bytes.readUInt32LE(p) !== 0x04034b50) p--;
  const size = bytes.readUInt32LE(p + 18);
  const start = p + 30 + bytes.readUInt16LE(p + 26) + bytes.readUInt16LE(p + 28);
  const raw = bytes.subarray(start, start + size);
  return bytes.readUInt16LE(p + 8) === 8
    ? inflateRawSync(raw).toString("utf8")
    : raw.toString("utf8");
}

const build = (markdown: string, extra: Partial<Parameters<typeof markdownToDocx>[1]> = {}) =>
  markdownToDocx(markdown, {
    baseDir: tmpdir(),
    pageSize: "A4",
    landscape: false,
    pageNumbers: true,
    ...extra,
  });

// 2×1 kırmızı PNG
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000002000000010802000000" +
    "7b40e8dd0000000f49444154789c63f8cfc0f01f0005fe02fe3a5b5b760000000049454e44ae426082",
  "hex",
);

describe("parseInline", () => {
  it("vurgu, kod, bağlantı, kaçış ve <br>; kelime içindeki _ düz kalır", () => {
    expect(parseInline("a **b *c*** `x*y` [z](https://z.dev) \\*d\\* e<br>f dosya_adi_v2")).toEqual(
      [
        { text: "a " },
        { text: "b ", bold: true },
        { text: "c", bold: true, italic: true },
        { text: " " },
        { text: "x*y", code: true },
        { text: " " },
        { text: "z", link: "https://z.dev" },
        { text: " *d* e" },
        { text: "", lineBreak: true },
        { text: "f dosya_adi_v2" },
      ],
    );
  });
});

describe("parseMarkdown", () => {
  it("blokları ayırır: iç içe liste (4 boşluk), gevşek liste, tablo hizası, çit, sayfa sonu", () => {
    const blocks = parseMarkdown(
      [
        "# Başlık",
        "Birinci satır",
        "ikinci satır  ",
        "üçüncü",
        "- a",
        "    - a1",
        "",
        "- b",
        "  devam",
        "1. bir",
        "",
        "| Ad | Tutar |",
        "|:---|---:|",
        "| x \\| y | 5 |",
        "```ts",
        "const a = 1;",
        "```",
        "<pagebreak>",
        "> alıntı",
        "---",
        "![Logo](img/logo.png)",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Başlık" },
      { kind: "paragraph", text: "Birinci satır ikinci satır<br>üçüncü" },
      {
        kind: "list",
        items: [
          { level: 0, ordered: false, text: "a" },
          { level: 1, ordered: false, text: "a1" },
          { level: 0, ordered: false, text: "b devam" },
          { level: 0, ordered: true, text: "bir" },
        ],
      },
      { kind: "table", header: ["Ad", "Tutar"], align: ["left", "right"], rows: [["x | y", "5"]] },
      { kind: "code", lines: ["const a = 1;"] },
      { kind: "pagebreak" },
      { kind: "quote", text: "alıntı" },
      { kind: "rule" },
      { kind: "image", alt: "Logo", src: "img/logo.png" },
    ]);
  });
});

describe("imageInfo", () => {
  it("PNG, GIF ve JPEG boyutunu başlıktan okur; SVG'yi tanımaz", () => {
    expect(imageInfo(PNG)).toEqual({ type: "png", width: 2, height: 1 });
    const gif = Buffer.from("GIF89a\x05\x00\x03\x00", "latin1");
    expect(imageInfo(gif)).toEqual({ type: "gif", width: 5, height: 3 });
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20,
      0x00, 0x40, 0x03,
    ]);
    expect(imageInfo(jpg)).toEqual({ type: "jpg", width: 64, height: 32 });
    expect(imageInfo(Buffer.from("<svg/>"))).toBeUndefined();
  });
});

describe("markdownToDocx", () => {
  it("gidiş-dönüş: üretilen belge okuyucudan aynı yapıyla döner (Türkçe dahil)", async () => {
    const markdown = [
      "# Teklif: Soğuk Oda",
      "Sayın **Müşteri**, *ekte* teklifimiz ~~eski~~ yer alır. [Site](https://codezal.app)",
      "## Kalemler",
      "- Evaporatör",
      "  - 12 kW",
      "- Kondenser",
      "1. Keşif",
      "2. Montaj",
      "",
      "| Ürün | Adet | Fiyat |",
      "|---|:---:|---:|",
      "| Panel | 4 | 1.200 ₺ |",
      "| Kapı | 1 | 800 ₺ |",
    ].join("\n");
    const result = await build(markdown);
    expect(result).toMatchObject({ headings: 2, tables: 1, images: 0, warnings: [] });
    expect(docxToMarkdown(result.bytes)).toBe(
      [
        "# Teklif: Soğuk Oda",
        "",
        "Sayın **Müşteri**, *ekte* teklifimiz ~~eski~~ yer alır. [Site](https://codezal.app)",
        "",
        "## Kalemler",
        "",
        "- Evaporatör\n  - 12 kW\n- Kondenser\n1. Keşif\n2. Montaj",
        "",
        "| **Ürün** | **Adet** | **Fiyat** |",
        "| --- | --- | --- |",
        "| Panel | 4 | 1.200 ₺ |",
        "| Kapı | 1 | 800 ₺ |",
      ].join("\n"),
    );
  });

  it("Word tuzakları kodda çözülür: A4, DXA tablo genişlikleri, CLEAR gölge, numara örneği", async () => {
    const { bytes } = await build(
      "| A | B |\n|---|---|\n| uzun bir hücre metni | x |\n\n1. a\n\n# Ara\n\n1. yeniden",
    );
    const doc = entry(bytes, "word/document.xml");
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');
    const grid = [...doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(grid.reduce((a, b) => a + b, 0)).toBe(11906 - 2 * 1134);
    expect(grid[0]).toBeGreaterThan(grid[1] ?? 0);
    expect(doc).toMatch(/<w:tcW w:type="dxa" w:w="\d+"\/>/);
    expect(doc).not.toContain('w:type="pct"');
    expect(doc).toContain('w:val="clear"');
    expect(doc).not.toContain("•");
    // İki ayrı numaralı liste ayrı numId alır: ikincisi 1'den başlar.
    const numIds = new Set([...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]));
    expect(numIds.size).toBe(2);
    expect(entry(bytes, "word/styles.xml")).toContain('w:val="tr-TR"');
  });

  it("yatay Letter sayfa, sayfa numarasız, başlık özelliği", async () => {
    const { bytes } = await build("metin", {
      pageSize: "Letter",
      landscape: true,
      pageNumbers: false,
      title: "Rapor",
      lang: "en",
    });
    const doc = entry(bytes, "word/document.xml");
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toContain('w:w="15840"');
    expect(doc).not.toContain("footerReference");
    expect(entry(bytes, "docProps/core.xml")).toContain("<dc:title>Rapor</dc:title>");
  });

  describe("görseller", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "codezal-docx-img-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("yerel PNG gömülür; eksik, uzak ve desteklenmeyen görsel uyarıyla yer tutucuya döner", async () => {
      writeFileSync(join(dir, "logo.png"), PNG);
      writeFileSync(join(dir, "sema.svg"), "<svg/>");
      const result = await build(
        [
          "![Logo](logo.png)",
          "![Yok](yok.png)",
          "![Uzak](https://x.dev/a.png)",
          "![Şema](sema.svg)",
        ].join("\n"),
        { baseDir: dir },
      );
      expect(result.images).toBe(1);
      expect(result.warnings).toHaveLength(3);
      expect(result.warnings.join("\n")).toMatch(/yok\.png[\s\S]*x\.dev[\s\S]*sema\.svg/);
      expect(docxToMarkdown(result.bytes)).toBe(
        "[görsel: Logo]\n\n*[Yok]*\n\n*[Uzak]*\n\n*[Şema]*",
      );
    });
  });
});

describe("docxCreateTool", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codezal-docx-tool-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("göreli ad çıktı klasörüne yazılır, .docx eklenir; sonuç özeti ve uyarıları söyler", async () => {
    const out = join(dir, "Çıktılar");
    const tool = docxCreateTool({ cwd: dir, outputsDir: out });
    expect(tool.name).toBe("docx_create");
    const res = await tool.execute(
      "t1",
      { path: "alt/teklif", markdown: "# Başlık\n\n![x](yok.png)" },
      undefined,
      undefined,
      {} as never,
    );
    const path = join(out, "alt", "teklif.docx");
    expect(res.details).toMatchObject({ path });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("1 başlık, 0 tablo, 0 görsel");
    expect(text).toContain("görsel bulunamadı: yok.png");
    expect(docxToMarkdown(readFileSync(path))).toContain("# Başlık");
  });

  it("boş Markdown reddedilir", async () => {
    const tool = docxCreateTool({ cwd: dir });
    await expect(
      tool.execute("t1", { path: "a", markdown: "  \n" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/boş/);
  });

  it("resolveDocxPath: mutlak yol olduğu gibi, göreli ad cwd'ye", () => {
    expect(resolveDocxPath("/tmp/a.DOCX", "/cwd", "/out")).toBe("/tmp/a.DOCX");
    expect(resolveDocxPath("rapor", "/cwd")).toBe("/cwd/rapor.docx");
  });
});
