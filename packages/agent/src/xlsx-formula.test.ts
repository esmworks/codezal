import { describe, expect, it } from "vitest";
import {
  colIndex,
  colLetters,
  collectRefs,
  parseRange,
  quoteSheet,
  renameSheetInFormula,
  replaceTableRefs,
  shiftFormula,
  shiftRangeText,
  translateFormula,
} from "./xlsx-formula.js";

const rows = (at: number, count: number) => ({ sheet: "Sayfa1", axis: "row" as const, at, count });
const cols = (at: number, count: number) => ({ sheet: "Sayfa1", axis: "col" as const, at, count });

describe("adresler", () => {
  it("sütun harfi ↔ sıra", () => {
    expect(colIndex("A")).toBe(1);
    expect(colIndex("Z")).toBe(26);
    expect(colIndex("AA")).toBe(27);
    expect(colIndex("XFD")).toBe(16384);
    expect(colLetters(28)).toBe("AB");
    expect(colLetters(16384)).toBe("XFD");
  });

  it("aralık köşeleri sıralanır; geçersiz aralık tanınmaz", () => {
    expect(parseRange("C3:A1")).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
    expect(parseRange("B2")).toEqual({ top: 2, left: 2, bottom: 2, right: 2 });
    expect(parseRange("A0")).toBeUndefined();
    expect(parseRange("XFE1")).toBeUndefined();
    expect(parseRange("A1:B2:C3")).toBeUndefined();
  });

  it("sayfa adı gerektiğinde tırnaklanır", () => {
    expect(quoteSheet("Teklif")).toBe("Teklif");
    expect(quoteSheet("Özet_2026")).toBe("Özet_2026");
    expect(quoteSheet("Teklif 2026")).toBe("'Teklif 2026'");
    expect(quoteSheet("Ali'nin")).toBe("'Ali''nin'");
    expect(quoteSheet("AB12")).toBe("'AB12'");
  });
});

describe("başvuru taraması", () => {
  it("işlev adı, metin sabiti, tablo ve dış kitap başvuru sayılmaz", () => {
    const refs = collectRefs("LOG10(A1)+SUM(B2:C3)&\"D4\"+Tbl1[Adet]+[1]Sayfa!E5+'Ali''nin'!F6");
    expect(refs).toHaveLength(3);
    expect(refs[2]).toMatchObject({ sheet: "Ali'nin", a: { col: 6, row: 6 } });
  });

  it("tüm sütun ve tüm satır aralıkları", () => {
    expect(collectRefs("SUM(A:A)+SUM($2:$3)")).toMatchObject([
      { a: { col: 1 }, b: { col: 1 } },
      { a: { row: 2, rowAbs: true }, b: { row: 3, rowAbs: true } },
    ]);
  });

  it("bilimsel sayı ve ondalık başvuru sanılmaz", () => {
    expect(collectRefs("1.5E+3*A1+2E3")).toHaveLength(1);
  });
});

describe("paylaşılan formül çevirisi", () => {
  it("göreli uçlar kayar, $ sabit kalır", () => {
    expect(translateFormula("B2*$L$2-B$2+$C2", 3, 1)).toBe("C5*$L$2-C$2+$C5");
  });

  it("sınır dışına düşen başvuru #REF! olur", () => {
    expect(translateFormula("A2+1", -2, 0)).toBe("#REF!+1");
  });

  it("sayfa adı ve tırnağı korunur", () => {
    expect(translateFormula("'Teklif 2026'!A1*2", 1, 0)).toBe("'Teklif 2026'!A2*2");
  });
});

