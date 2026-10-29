import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipArchive } from "./ooxml.js";
import { xlsxToMarkdown } from "./xlsx.js";
import { buildXlsx, cleanSheetName, formulaWarnings, sheetNameProblem } from "./xlsx-build.js";
import { xlsxCreateTool } from "./xlsx-create.js";
import { normalizeFormula, parseInput } from "./xlsx-write.js";

const now = new Date("2026-09-28T09:00:00Z");
const part = (bytes: Buffer, name: string) => ZipArchive.open(bytes).readText(name) ?? "";

describe("hücre girdisi", () => {
  it("sayı, yüzde, tarih, mantıksal; baştaki sıfır ve kesme işareti metin kalır", () => {
    expect(parseInput("12.5")).toEqual({ kind: "number", value: 12.5 });
    expect(parseInput("12,5%")).toEqual({ kind: "string", value: "12,5%" });
    expect(parseInput("12.5%")).toEqual({ kind: "number", value: 0.125, format: "0.0%" });
    expect(parseInput("0532")).toEqual({ kind: "string", value: "0532" });
    expect(parseInput("1234567890123456")).toEqual({ kind: "string", value: "1234567890123456" });
    expect(parseInput("'=A1")).toEqual({ kind: "string", value: "=A1" });
    expect(parseInput("2026-09-28")).toEqual({ kind: "date", value: 46293, time: false });
    expect(parseInput("2026-02-30")).toEqual({ kind: "string", value: "2026-02-30" });
    expect(parseInput("TRUE")).toEqual({ kind: "bool", value: true });
    expect(parseInput("")).toEqual({ kind: "empty" });
  });

  it("Türkçe formül: işlev adı, noktalı virgül ve ondalık virgül çevrilir; metin korunur", () => {
    expect(normalizeFormula("=TOPLA(A1:A3;B1)*1,5")).toBe("SUM(A1:A3,B1)*1.5");
    expect(normalizeFormula('EĞER(A1>0;"a;b,c";YUVARLA(B1;2))')).toBe(
      'IF(A1>0,"a;b,c",ROUND(B1,2))',
    );
    expect(normalizeFormula("'Sayfa;1'!A1+DÜŞEYARA(A1;B:C;2;0)")).toBe(
      "'Sayfa;1'!A1+VLOOKUP(A1,B:C,2,0)",
    );
    // İngilizce yazılmış formül değişmez; yeni işlevler dosyadaki önekiyle yazılır.
    expect(normalizeFormula("SUM(A1,B1)")).toBe("SUM(A1,B1)");
    expect(normalizeFormula("XLOOKUP(A1,B:B,C:C)")).toBe("_xlfn.XLOOKUP(A1,B:B,C:C)");
  });
});

describe("sayfa adı", () => {
  it("yasak karakter, uzunluk ve tekrar", () => {
    expect(sheetNameProblem("a/b")).toBe("chars");
    expect(sheetNameProblem("x".repeat(32))).toBe("long");
    const used = new Set<string>();
    expect(cleanSheetName("Teklif", 0, used, "tr")).toBe("Teklif");
    expect(cleanSheetName("teklif", 1, used, "tr")).toBe("teklif (2)");
    expect(cleanSheetName("a:b?", 2, used, "tr")).toBe("a-b-");
    expect(cleanSheetName("  ", 3, used, "tr")).toBe("Sayfa4");
  });
});

describe("buildXlsx", () => {
  it("başlık, biçimler ve formül önbelleğiyle okunabilir kitap üretir", () => {
    const result = buildXlsx(
      [
        {
          name: "Teklif",
          rows: [
            ["Kalem", "Adet", "Birim fiyat", "Tutar", "Tarih"],
            ["Evaporatör", 2, 1250.5, "=B2*C2", "2026-09-28"],
            ["Kondenser", 1, 3400, "=B3*C3", "2026-10-01"],
            ["Toplam", null, null, "=TOPLA(D2:D3)", null],
          ],
          columns: [{}, {}, { format: "#,##0.00" }, { format: "#,##0.00" }],
          filter: true,
        },
      ],
      { lang: "tr", now },
    );
    expect(result.sheets).toEqual(["Teklif"]);
    expect(result.formulas).toBe(3);
    expect(result.recalc).toMatchObject({ computed: 3, pending: 0, errors: [] });
    const md = xlsxToMarkdown(result.bytes);
    expect(md).toContain("| 2 | Evaporatör | 2 | 1250.50 | 2501.00 | 2026-09-28 |");
    expect(md).toContain("| 4 | Toplam |  |  | 5901.00 |  |");
    expect(md).toContain("- D4: `=SUM(D2:D3)`");

    const sheet = part(result.bytes, "xl/worksheets/sheet1.xml");
    // Başlık varken ilk satır dondurulur ve filtrelenir.
    expect(sheet).toContain('topLeftCell="A2"');
    expect(sheet).toContain('<autoFilter ref="A1:E4"/>');
    expect(part(result.bytes, "xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
    expect(part(result.bytes, "xl/styles.xml")).toContain('formatCode="dd.mm.yyyy"');
  });

  it("hatalı formül ve aralıklar uyarı olur, kitap yine yazılır", () => {
    const result = buildXlsx(
      [
        {
          name: "S",
          rows: [
            [1, 0, "=A1/B1"],
            ["a", "b", "c"],
          ],
          header: false,
          merge: ["A2:B2", "B2:C2", "X"],
        },
      ],
      { now },
    );
    expect(result.warnings).toEqual([
      "başka bir birleşimle çakışan aralık atlandı: B2:C2",
      "geçersiz aralık atlandı: X (A1:C3 biçiminde olmalı)",
    ]);
    expect(formulaWarnings(result.recalc)).toEqual(["S!C1 formülü hata veriyor: #DIV/0! (=A1/B1)"]);
    expect(xlsxToMarkdown(result.bytes)).toContain("**Birleşik hücreler:** A2:B2");
  });

  it("desteklenmeyen işlevin değeri bekleyen sayılır", () => {
    const result = buildXlsx([{ name: "S", rows: [["=RAND()"]] }], { now });
    expect(result.recalc.pending).toBe(1);
  });

  it("sayfasız istek hata verir", () => {
    expect(() => buildXlsx([])).toThrow("En az bir sayfa gerekli.");
  });
});

describe("xlsx_create aracı", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xlsx-create-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uzantısız yola .xlsx ekler ve özet döner", async () => {
    const tool = xlsxCreateTool({ lang: "tr", cwd: dir, outputsDir: join(dir, "out") });
    const result = await tool.execute(
      "t1",
      {
        path: "rapor",
        sheets: [
          {
            name: "Özet",
            rows: [
              ["A", "B"],
              [1, "=A2*2"],
            ],
          },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(
      /^Excel kitabı yazıldı: .*rapor\.xlsx \(\d+ KB; 1 sayfa: Özet; 2 satır, 1 formül\)$/,
    );
    const bytes = await readFile(join(dir, "out", "rapor.xlsx"));
    expect(xlsxToMarkdown(bytes)).toContain("| 2 | 1 | 2 |");
  });
});
