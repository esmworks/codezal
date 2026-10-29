import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip } from "./docx.fixture.js";
import { buildXlsxFixture, data, fx, n, row, str } from "./xlsx.fixture.js";
import {
  convertXlsx,
  formatNumber,
  isXlsx,
  readXlsxContent,
  serialToDate,
  xlsxToMarkdown,
} from "./xlsx.js";

const table = (md: string) =>
  md
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .map((l) => l.trim());

describe("sayı biçimi", () => {
  it("ondalık, birim eki, yüzde, binlik ayırıcısız", () => {
    expect(formatNumber(2191.6079969, "#,##0.00")).toBe("2191.61");
    expect(formatNumber(18, '0.00\\ "$"')).toBe("18.00 $");
    expect(formatNumber(16000, '#,##0"   $/Ton"')).toBe("16000   $/Ton");
    expect(formatNumber(0.125, "0.0%")).toBe("12.5%");
    expect(formatNumber(1234.5, "[$$-409]#,##0.00")).toBe("$1234.50");
    expect(formatNumber(0.1 + 0.2, "General")).toBe("0.3");
  });

  it("muhasebe: sıfır bölümü rakamsız, negatif bölümü kendi işaretiyle", () => {
    const code = '_-* #,##0.00\\ "₺"_-;\\-* #,##0.00\\ "₺"_-;_-* "-"??\\ "₺"_-;_-@_-';
    expect(formatNumber(21136, code)).toBe("21136.00 ₺");
    expect(formatNumber(-5, code)).toBe("-5.00 ₺");
    expect(formatNumber(0, code)).toBe("- ₺");
    expect(formatNumber(-3, "#,##0.00;(#,##0.00)")).toBe("(3.00)");
  });

  it("tarih ve saat ISO gösterilir; kaçışlı harf tarih sayılmaz", () => {
    expect(formatNumber(46293, "dd.mm.yyyy")).toBe("2026-09-28");
    expect(formatNumber(46293.5, "m/d/yy h:mm")).toBe("2026-09-28 12:00");
    expect(formatNumber(0.75, "h:mm:ss")).toBe("18:00:00");
    expect(formatNumber(12.5, "0.00\\ \\m\\m")).toBe("12.50 mm");
    expect(formatNumber(46293, "[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy")).toBe("2026-09-28");
  });

  it("1900 artık yıl hatası ve 1904 sistemi", () => {
    expect(serialToDate(59).toISOString().slice(0, 10)).toBe("1900-02-28");
    expect(serialToDate(61).toISOString().slice(0, 10)).toBe("1900-03-01");
    expect(serialToDate(0, true).toISOString().slice(0, 10)).toBe("1904-01-01");
  });
});

