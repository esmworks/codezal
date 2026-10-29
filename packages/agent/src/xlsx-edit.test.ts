import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipArchive } from "./ooxml.js";
import { buildXlsxFixture, data, fx, n, row, str } from "./xlsx.fixture.js";
import { xlsxToMarkdown } from "./xlsx.js";
import { buildXlsx, formulaWarnings } from "./xlsx-build.js";
import { editXlsx, resolveXlsxEditTarget, type XlsxEdit } from "./xlsx-edit.js";
import { xlsxEditTool } from "./xlsx-edit-tool.js";

const now = new Date("2026-09-28T09:00:00Z");
const part = (bytes: Buffer, name: string) => ZipArchive.open(bytes).readText(name) ?? "";
const table = (md: string) =>
  md
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .map((l) => l.trim());
const edit = (bytes: Uint8Array, ...edits: XlsxEdit[]) => editXlsx(bytes, edits, { now });

/** Teklif: başlık + üç kalem + toplam; Özet sayfası Teklif'e bakar. */
function quote(): Buffer {
  return buildXlsx(
    [
      {
        name: "Teklif",
        rows: [
          ["Kalem", "Adet", "Fiyat", "Tutar"],
          ["A", 1, 10, "=B2*C2"],
          ["B", 2, 20, "=B3*C3"],
          ["C", 3, 30, "=B4*C4"],
          ["Toplam", null, null, "=SUM(D2:D4)"],
        ],
      },
      { name: "Özet", rows: [["Genel", "=Teklif!D5*1.2"]], header: false },
    ],
    { now },
  ).bytes;
}

describe("hücre yazma", () => {
  it("tek hücre ve blok yazılır, bağımlı formüller yeniden hesaplanır", () => {
    const r = edit(quote(), { action: "set", range: "C2", value: 100 });
    expect(r.counts).toEqual({ set: 1 });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("| 2 | A | 1 | 100 | 100 |");
    expect(md).toContain("| 5 | Toplam |  |  | 230 |");
    expect(md).toContain("| 1 | Genel | 276 |");
    expect(r.recalc.pending).toBe(0);

    const block = edit(quote(), {
      action: "set",
      range: "Teklif!A6",
      values: [
        ["Not", "'0532"],
        ["Tarih", "2026-09-28"],
      ],
    });
    expect(table(xlsxToMarkdown(block.bytes))).toEqual(
      expect.arrayContaining(["| 6 | Not | 0532 |  |  |", "| 7 | Tarih | 2026-09-28 |  |  |"]),
    );
  });

  it("aralığa verilen tek formül doldurma gibi kayar; Türkçe yazım çevrilir", () => {
    const r = edit(quote(), { action: "set", range: "E2:E4", value: "=YUVARLA(D2*0,18;0)" });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("- E2:E4: `=ROUND(D2*0.18,0)`");
    expect(md).toContain("| 4 | C | 3 | 30 | 90 | 16 |");
  });

  it("clear değer ve formülü siler, biçim kalır", () => {
    const r = edit(quote(), { action: "clear", range: "D2:D3" });
    expect(r.counts).toEqual({ clear: 2 });
    expect(xlsxToMarkdown(r.bytes)).toContain("| 5 | Toplam |  |  | 90 |");
  });

  it("aralık dışı değer, bilinmeyen sayfa ve geçersiz aralık anlaşılır hata verir; hiçbiri yazılmaz", () => {
    expect(() => edit(quote(), { action: "set", range: "A1:B1", values: [[1, 2, 3]] })).toThrow(
      "1. düzenleme (set) uygulanamadı: values 1 satır × 3 sütun ama aralık 1 × 2.",
    );
    expect(() => edit(quote(), { action: "set", range: "Yok!A1", value: 1 })).toThrow(
      '"Yok" adlı sayfa yok (sayfalar: Teklif, Özet)',
    );
    expect(() =>
      edit(quote(), { action: "set", range: "A1", value: 1 }, { action: "set", range: "A0" }),
    ).toThrow(/^2\. düzenleme \(set\) uygulanamadı: geçersiz aralık: A0/);
  });
});