describe("satır/sütun kaydırma", () => {
  it("ekleme: aralık içine düşerse büyür, sınırın hemen altındaysa büyümez", () => {
    expect(shiftFormula("SUM(D2:D4)", "Sayfa1", rows(4, 1))).toBe("SUM(D2:D5)");
    expect(shiftFormula("SUM(D2:D4)", "Sayfa1", rows(5, 1))).toBe("SUM(D2:D4)");
    expect(shiftFormula("SUM(D2:D4)", "Sayfa1", rows(2, 2))).toBe("SUM(D4:D6)");
    expect(shiftFormula("$A$10", "Sayfa1", rows(3, 1))).toBe("$A$11");
  });

  it("silme: tek hücre #REF!, aralık daralır, tümü silinirse #REF!", () => {
    expect(shiftFormula("A3+A5", "Sayfa1", rows(3, -1))).toBe("#REF!+A4");
    expect(shiftFormula("SUM(A2:A6)", "Sayfa1", rows(3, -2))).toBe("SUM(A2:A4)");
    expect(shiftFormula("SUM(A2:A6)", "Sayfa1", rows(1, -3))).toBe("SUM(A1:A3)");
    expect(shiftFormula("SUM(A3:A4)", "Sayfa1", rows(3, -2))).toBe("SUM(#REF!)");
  });

  it("başka sayfaya bakan başvuru yalnız o sayfa değişince kayar", () => {
    expect(shiftFormula("A5+Özet!A5", "Özet", rows(2, 1))).toBe("A5+Özet!A5");
    expect(shiftFormula("A5+Sayfa1!A5", "Özet", rows(2, 1))).toBe("A5+Sayfa1!A6");
    // Sayfa adı büyük/küçük harf duyarsız eşleşir; yazım olduğu gibi kalır.
    expect(shiftFormula("A5+sayfa1!A5", "Özet", rows(2, 1))).toBe("A5+sayfa1!A6");
  });

  it("sütun ekle/sil; tüm sütun aralığı satır işleminde değişmez", () => {
    expect(shiftFormula("B1*C1+SUM(A:C)", "Sayfa1", cols(2, 1))).toBe("C1*D1+SUM(A:D)");
    expect(shiftFormula("SUM(A:C)", "Sayfa1", rows(1, 5))).toBe("SUM(A:C)");
    expect(shiftFormula("B1*C1", "Sayfa1", cols(2, -1))).toBe("#REF!*B1");
  });

  it("sayfa sınırını aşan uç sınıra kırpılır", () => {
    expect(shiftFormula("SUM(A1:A1048576)", "Sayfa1", rows(5, 2))).toBe("SUM(A1:A1048576)");
  });

  it("sqref: silinen parça atılır, hepsi silinince undefined", () => {
    expect(shiftRangeText("A1:B2 D5", rows(5, -1))).toBe("A1:B2");
    expect(shiftRangeText("D5", rows(5, -1))).toBeUndefined();
    expect(shiftRangeText("A2:C4", rows(3, 1))).toBe("A2:C5");
  });
});

describe("sayfa adı değişimi", () => {
  it("adlandırma başvuruyu günceller, silme #REF! yapar", () => {
    expect(renameSheetInFormula("Teklif!A1+teklif!B2", "Teklif", "Teklif 2026")).toBe(
      "'Teklif 2026'!A1+'Teklif 2026'!B2",
    );
    expect(renameSheetInFormula("Teklif!A1+A1", "Teklif", undefined)).toBe("#REF!+A1");
    expect(renameSheetInFormula('"Teklif!A1"&Teklif2!A1', "Teklif", "X")).toBe(
      '"Teklif!A1"&Teklif2!A1',
    );
  });
});

describe("yapılandırılmış başvuru", () => {
  const table = {
    name: "Satış",
    sheet: "Veri 1",
    range: { top: 3, left: 2, bottom: 10, right: 5 },
    header: true,
    totals: true,
    columns: ["Ürün", "Adet", "Fiyat [TL]", "Tutar"],
  };
  const at = { sheet: "Veri 1", row: 5 };

  it("sütun, alan ve aynı satır; başka sayfadan sayfa adıyla", () => {
    expect(replaceTableRefs("SUM(Satış[Adet])", table, at)).toBe("SUM($C$4:$C$9)");
    expect(replaceTableRefs("satış[#All]", table, at)).toBe("$B$3:$E$10");
    expect(replaceTableRefs("Satış[]", table, at)).toBe("$B$4:$E$9");
    expect(replaceTableRefs("Satış[#Headers]", table, at)).toBe("$B$3:$E$3");
    expect(replaceTableRefs("Satış[[#Totals],[Tutar]]", table, at)).toBe("$E$10");
    expect(replaceTableRefs("Satış[[#Data],[#Totals],[Adet]:[Tutar]]", table, at)).toBe(
      "$C$4:$E$10",
    );
    expect(replaceTableRefs("Satış[[#This Row],[Adet]]*2", table, at)).toBe("C5*2");
    expect(replaceTableRefs("Satış[@Adet]+Satış[@[Fiyat '[TL']]]", table, at)).toBe("C5+D5");
    expect(replaceTableRefs("SUM(Satış[Tutar])", table, { sheet: "Özet" })).toBe(
      "SUM('Veri 1'!$E$4:$E$9)",
    );
  });

  it("çözülemeyen başvuru #REF!; metin, başka tablo ve benzer ad dokunulmaz", () => {
    expect(replaceTableRefs("Satış[Yok]", table, at)).toBe("#REF!");
    expect(replaceTableRefs("Satış[@Adet]", table)).toBe("#REF!");
    expect(replaceTableRefs("Satış[@Adet]", table, { sheet: "Veri 1", row: 3 })).toBe("#REF!");
    expect(
      replaceTableRefs('"Satış[Adet]"&Satış2[Adet]&xSatış[Adet]&SUM(Satış[Adet])', table, at),
    ).toBe('"Satış[Adet]"&Satış2[Adet]&xSatış[Adet]&SUM($C$4:$C$9)');
  });
});