describe("convertXlsx", () => {
  it("sütun harfli, satır numaralı tablo; boş satır atlanır, sol boş sütunlar kırpılır", () => {
    const bytes = buildXlsxFixture({
      shared: ["Kalem", "Adet", "Evaporatör"],
      sheets: [
        {
          name: "Teklif",
          body: data(
            row(2, '<c r="B2" t="s"><v>0</v></c>', '<c r="C2" t="s"><v>1</v></c>'),
            row(3, '<c r="B3" t="s"><v>2</v></c>', n("C3", 2)),
            row(6, str("B6", "a|b"), '<c r="C6" t="b"><v>1</v></c>'),
          ),
        },
      ],
    });
    const md = xlsxToMarkdown(bytes);
    expect(md).toContain("## Sayfa 1: Teklif");
    expect(md).toContain("B2:C6 · 3 satır");
    expect(table(md)).toEqual([
      "|   | B | C |",
      "| 2 | Kalem | Adet |",
      "| 3 | Evaporatör | 2 |",
      "| 6 | a\\|b | TRUE |",
    ]);
  });

  it("formül: önbellek değeri tabloda, formül listede; değersiz formül tabloda görünür", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: data(
            row(1, n("A1", 2), n("B1", 3), fx("C1", "A1*B1", 6)),
            row(2, n("A2", 4), n("B2", 5), fx("C2", "A2*B2", 20)),
            row(3, fx("C3", "SUM(C1:C2)")),
          ),
        },
      ],
    });
    const md = xlsxToMarkdown(bytes);
    expect(table(md)).toContain("| 1 | 2 | 3 | 6 |");
    expect(table(md)).toContain("| 3 |  |  | =SUM(C1:C2) |");
    // Satır satır kayan aynı formül tek satırda toplanır.
    expect(md).toContain("- C1:C2: `=A1*B1`");
    expect(md).toContain("- C3: `=SUM(C1:C2)`");
  });

  it("paylaşılan formülün bağımlı hücresi ana formülden kaydırılarak çıkarılır", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: data(
            row(1, '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*$D$1</f><v>1</v></c>'),
            row(2, '<c r="B2"><f t="shared" si="0"/><v>2</v></c>'),
            row(3, '<c r="B3"><f t="shared" si="0"/><v>3</v></c>'),
          ),
        },
      ],
    });
    expect(xlsxToMarkdown(bytes)).toContain("- B1:B3: `=A1*$D$1`");
  });

  it("r özniteliği olmayan satır ve hücreler sırayla sayılır", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: "<sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row></sheetData>",
        },
      ],
    });
    expect(table(xlsxToMarkdown(bytes))).toEqual([
      "|   | A | B |",
      "| 1 | 1 | 2 |",
      "| 2 | 3 |  |",
    ]);
  });

  it("biçimler: tarih, yüzde, özel biçim; zengin metin ve fonetik atlanır", () => {
    const bytes = buildXlsxFixture({
      shared: [
        '<r><t>Kalın</t></r><r><rPr><b/></rPr><t> metin</t></r><rPh sb="0" eb="1"><t>X</t></rPh>',
      ],
      numFmts: '<numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/>',
      cellXfs:
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      sheets: [
        {
          name: "S",
          body: data(
            row(
              1,
              n("A1", 46293, 1),
              n("B1", 0.2, 2),
              n("C1", 46294, 3),
              '<c r="D1" t="s"><v>0</v></c>',
            ),
          ),
        },
      ],
    });
    expect(table(xlsxToMarkdown(bytes))).toContain(
      "| 1 | 2026-09-28 | 20% | 2026-09-29 | Kalın metin |",
    );
  });

  it("birleşik hücre, tablo, not, gizli sayfa, tanımlı ad ve hata değeri", () => {
    const bytes = buildXlsxFixture({
      definedNames:
        '<definedName name="Kur">Veri!$B$1</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Veri!$A$1:$B$2</definedName>',
      sheets: [
        {
          name: "Veri",
          body: `${data(
            row(1, str("A1", "Başlık"), n("B1", 33.2)),
            row(2, '<c r="A2" t="e"><f>1/0</f><v>#DIV/0!</v></c>'),
          )}<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><tableParts count="1"><tablePart r:id="rId2"/></tableParts>`,
          rels: { rId1: ["comments", "../comments1.xml"], rId2: ["table", "../tables/table1.xml"] },
        },
        { name: "Gizli", state: "hidden", body: data(row(1, n("A1", 1))) },
      ],
      parts: {
        "xl/comments1.xml":
          '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Erhan</author></authors><commentList><comment ref="B1" authorId="0"><text><r><t>Erhan:</t></r><r><t xml:space="preserve">\nGüncel kur</t></r></text></comment></commentList></comments>',
        "xl/tables/table1.xml":
          '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Tablo1" displayName="Tablo1" ref="A1:B2"/>',
      },
    });
    const md = xlsxToMarkdown(bytes);
    expect(md).toContain("**Tanımlı adlar:** `Kur` = `Veri!$B$1`");
    expect(md).not.toContain("Print_Area");
    expect(md).toContain("| 2 | #DIV/0! |  |");
    expect(md).toContain("**Birleşik hücreler:** A1:B1");
    expect(md).toContain("**Tablolar:** Tablo1 (A1:B2)");
    expect(md).toContain("- B1 (Erhan): Güncel kur");
    expect(md).toContain("## Sayfa 2: Gizli (gizli)");
  });

  it("önizleme satır sınırı ve boş sayfa", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        { name: "Uzun", body: data(...[1, 2, 3, 4, 5].map((r) => row(r, n(`A${r}`, r)))) },
        { name: "Boş", body: "<sheetData/>" },
      ],
    });
    const md = convertXlsx(bytes, "tr", { maxRows: 2 }).markdown;
    expect(table(md)).toHaveLength(3);
    expect(md).toContain("… 3 satır daha");
    expect(md).toContain("## Sayfa 2: Boş\n\n(boş sayfa)");
  });

  it("paket olmayan dosya anlaşılır hata verir", () => {
    expect(() => convertXlsx(Buffer.from("eski xls"))).toThrow(/\.xlsx paketi değil/);
    expect(() => convertXlsx(buildZip({ "a.txt": "x" }))).toThrow(/xl\/workbook\.xml/);
  });

  it("uzantılar", () => {
    expect(isXlsx("a.XLSX")).toBe(true);
    expect(isXlsx("a.xlsm")).toBe(true);
    expect(isXlsx("a.xls")).toBe(false);
    expect(isXlsx("a.csv")).toBe(false);
  });
});

describe("readXlsxContent", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xlsx-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("başlık satırı ve offset/limit ile sayfalama", async () => {
    const path = join(dir, "liste.xlsx");
    await writeFile(
      path,
      buildXlsxFixture({
        sheets: [
          { name: "S", body: data(...[1, 2, 3, 4, 5, 6].map((r) => row(r, n(`A${r}`, r)))) },
        ],
      }),
    );
    const [first] = await readXlsxContent(path, { maxLines: 2000, maxBytes: 50_000, limit: 4 });
    expect(first?.text).toMatch(/^Excel: liste\.xlsx · 1 sayfa · \d+ satır/);
    expect(first?.text).toContain("Devamı için offset=5 ver.");
    const [rest] = await readXlsxContent(path, { maxLines: 2000, maxBytes: 50_000, offset: 5 });
    expect(rest?.text).toContain("| 6 | 6 |");
    await expect(
      readXlsxContent(path, { maxLines: 10, maxBytes: 1000, offset: 99 }),
    ).rejects.toThrow(/offset=99/);
  });
});