describe("satır ve sütun", () => {
  it("araya satır: toplam aralığı büyür, alttaki formüller ve başka sayfanın başvurusu kayar", () => {
    const r = edit(quote(), {
      action: "row_insert",
      range: "4",
      values: [["D", 4, 40, "=B4*C4"]],
    });
    expect(r.counts).toEqual({ row_insert: 1 });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("| 4 | D | 4 | 40 | 160 |");
    expect(md).toContain("| 5 | C | 3 | 30 | 90 |");
    expect(md).toContain("- D6: `=SUM(D2:D5)`");
    expect(md).toContain("| 6 | Toplam |  |  | 300 |");
    expect(md).toContain("- B1: `=Teklif!D6*1.2`");
  });

  it("satır silme: silinen hücreye bakan formül #REF! olur ve uyarılır", () => {
    const base = buildXlsx([{ name: "S", rows: [[1], [2], ["=A2*2"], ["=SUM(A1:A2)"]] }], {
      now,
    }).bytes;
    const r = edit(base, { action: "row_delete", range: "2" });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("- A2: `=#REF!*2`");
    expect(md).toContain("- A3: `=SUM(A1:A1)`");
    expect(formulaWarnings(r.recalc)).toEqual(["S!A2 formülü hata veriyor: #REF! (=#REF!*2)"]);
  });

  it("dosyada zaten hata veren formül yeni uyarı sayılmaz, kayınca da", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: data(row(1, n("A1", 0)), row(2, '<c r="A2" t="e"><f>1/A1</f><v>#DIV/0!</v></c>')),
        },
      ],
    });
    const r = edit(bytes, { action: "row_insert", range: "1" });
    expect(r.recalc.errors).toEqual([]);
    const fresh = edit(bytes, { action: "set", range: "B1", value: "=1/A1" });
    expect(fresh.recalc.errors.map((e) => e.ref)).toEqual(["B1"]);
  });

  it("sütun ekleme ve silme formül, birleşim ve genişliği kaydırır", () => {
    const base = buildXlsx(
      [
        {
          name: "S",
          rows: [
            ["Başlık", null, null],
            [1, 2, "=A2+B2"],
          ],
          merge: ["A1:C1"],
          columns: [{ width: 10 }, { width: 20 }, { width: 30 }],
          header: false,
        },
      ],
      { now },
    ).bytes;
    const inserted = edit(base, { action: "col_insert", range: "B" });
    const md = xlsxToMarkdown(inserted.bytes);
    expect(md).toContain("- D2: `=A2+C2`");
    expect(md).toContain("**Birleşik hücreler:** A1:D1");
    expect(part(inserted.bytes, "xl/worksheets/sheet1.xml")).toMatch(
      /<col min="3" max="3" width="20"/,
    );
    const deleted = edit(base, { action: "col_delete", range: "A:B" });
    expect(xlsxToMarkdown(deleted.bytes)).toContain("- A2: `=#REF!+#REF!`");
  });

  it("paylaşılan formül kaydırmadan önce hücrelere açılır", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: data(
            row(1, n("A1", 1), '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c>'),
            row(2, n("A2", 2), '<c r="B2"><f t="shared" si="0"/><v>4</v></c>'),
            row(3, n("A3", 3), '<c r="B3"><f t="shared" si="0"/><v>6</v></c>'),
          ),
        },
      ],
    });
    const r = edit(bytes, { action: "row_insert", range: "2" });
    const sheet = part(r.bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain('t="shared"');
    expect(xlsxToMarkdown(r.bytes)).toContain("- B3:B4: `=A3*2`");
  });

  it("dizi formülünün bir kısmı yazılamaz; önbelleği yeniden hesapta korunur", () => {
    const bytes = buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: data(
            row(1, n("A1", 1), '<c r="B1"><f t="array" ref="B1:B2">A1:A2*2</f><v>2</v></c>'),
            row(2, n("A2", 2), n("B2", 4)),
          ),
        },
      ],
    });
    expect(() => edit(bytes, { action: "set", range: "B2", value: 1 })).toThrow(
      /B1:B2 dizi formülünün bir kısmı değiştirilemez/,
    );
    const r = edit(bytes, { action: "set", range: "C1", value: 5 });
    expect(xlsxToMarkdown(r.bytes)).toContain("| 2 | 2 | 4 |  |");
    expect(r.recalc.pending).toBe(0);
  });
});

describe("tablo, grafik, not ve çizim", () => {
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const withParts = () =>
    buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: `${data(
            row(1, str("A1", "Ad"), str("B1", "Tutar")),
            row(2, str("A2", "x"), n("B2", 1)),
            row(3, str("A3", "y"), n("B3", 2)),
          )}<drawing r:id="rId3"/><legacyDrawing r:id="rId4"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts>`,
          rels: {
            rId1: ["table", "../tables/table1.xml"],
            rId2: ["comments", "../comments1.xml"],
            rId3: ["drawing", "../drawings/drawing1.xml"],
            rId4: ["vmlDrawing", "../drawings/vmlDrawing1.vml"],
          },
        },
      ],
      calcChain: true,
      parts: {
        "xl/tables/table1.xml": `<table xmlns="${MAIN}" id="1" name="T" displayName="T" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Ad"/><tableColumn id="2" name="Tutar"/></tableColumns></table>`,
        "xl/comments1.xml": `<comments xmlns="${MAIN}"><authors><author>E</author></authors><commentList><comment ref="B3" authorId="0"><text><t>not</t></text></comment></commentList></comments>`,
        "xl/drawings/drawing1.xml":
          '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to></xdr:twoCellAnchor></xdr:wsDr>',
        "xl/drawings/vmlDrawing1.vml":
          '<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><x:ClientData ObjectType="Note"><x:Row>2</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>',
        "xl/charts/chart1.xml":
          '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:val><c:numRef><c:f>S!$B$2:$B$3</c:f></c:numRef></c:val></c:chartSpace>',
      },
    });

  it("append tabloyu ve filtresini büyütür, hesap zincirini kaldırır", () => {
    const r = edit(withParts(), { action: "append", values: [["z", 3]] });
    const t = part(r.bytes, "xl/tables/table1.xml");
    expect(t).toContain('ref="A1:B4"');
    expect(t).toContain('<autoFilter ref="A1:B4"/>');
    const zip = ZipArchive.open(r.bytes);
    expect(zip.has("xl/calcChain.xml")).toBe(false);
    expect(zip.readText("[Content_Types].xml")).not.toContain("calcChain");
    expect(zip.readText("xl/_rels/workbook.xml.rels")).not.toContain("calcChain");
    expect(zip.readText("xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
  });

  it("satır ekleme tabloyu, notu, VML kutusunu, çizimi ve grafik serisini kaydırır", () => {
    const r = edit(withParts(), { action: "row_insert", range: "3", count: 2 });
    expect(part(r.bytes, "xl/tables/table1.xml")).toContain('ref="A1:B5"');
    expect(part(r.bytes, "xl/comments1.xml")).toContain('ref="B5"');
    expect(part(r.bytes, "xl/drawings/vmlDrawing1.vml")).toContain("<x:Row>4</x:Row>");
    const drawing = part(r.bytes, "xl/drawings/drawing1.xml");
    expect(drawing).toContain("<xdr:row>4</xdr:row>");
    expect(drawing).toContain("<xdr:row>14</xdr:row>");
    expect(part(r.bytes, "xl/charts/chart1.xml")).toContain("<c:f>S!$B$2:$B$5</c:f>");
  });

  it("tablonun başlık satırı silinemez; tümüyle silinen tablo kalkar", () => {
    expect(() => edit(withParts(), { action: "row_delete", range: "1" })).toThrow(
      "T tablosunun başlık satırı silinemez",
    );
    const r = edit(withParts(), { action: "row_delete", range: "1:3" });
    const zip = ZipArchive.open(r.bytes);
    expect(zip.has("xl/tables/table1.xml")).toBe(false);
    expect(zip.readText("xl/worksheets/sheet1.xml")).not.toContain("tablePart");
  });

  it("tabloya sütun eklenince başlık adı verilir", () => {
    const r = edit(withParts(), { action: "col_insert", range: "B" });
    const t = part(r.bytes, "xl/tables/table1.xml");
    expect(t).toContain('ref="A1:C3"');
    expect(t).toContain('<tableColumns count="3">');
    expect(t).toMatch(/name="Sütun\d*"/);
  });
});

describe("birleştirme ve biçim", () => {
  it("merge/unmerge; çakışan birleşim reddedilir", () => {
    const merged = edit(quote(), { action: "merge", range: "A1:B1" });
    expect(xlsxToMarkdown(merged.bytes)).toContain("**Birleşik hücreler:** A1:B1");
    expect(() => edit(merged.bytes, { action: "merge", range: "B1:C1" })).toThrow(
      /var olan birleşimle çakışıyor: A1:B1/,
    );
    const split = edit(merged.bytes, { action: "unmerge", range: "A1" });
    expect(split.counts).toEqual({ unmerge: 1 });
    expect(xlsxToMarkdown(split.bytes)).not.toContain("Birleşik hücreler");
  });

  it("sayı biçimi, kalın, dolgu ve sütun genişliği", () => {
    const r = edit(quote(), {
      action: "format",
      range: "D2:D5",
      numberFormat: "#,##0.00 ₺",
      bold: true,
      fill: "FFF2CC",
      width: 18,
    });
    expect(r.counts).toEqual({ format: 4 });
    expect(xlsxToMarkdown(r.bytes)).toContain("| 5 | Toplam |  |  | 140.00 ₺ |");
    const styles = part(r.bytes, "xl/styles.xml");
    expect(styles).toContain('formatCode="#,##0.00 ₺"');
    expect(styles).toContain('rgb="FFFFF2CC"');
    expect(part(r.bytes, "xl/worksheets/sheet1.xml")).toMatch(/<col min="4" max="4" width="18"/);
    expect(() => edit(quote(), { action: "format", range: "A1" })).toThrow(/en az bir biçim alanı/);
  });
});

describe("sayfa işlemleri", () => {
  it("adlandırma başka sayfadaki formülü günceller", () => {
    const r = edit(quote(), { action: "sheet_rename", sheet: "Teklif", name: "Teklif 2026" });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("## Sayfa 1: Teklif 2026");
    expect(md).toContain("- B1: `='Teklif 2026'!D5*1.2`");
    expect(() => edit(quote(), { action: "sheet_rename", sheet: "Teklif", name: "özet" })).toThrow(
      /"özet" adlı bir sayfa zaten var/,
    );
  });

  it("ekleme verilen satırlarla yeni sayfa açar; silme başvuruları #REF! yapar", () => {
    const added = edit(quote(), {
      action: "sheet_add",
      name: "Notlar",
      values: [["Başlık"], ["=Teklif!D5"]],
    });
    const md = xlsxToMarkdown(added.bytes);
    expect(md).toContain("## Sayfa 3: Notlar");
    expect(md).toContain("| 2 | 140 |");
    expect(part(added.bytes, "[Content_Types].xml")).toContain("/xl/worksheets/sheet3.xml");

    const removed = edit(quote(), { action: "sheet_delete", sheet: "Teklif" });
    const after = xlsxToMarkdown(removed.bytes);
    expect(after).not.toContain("Teklif\n");
    expect(after).toContain("- B1: `=#REF!*1.2`");
    const zip = ZipArchive.open(removed.bytes);
    expect(zip.has("xl/worksheets/sheet1.xml")).toBe(false);
    expect(() => edit(removed.bytes, { action: "sheet_delete", sheet: "Özet" })).toThrow(
      "kitabın son görünür sayfası silinemez",
    );
  });
});

describe("hedef yol", () => {
  it("output uzantısızsa kaynağın uzantısı eklenir; göreli yol kaynağın klasörüne göre", () => {
    expect(resolveXlsxEditTarget("/a/b.xlsx", undefined, "/x")).toEqual({
      source: "/a/b.xlsx",
      target: "/a/b.xlsx",
    });
    expect(resolveXlsxEditTarget("/a/b.xlsm", "c", "/x").target).toBe("/a/c.xlsm");
    expect(resolveXlsxEditTarget("b.xlsx", "out/c.xlsx", "/x").target).toBe("/x/out/c.xlsx");
  });
});

describe("xlsx_edit aracı", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xlsx-edit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (params: Record<string, unknown>) =>
    xlsxEditTool({ lang: "tr", cwd: dir }).execute(
      "t1",
      params as never,
      undefined,
      undefined,
      undefined as never,
    );

  it("yerinde düzenler, özet ve fark döner", async () => {
    const path = join(dir, "teklif.xlsx");
    await writeFile(path, quote());
    const result = await run({
      path: "teklif.xlsx",
      edits: [{ action: "set", range: "B2", value: 5 }],
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toBe(`Excel kitabı güncellendi: ${path} (1 hücre yazıldı)`);
    expect(result.details.diff).toContain("| 2 | A | 5 | 10 | 50 |");
    expect(xlsxToMarkdown(await readFile(path))).toContain("| 5 | Toplam |  |  | 180 |");
  });

  it("output ile kaynağa dokunmaz; hatalı düzenlemede dosya yazılmaz", async () => {
    const path = join(dir, "teklif.xlsx");
    const original = quote();
    await writeFile(path, original);
    await run({
      path,
      output: "teklif-v2",
      edits: [{ action: "row_insert", range: "2" }],
    });
    expect(Buffer.compare(await readFile(path), original)).toBe(0);
    expect(xlsxToMarkdown(await readFile(join(dir, "teklif-v2.xlsx")))).toContain(
      "- D6: `=SUM(D3:D5)`",
    );
    await expect(run({ path, edits: [{ action: "merge", range: "A1" }] })).rejects.toThrow(
      /birleştirmek için en az iki hücrelik aralık ver/,
    );
    expect(Buffer.compare(await readFile(path), original)).toBe(0);
    await expect(
      run({ path: "yok.xlsx", edits: [{ action: "clear", range: "A1" }] }),
    ).rejects.toThrow(/Düzenlenecek dosya bulunamadı/);
    await expect(run({ path: "a.xls", edits: [{ action: "clear", range: "A1" }] })).rejects.toThrow(
      /yalnız \.xlsx\/\.xlsm/,
    );
  });
});

describe("tablo kaldırma", () => {
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const TABLE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";
  /** S!A1:C4 tablosu (başlık + 2 veri + toplam satırı), Özet sayfası ve tanımlı ad ona bakar. */
  const book = (extra: Record<string, string> = {}) =>
    buildXlsxFixture({
      sheets: [
        {
          name: "S",
          body: `${data(
            row(1, str("A1", "Ad"), str("B1", "Tutar"), str("C1", "KDV")),
            row(2, str("A2", "x"), n("B2", 10), fx("C2", "T[[#This Row],[Tutar]]*0.2", 2)),
            row(3, str("A3", "y"), n("B3", 20), fx("C3", "T[[#This Row],[Tutar]]*0.2", 4)),
            row(4, str("A4", "Toplam"), fx("B4", "SUBTOTAL(109,T[Tutar])", 30)),
          )}<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`,
          rels: { rId1: ["table", "../tables/table1.xml"] },
        },
        {
          name: "Özet",
          body: data(
            row(1, fx("A1", "SUM(T[Tutar])", 30), fx("B1", "ROWS(T[#All])", 4)),
            row(
              2,
              fx("A2", 'COUNTIF(T[Ad],"x")', 1),
              fx("B2", "SUM(T[[#Headers],[#Data],[KDV]])", 6),
            ),
          ),
        },
      ],
      definedNames: '<definedName name="Toplam">SUM(T[[Tutar]:[KDV]])</definedName>',
      types: { "xl/tables/table1.xml": TABLE },
      parts: {
        "xl/tables/table1.xml": `<table xmlns="${MAIN}" id="1" name="T" displayName="T" ref="A1:C4" totalsRowCount="1"><autoFilter ref="A1:C3"/><tableColumns count="3"><tableColumn id="1" name="Ad"/><tableColumn id="2" name="Tutar" totalsRowFunction="sum"/><tableColumn id="3" name="KDV"><calculatedColumnFormula>T[[#This Row],[Tutar]]*0.2</calculatedColumnFormula></tableColumn></tableColumns></table>`,
        ...extra,
      },
    });

  it("aralığa dönüştürür: değerler kalır, başvurular A1 olur, parça ve ilişki kalkar", () => {
    const r = edit(book(), { action: "table_remove", name: "t" });
    expect(r.counts).toEqual({ table_remove: 1 });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).not.toContain("**Tablolar:**");
    expect(md).toContain("- C2:C3: `=B2*0.2`");
    expect(md).toContain("- B4: `=SUBTOTAL(109,$B$2:$B$3)`");
    expect(md).toContain("- A1: `=SUM(S!$B$2:$B$3)`");
    expect(md).toContain("- B1: `=ROWS(S!$A$1:$C$4)`");
    expect(md).toContain('- A2: `=COUNTIF(S!$A$2:$A$3,"x")`');
    expect(md).toContain("- B2: `=SUM(S!$C$1:$C$3)`");
    expect(md).toContain("| 1 | 30 | 4 |");
    expect(part(r.bytes, "xl/workbook.xml")).toContain("SUM(S!$B$2:$C$3)");
    const zip = ZipArchive.open(r.bytes);
    expect(zip.has("xl/tables/table1.xml")).toBe(false);
    expect(zip.readText("[Content_Types].xml")).not.toContain("table1.xml");
    expect(zip.readText("xl/worksheets/_rels/sheet1.xml.rels")).not.toContain("table1.xml");
    expect(zip.readText("xl/worksheets/sheet1.xml")).not.toContain("tablePart");
  });

  it("hücreyle de seçilir; olmayan tablo ve tablo dışı hücre anlaşılır hata verir", () => {
    expect(edit(book(), { action: "table_remove", range: "S!B3" }).counts).toEqual({
      table_remove: 1,
    });
    expect(() => edit(book(), { action: "table_remove", name: "Yok" })).toThrow(
      '"Yok" adlı tablo yok (tablolar: T)',
    );
    expect(() => edit(book(), { action: "table_remove", range: "Özet!A1" })).toThrow(
      "Özet!A1 hücresi bir tablonun içinde değil",
    );
  });

  it("pivot kaynağı tablo adı yerine aralığı alır; dilimleyicili tablo kaldırılmaz", () => {
    const pivot = edit(
      book({
        "xl/pivotCache/pivotCacheDefinition1.xml": `<pivotCacheDefinition xmlns="${MAIN}"><cacheSource type="worksheet"><worksheetSource name="T"/></cacheSource></pivotCacheDefinition>`,
      }),
      { action: "table_remove", name: "T" },
    );
    expect(part(pivot.bytes, "xl/pivotCache/pivotCacheDefinition1.xml")).toContain(
      '<worksheetSource ref="A1:C4" sheet="S"/>',
    );
    const sliced = book({
      "xl/slicerCaches/slicerCache1.xml":
        '<slicerCacheDefinition xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:tableSlicerCache tableId="1" column="1"/></slicerCacheDefinition>',
    });
    expect(() => edit(sliced, { action: "table_remove", name: "T" })).toThrow(
      /bağlı dilimleyici var/,
    );
  });

  it("tablolu sayfa silinince tablo da gider, başka sayfadaki başvuru #REF! olur", () => {
    const r = edit(book(), { action: "sheet_delete", sheet: "S" });
    const md = xlsxToMarkdown(r.bytes);
    expect(md).toContain("- A1: `=SUM(#REF!)`");
    const zip = ZipArchive.open(r.bytes);
    expect(zip.has("xl/tables/table1.xml")).toBe(false);
    expect(zip.readText("[Content_Types].xml")).not.toContain("table1.xml");
    expect(zip.readText("xl/workbook.xml")).toContain("SUM(#REF!)");
  });

  it("satırları silinen tabloya bakan formül #REF! olur", () => {
    const r = edit(book(), { action: "row_delete", range: "S!1:4" });
    expect(xlsxToMarkdown(r.bytes)).toContain("- A1: `=SUM(#REF!)`");
    expect(ZipArchive.open(r.bytes).has("xl/tables/table1.xml")).toBe(false);
  });
});
