import { describe, expect, it } from "vitest";
import {
  type CalcCell,
  type CalcWorkbook,
  calcKey,
  evaluateFormula,
  recalculate,
  type Scalar,
} from "./xlsx-calc.js";
import { parseAddress } from "./xlsx-formula.js";

/** Sayfa → adres → değer; "=" ile başlayan metin formüldür. */
type Input = Record<string, Record<string, Scalar>>;

interface BookOptions {
  names?: Record<string, string>;
  date1904?: boolean;
}

function makeBook(input: Input, opts: BookOptions = {}): CalcWorkbook {
  const data = new Map<string, Map<string, CalcCell>>();
  const extents = new Map<string, { rows: number; cols: number }>();
  for (const [sheet, cells] of Object.entries(input)) {
    const map = new Map<string, CalcCell>();
    let rows = 0;
    let cols = 0;
    for (const [addr, v] of Object.entries(cells)) {
      const pos = parseAddress(addr);
      if (!pos) throw new Error(`geçersiz adres ${addr}`);
      rows = Math.max(rows, pos.row);
      cols = Math.max(cols, pos.col);
      map.set(
        `${pos.row},${pos.col}`,
        typeof v === "string" && v.startsWith("=")
          ? { value: null, formula: v.slice(1) }
          : { value: v },
      );
    }
    data.set(sheet, map);
    extents.set(sheet, { rows, cols });
  }
  return {
    sheets: Object.keys(input),
    cell: (sheet, row, col) => data.get(sheet)?.get(`${row},${col}`),
    extent: (sheet) => extents.get(sheet) ?? { rows: 0, cols: 0 },
    ...(opts.names ? { names: new Map(Object.entries(opts.names)) } : {}),
    ...(opts.date1904 ? { date1904: true } : {}),
  };
}

const NOW = new Date(2024, 0, 15, 12, 0, 0);

/** Formülü ilk sayfanın `at` hücresindeymiş gibi hesaplar. */
function calc(formula: string, input: Input = { S: {} }, at = "Z100", opts: BookOptions = {}) {
  const book = makeBook(input, opts);
  const pos = parseAddress(at);
  const sheet = book.sheets[0];
  if (!pos || sheet === undefined) throw new Error("geçersiz konum");
  return evaluateFormula(book, sheet, pos.row, pos.col, formula, NOW);
}

function recalc(input: Input, opts: BookOptions = {}) {
  const out = recalculate(makeBook(input, opts), NOW);
  return (sheet: string, addr: string) => {
    const pos = parseAddress(addr);
    if (!pos) throw new Error("geçersiz adres");
    return out.get(calcKey(sheet, pos.row, pos.col));
  };
}

const e = (code: string) => ({ error: code });

describe("ayrıştırıcı ve öncelik", () => {
  it("işleç önceliği ve soldan birleşme", () => {
    expect(calc("1+2*3")).toBe(7);
    expect(calc("(1+2)*3")).toBe(9);
    expect(calc("10-2-3")).toBe(5);
    expect(calc("2^3^2")).toBe(64);
    expect(calc("2^-1")).toBe(0.5);
    expect(calc("1+2&3")).toBe("33");
    expect(calc("1+2=3")).toBe(true);
    expect(calc("2*3>5")).toBe(true);
  });

  it("tekli eksi ^'den önce bağlanır", () => {
    expect(calc("-2^2")).toBe(4);
    expect(calc("0-2^2")).toBe(-4);
    expect(calc("--3")).toBe(3);
    expect(calc("+-+2")).toBe(-2);
  });

  it("yüzde, bilimsel gösterim, boşluklar ve kaçışlı metin", () => {
    expect(calc("50%")).toBe(0.5);
    expect(calc("200*10%")).toBe(20);
    expect(calc("1.5E+3")).toBe(1500);
    expect(calc(".5*2")).toBe(1);
    expect(calc("  1 +\n 2  ")).toBe(3);
    expect(calc('"a""b"')).toBe('a"b');
    expect(calc('"a"&"b"="AB"')).toBe(true);
  });

  it("hata sabitleri, dizi sabiti ve boş argüman", () => {
    expect(calc("#N/A")).toEqual(e("#N/A"));
    expect(calc("#DIV/0!")).toEqual(e("#DIV/0!"));
    expect(calc("#REF!+1")).toEqual(e("#REF!"));
    expect(calc("SUM({1,2;3,4})")).toBe(10);
    expect(calc("SUM({-1,2.5})")).toBe(1.5);
    expect(calc("IF(TRUE,,1)")).toBe(0);
    expect(calc("IF(FALSE,1)")).toBe(false);
  });

  it("dizi taşması hesaplanmaz; tek hücreli dizi değer olur", () => {
    expect(calc("{1,2,3}")).toBeUndefined();
    expect(calc("{7}")).toBe(7);
    expect(calc("{1,2}*2")).toBeUndefined();
  });

  it("ayrıştırılamayan ya da desteklenmeyen sözdizimi undefined", () => {
    expect(calc("1+")).toBeUndefined();
    expect(calc("SUM(1")).toBeUndefined();
    expect(calc("SUM((A1,B1))", { S: { A1: 1, B1: 2 } })).toBeUndefined();
    expect(calc("SUM(A1:B2 B1:B3)", { S: { A1: 1 } })).toBeUndefined();
    expect(calc("SUM(Tablo1[Sütun])")).toBeUndefined();
    expect(calc("[1]Sayfa1!A1")).toBeUndefined();
    expect(calc("Sayfa1:Sayfa3!A1", { Sayfa1: {}, Sayfa3: {} })).toBeUndefined();
  });

  it("_xlfn. ve _xlws. önekleri atılır", () => {
    expect(calc("_xlfn.IFS(FALSE,1,TRUE,2)")).toBe(2);
    expect(calc('_xlfn.CONCAT("a","b")')).toBe("ab");
    expect(calc("_xlfn._xlws.FILTER(A1:A2,A1:A2>0)", { S: { A1: 1, A2: 2 } })).toBeUndefined();
  });
});

describe("zorlama ve karşılaştırma", () => {
  it("metin sayıya dönüşebiliyorsa aritmetikte dönüşür", () => {
    expect(calc('"3"+1')).toBe(4);
    expect(calc('" 2.5 "*2')).toBe(5);
    expect(calc('"50%"+0')).toBe(0.5);
    expect(calc('"1e3"+0')).toBe(1000);
    expect(calc('"abc"+1')).toEqual(e("#VALUE!"));
    expect(calc('""+1')).toEqual(e("#VALUE!"));
    expect(calc("TRUE+1")).toBe(2);
  });

  it("tarih/para gibi yerel ayara bağlı metin hesaplanmaz", () => {
    expect(calc('"1/1/2024"+0')).toBeUndefined();
    expect(calc('"1,234"+0')).toBeUndefined();
    expect(calc('"$5"+0')).toBeUndefined();
  });

  it("boş hücre aritmetikte 0, birleştirmede boş metin", () => {
    expect(calc("A1+1")).toBe(1);
    expect(calc('A1&"x"')).toBe("x");
    expect(calc("A1")).toBe(0);
  });

  it("sayıdan metne Genel biçim", () => {
    expect(calc('1/3&""')).toBe("0.333333333333333");
    expect(calc('12&"a"')).toBe("12a");
    expect(calc('-1.5&""')).toBe("-1.5");
    expect(calc('TRUE&""')).toBe("TRUE");
  });

  it("15 basamak: 0.1+0.2 = 0.3", () => {
    expect(calc("0.1+0.2")).toBe(0.3);
    expect(calc("0.1+0.2=0.3")).toBe(true);
    expect(calc("0.3-0.2-0.1")).toBeUndefined();
  });

  it("türler arası sıra ve büyük/küçük harf duyarsızlık", () => {
    expect(calc('1<"a"')).toBe(true);
    expect(calc('"z"<TRUE')).toBe(true);
    expect(calc("FALSE<TRUE")).toBe(true);
    expect(calc('"abc"="ABC"')).toBe(true);
    expect(calc('"a"<"b"')).toBe(true);
    expect(calc('"b"<>"B"')).toBe(false);
    expect(calc('"x-y"="X-Y"')).toBe(true);
    expect(calc('"x-y"="abc"')).toBe(false);
    expect(calc("-0*1")).toBe(0);
    expect(calc("2>10")).toBe(false);
  });

  it("boş hücre karşılaştırmada karşı tarafın boş değeri gibidir", () => {
    expect(calc("A1=0")).toBe(true);
    expect(calc('A1=""')).toBe(true);
    expect(calc("A1=FALSE")).toBe(true);
    expect(calc("A1<1")).toBe(true);
    expect(calc("A1=B1")).toBe(true);
  });
});

describe("hata yayılımı", () => {
  const input: Input = { S: { A1: { error: "#N/A" }, A2: 5, A3: "=1/0" } };

  it("hatalar işleçlerden ve işlevlerden yayılır", () => {
    expect(calc("1/0")).toEqual(e("#DIV/0!"));
    expect(calc("1/0+1")).toEqual(e("#DIV/0!"));
    expect(calc("A1*2", input)).toEqual(e("#N/A"));
    expect(calc("A3&A1", input)).toEqual(e("#DIV/0!"));
    expect(calc("SUM(A1:A2)", input)).toEqual(e("#N/A"));
    expect(calc("LEN(A1)", input)).toEqual(e("#N/A"));
    expect(calc("0^0")).toEqual(e("#NUM!"));
  });

  it("IFERROR/IFNA/ISERROR hatayı yakalar", () => {
    expect(calc('IFERROR(1/0,"x")')).toBe("x");
    expect(calc("IFERROR(A2,0)", input)).toBe(5);
    expect(calc("IFNA(NA(),1)")).toBe(1);
    expect(calc("IFNA(1/0,1)")).toEqual(e("#DIV/0!"));
    expect(calc("ISERROR(A3)", input)).toBe(true);
    expect(calc("ISNA(A1)", input)).toBe(true);
    expect(calc("ISNA(A3)", input)).toBe(false);
    expect(calc("COUNT(A1:A3)", input)).toBe(1);
  });
});

describe("toplama işlevleri", () => {
  const input: Input = { S: { A1: 1, A2: 2, A3: "3", A4: true, A6: 4, B1: 10, B2: 20 } };

  it("aralıktaki metin/mantıksal yok sayılır, doğrudan argüman sayılır", () => {
    expect(calc("SUM(A1:A6)", input)).toBe(7);
    expect(calc('SUM(A1:A6,"3",TRUE)', input)).toBe(11);
    expect(calc("SUM(A3)", input)).toBe(0);
    expect(calc('SUM("abc")')).toEqual(e("#VALUE!"));
    expect(calc("AVERAGE(A1:A6)", input)).toBeCloseTo(7 / 3, 12);
    expect(calc("MIN(A1:A6)", input)).toBe(1);
    expect(calc("MAX(A1:A6,10)", input)).toBe(10);
    expect(calc("MIN(C1:C3)", input)).toBe(0);
    expect(calc("AVERAGE(C1:C3)", input)).toEqual(e("#DIV/0!"));
  });

  it("COUNT, COUNTA, COUNTBLANK", () => {
    expect(calc("COUNT(A1:A6)", input)).toBe(3);
    expect(calc('COUNT(1,"2","x",TRUE)')).toBe(3);
    expect(calc("COUNTA(A1:A6)", input)).toBe(5);
    expect(calc("COUNTBLANK(A1:A6)", input)).toBe(1);
    expect(calc("COUNTBLANK(A1:B2)", { S: { A1: 1, B1: '=""' } })).toBe(3);
  });

  it("SUMPRODUCT öğe öğe çarpar; mantıksal 0 sayılır", () => {
    const d: Input = { S: { A1: "x", A2: "y", A3: "x", B1: 2, B2: 3, B3: 4 } };
    expect(calc("SUMPRODUCT(B1:B2,{10;20})", d)).toBe(80);
    expect(calc('SUMPRODUCT((A1:A3="x")*B1:B3)', d)).toBe(6);
    expect(calc('SUMPRODUCT(--(A1:A3="x"))', d)).toBe(2);
    expect(calc('SUMPRODUCT(A1:A3="x")', d)).toBe(0);
    expect(calc("SUMPRODUCT(B1:B3,B1:B2)", d)).toEqual(e("#VALUE!"));
    expect(calc("SUMPRODUCT(B1:B3*2)", d)).toBe(18);
  });

  it("tüm sütun ve tüm satır başvuruları dolu alanla sınırlanır", () => {
    const d: Input = { S: { A1: 1, A2: 2, A5: 3, C1: 4, D1: 5 } };
    expect(calc("SUM(A:A)", d, "F1")).toBe(6);
    expect(calc("SUM($A:$A,1:1)", d, "F2")).toBe(16);
    expect(calc("COUNTBLANK(A:A)", d, "F1")).toBe(1_048_576 - 3);
    expect(calc("ROWS(A:A)+COLUMNS(1:1)")).toBe(1_048_576 + 16_384);
  });
});

describe("matematik işlevleri", () => {
  it("ROUND ailesi yarıda sıfırdan uzağa ve kayan noktaya dayanıklı", () => {
    expect(calc("ROUND(2.675,2)")).toBe(2.68);
    expect(calc("ROUND(1.005,2)")).toBe(1.01);
    expect(calc("ROUND(-2.5,0)")).toBe(-3);
    expect(calc("ROUND(1234.5,-2)")).toBe(1200);
    expect(calc("ROUNDUP(1.23411,3)")).toBe(1.235);
    expect(calc("ROUNDUP(-3.1,0)")).toBe(-4);
    expect(calc("ROUNDDOWN(-3.9,0)")).toBe(-3);
    expect(calc("TRUNC(-3.5)")).toBe(-3);
    expect(calc("TRUNC(1.23999,2)")).toBe(1.23);
    expect(calc("INT(-3.5)")).toBe(-4);
  });

  it("temel işlevler", () => {
    expect(calc("ABS(-2)+SIGN(-3)")).toBe(1);
    expect(calc("MOD(-3,2)")).toBe(1);
    expect(calc("MOD(3,-2)")).toBe(-1);
    expect(calc("MOD(5,0)")).toEqual(e("#DIV/0!"));
    expect(calc("POWER(2,10)")).toBe(1024);
    expect(calc("SQRT(16)")).toBe(4);
    expect(calc("SQRT(-1)")).toEqual(e("#NUM!"));
    expect(calc("EXP(0)+LN(1)")).toBe(1);
    expect(calc("LN(0)")).toEqual(e("#NUM!"));
    expect(calc("LOG(8,2)")).toBe(3);
    expect(calc("LOG(100)")).toBe(2);
    expect(calc("LOG10(1000)")).toBe(3);
    expect(calc("PI()")).toBeCloseTo(Math.PI, 13);
  });

  it("klasik CEILING/FLOOR ve MROUND", () => {
    expect(calc("CEILING(2.5,1)")).toBe(3);
    expect(calc("CEILING(-2.5,-2)")).toBe(-4);
    expect(calc("CEILING(-2.5,2)")).toBe(-2);
    expect(calc("CEILING(1.5,0.1)")).toBe(1.5);
    expect(calc("CEILING(2.5,-1)")).toEqual(e("#NUM!"));
    expect(calc("FLOOR(3.7,2)")).toBe(2);
    expect(calc("FLOOR(-2.5,-2)")).toBe(-2);
    expect(calc("FLOOR(2.5,-2)")).toEqual(e("#NUM!"));
    expect(calc("FLOOR(1.58,0.1)")).toBe(1.5);
    expect(calc("MROUND(10,3)")).toBe(9);
    expect(calc("MROUND(-10,-3)")).toBe(-9);
    expect(calc("MROUND(1.3,0.2)")).toBe(1.4);
    expect(calc("MROUND(5,-2)")).toEqual(e("#NUM!"));
  });
});

describe("mantıksal işlevler", () => {
  it("IF, IFS, AND, OR, XOR, NOT", () => {
    expect(calc('IF(1>2,"a","b")')).toBe("b");
    expect(calc("IF(A1,1,2)")).toBe(2);
    expect(calc('IFS(1>2,"a",2>1,"b")')).toBe("b");
    expect(calc("IFS(FALSE,1)")).toEqual(e("#N/A"));
    expect(calc("AND(TRUE,1)")).toBe(true);
    expect(calc("AND(A1:A3)", { S: { A1: true, A2: "x", A3: 0 } })).toBe(false);
    expect(calc("AND(A1:A2)", { S: { A1: "x" } })).toEqual(e("#VALUE!"));
    expect(calc("OR(FALSE,0)")).toBe(false);
    expect(calc("XOR(TRUE,TRUE,TRUE)")).toBe(true);
    expect(calc("NOT(0)")).toBe(true);
    expect(calc("TRUE()")).toBe(true);
  });

  it("CHOOSE ve SWITCH", () => {
    expect(calc('CHOOSE(2,"a","b","c")')).toBe("b");
    expect(calc('CHOOSE(2.9,"a","b","c")')).toBe("b");
    expect(calc('CHOOSE(4,"a")')).toEqual(e("#VALUE!"));
    expect(calc('SWITCH(2,1,"a",2,"b","z")')).toBe("b");
    expect(calc('SWITCH(9,1,"a")')).toEqual(e("#N/A"));
    expect(calc('SWITCH(9,1,"a","z")')).toBe("z");
  });

  it("seçilmeyen dal hesaplanmaz", () => {
    expect(calc('IF(TRUE,1,INDIRECT("A1"))')).toBe(1);
    expect(calc("IF(FALSE,RAND(),2)")).toBe(2);
    expect(calc("IFERROR(1,RAND())")).toBe(1);
    expect(calc("IFS(TRUE,3,TRUE,RAND())")).toBe(3);
    expect(calc("CHOOSE(1,5,RAND())")).toBe(5);
    expect(calc("IF(TRUE,RAND(),1)")).toBeUndefined();
  });

  it("IS işlevleri", () => {
    const d: Input = { S: { B1: '=""', C1: 1 } };
    expect(calc("ISBLANK(A1)", d)).toBe(true);
    expect(calc("ISBLANK(B1)", d)).toBe(false);
    expect(calc('ISNUMBER("1")')).toBe(false);
    expect(calc("ISNUMBER(C1)", d)).toBe(true);
    expect(calc('ISTEXT("a")')).toBe(true);
    expect(calc("ISLOGICAL(FALSE)")).toBe(true);
  });
});

describe("metin işlevleri", () => {
  it("birleştirme", () => {
    expect(calc('CONCATENATE("a",1,TRUE)')).toBe("a1TRUE");
    expect(calc("CONCAT(A1:B2)", { S: { A1: "a", B1: 1, B2: "c" } })).toBe("a1c");
    expect(calc('TEXTJOIN("-",TRUE,A1:A3,"z")', { S: { A1: "x", A3: "y" } })).toBe("x-y-z");
    expect(calc('TEXTJOIN("-",FALSE,A1:A3)', { S: { A1: "x", A3: "y" } })).toBe("x--y");
  });

  it("parça alma ve uzunluk", () => {
    expect(calc('LEN("abc")')).toBe(3);
    expect(calc("LEN(123.5)")).toBe(5);
    expect(calc('LEFT("abcdef",2)')).toBe("ab");
    expect(calc('LEFT("abc")')).toBe("a");
    expect(calc('LEFT("abc",-1)')).toEqual(e("#VALUE!"));
    expect(calc('RIGHT("abcdef",2)')).toBe("ef");
    expect(calc('RIGHT("ab",5)')).toBe("ab");
    expect(calc('MID("abcdef",2,3)')).toBe("bcd");
    expect(calc('MID("abc",0,1)')).toEqual(e("#VALUE!"));
  });

  it("harf dönüşümü ve boşluk", () => {
    expect(calc('UPPER("abc")')).toBe("ABC");
    expect(calc('LOWER("ÇAĞ")')).toBe("çağ");
    expect(calc('PROPER("this is a TITLE")')).toBe("This Is A Title");
    expect(calc('PROPER("2-way street\'s")')).toBe("2-Way Street'S");
    expect(calc('TRIM("  a   b  ")')).toBe("a b");
    expect(calc('UPPER("straße")')).toBeUndefined();
    expect(calc('LOWER("İzmir")')).toBeUndefined();
  });

  it("değiştirme ve arama", () => {
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",3)')).toBe("a-b-c");
    expect(calc('REPLACE("abcdef",2,3,"X")')).toBe("aXef");
    expect(calc('FIND("b","abcb")')).toBe(2);
    expect(calc('FIND("b","abcb",3)')).toBe(4);
    expect(calc('FIND("B","abc")')).toEqual(e("#VALUE!"));
    expect(calc('SEARCH("B","abc")')).toBe(2);
    expect(calc('SEARCH("c*f","abcdef")')).toBe(3);
    expect(calc('SEARCH("?d","abcd")')).toBe(3);
    expect(calc('SEARCH("~*","a*b")')).toBe(2);
    expect(calc('REPT("ab",3)')).toBe("ababab");
    expect(calc('VALUE("12.5")')).toBe(12.5);
    expect(calc('VALUE("abc")')).toEqual(e("#VALUE!"));
    expect(calc('EXACT("a","A")')).toBe(false);
    expect(calc('EXACT("a","a")')).toBe(true);
  });

  it("TEXT gibi sayı biçimi isteyen işlevler desteklenmez", () => {
    expect(calc('TEXT(5,"0.00")')).toBeUndefined();
  });
});

describe("ölçüt işlevleri", () => {
  const d: Input = {
    S: {
      A1: 5,
      A2: 10,
      A3: 15,
      A4: "apple",
      A5: "Apricot",
      A7: "banana",
      A8: "a*b",
      B1: 1,
      B2: 2,
      B3: 3,
      B4: 4,
      B5: 5,
      B6: 6,
      B7: 7,
      B8: 8,
      C1: "10",
      C2: 10,
    },
  };

  it("karşılaştırma ölçütleri", () => {
    expect(calc('COUNTIF(A1:A3,">=10")', d)).toBe(2);
    expect(calc('COUNTIF(A1:A8,"<>10")', d)).toBe(7);
    expect(calc("COUNTIF(A1:A8,10)", d)).toBe(1);
    expect(calc('COUNTIF(A1:A8,"10")', d)).toBe(1);
    expect(calc('COUNTIF(A4:A7,">b")', d)).toBe(1);
  });

  it("boş ölçütler", () => {
    expect(calc('COUNTIF(A1:A8,"")', d)).toBe(1);
    expect(calc('COUNTIF(A1:A8,"=")', d)).toBe(1);
    expect(calc('COUNTIF(A1:A8,"<>")', d)).toBe(7);
    expect(calc('COUNTIF(A:A,"")', d, "Z1")).toBe(1_048_576 - 7);
  });

  it("jokerler ve ~ kaçışı", () => {
    expect(calc('COUNTIF(A1:A8,"a*")', d)).toBe(3);
    expect(calc('COUNTIF(A1:A8,"?pple")', d)).toBe(1);
    expect(calc('COUNTIF(A1:A8,"a~*b")', d)).toBe(1);
    expect(calc('COUNTIF(A1:A8,"*")', d)).toBe(4);
    expect(calc('COUNTIF(A1:A8,"APPLE")', d)).toBe(1);
  });

  it("sayı ölçütü sayısal metinle eşleşir", () => {
    expect(calc("COUNTIF(C1:C2,10)", d)).toBe(2);
  });

  it("SUMIF, SUMIFS, AVERAGEIF, AVERAGEIFS, COUNTIFS", () => {
    expect(calc('SUMIF(A1:A3,">5",B1:B3)', d)).toBe(5);
    expect(calc('SUMIF(A1:A3,">5")', d)).toBe(25);
    expect(calc('SUMIF(A1:A3,">5",B1)', d)).toBe(5);
    expect(calc('SUMIFS(B1:B8,A1:A8,"a*",B1:B8,">4")', d)).toBe(13);
    expect(calc('AVERAGEIF(A1:A3,">5")', d)).toBe(12.5);
    expect(calc('AVERAGEIF(A1:A3,">100")', d)).toEqual(e("#DIV/0!"));
    expect(calc('AVERAGEIFS(B1:B8,A1:A8,"<>apple",B1:B8,"<4")', d)).toBe(2);
    expect(calc('COUNTIFS(A1:A8,">=5",B1:B8,"<3")', d)).toBe(2);
    expect(calc('COUNTIFS(A1:A8,">=5",B1:B7,"<3")', d)).toEqual(e("#VALUE!"));
    expect(calc('SUMIF(A:A,"a*",B:B)', d, "Z1")).toBe(4 + 5 + 8);
  });

  it("tarih ya da yüzde gibi yorum isteyen ölçüt hesaplanmaz", () => {
    expect(calc('COUNTIF(A1:A8,">1/1/2024")', d)).toBeUndefined();
    expect(calc("COUNTIF(A1:A8,Z1)", d)).toBeUndefined();
  });
});

describe("arama işlevleri", () => {
  const d: Input = {
    S: {
      D1: "elma",
      E1: 10,
      D2: "armut",
      E2: 20,
      D3: "kiraz",
      E3: 30,
      G1: 0,
      H1: "F",
      G2: 10,
      H2: "D",
      G3: 20,
      H3: "C",
      G4: 30,
      H4: "B",
      J1: 3,
      J2: 1,
      J3: 2,
    },
  };

  it("VLOOKUP tam ve yaklaşık eşleşme", () => {
    expect(calc('VLOOKUP("ARMUT",D1:E3,2,FALSE)', d)).toBe(20);
    expect(calc('VLOOKUP("a*",D1:E3,2,0)', d)).toBe(20);
    expect(calc('VLOOKUP("x",D1:E3,2,FALSE)', d)).toEqual(e("#N/A"));
    expect(calc('VLOOKUP("armut",D1:E3,3,FALSE)', d)).toEqual(e("#REF!"));
    expect(calc('VLOOKUP("armut",D1:E3,0,FALSE)', d)).toEqual(e("#VALUE!"));
    expect(calc("VLOOKUP(25,G1:H4,2)", d)).toBe("C");
    expect(calc("VLOOKUP(100,G1:H4,2,TRUE)", d)).toBe("B");
    expect(calc("VLOOKUP(-1,G1:H4,2)", d)).toEqual(e("#N/A"));
    expect(calc("VLOOKUP(25,G:H,2)", d)).toBe("C");
  });

  it("sırasız veride yaklaşık eşleşme hesaplanmaz", () => {
    expect(calc("VLOOKUP(2,J1:J3,1)", d)).toBeUndefined();
    expect(calc("MATCH(2,J1:J3)", d)).toBeUndefined();
  });

  it("HLOOKUP", () => {
    const h: Input = { S: { A1: "a", B1: "b", A2: 1, B2: 2 } };
    expect(calc('HLOOKUP("B",A1:B2,2,FALSE)', h)).toBe(2);
  });

  it("XLOOKUP yalnız tam eşleşme", () => {
    expect(calc('_xlfn.XLOOKUP("kiraz",D1:D3,E1:E3)', d)).toBe(30);
    expect(calc('XLOOKUP("yok",D1:D3,E1:E3,"bulunamadı")', d)).toBe("bulunamadı");
    expect(calc('XLOOKUP("yok",D1:D3,E1:E3)', d)).toEqual(e("#N/A"));
    expect(calc('XLOOKUP("k*",D1:D3,E1:E3)', d)).toEqual(e("#N/A"));
    expect(calc('XLOOKUP("kiraz",D1:D3,E1:E3,,1)', d)).toBeUndefined();
    expect(calc('XLOOKUP("kiraz",D1:D3,E1:E3,,0,-1)', d)).toBeUndefined();
    expect(calc('SUM(XLOOKUP("armut",D1:D3,D1:E3))', d)).toBe(20);
  });

  it("INDEX ve MATCH", () => {
    expect(calc("INDEX(E1:E3,2)", d)).toBe(20);
    expect(calc("INDEX(D1:E3,3,2)", d)).toBe(30);
    expect(calc("INDEX(D1:E3,4,1)", d)).toEqual(e("#REF!"));
    expect(calc("SUM(INDEX(D1:E3,0,2))", d)).toBe(60);
    expect(calc("INDEX({1,2;3,4},2,1)")).toBe(3);
    expect(calc("INDEX({10,20,30},2)")).toBe(20);
    expect(calc('MATCH("kiraz",D1:D3,0)', d)).toBe(3);
    expect(calc('MATCH("x",D1:D3,0)', d)).toEqual(e("#N/A"));
    expect(calc("MATCH(25,G1:G4,1)", d)).toBe(3);
    expect(calc("MATCH(25,G1:G4)", d)).toBe(3);
    expect(calc("MATCH(25,{40,30,20,10},-1)")).toBe(2);
    expect(calc('INDEX(E1:E3,MATCH("armut",D1:D3,0))', d)).toBe(20);
    expect(calc("SUM(E1:INDEX(E1:E3,2))", d)).toBe(30);
  });

  it("ROWS, COLUMNS, ROW, COLUMN", () => {
    expect(calc("ROWS(A1:C5)")).toBe(5);
    expect(calc("COLUMNS(A1:C5)")).toBe(3);
    expect(calc("ROW()", { S: {} }, "C5")).toBe(5);
    expect(calc("COLUMN()", { S: {} }, "C5")).toBe(3);
    expect(calc("ROW(B7)+COLUMN(D1)")).toBe(11);
    expect(calc("ROW(A1:A3)")).toBeUndefined();
  });
});

describe("tarih işlevleri", () => {
  it("DATE ve 1900 artık yıl hatası", () => {
    expect(calc("DATE(2024,1,1)")).toBe(45292);
    expect(calc("DATE(1900,1,1)")).toBe(1);
    expect(calc("DATE(1900,2,28)")).toBe(59);
    expect(calc("DATE(1900,2,29)")).toBe(60);
    expect(calc("DATE(1900,3,0)")).toBe(60);
    expect(calc("DATE(1900,3,1)")).toBe(61);
    expect(calc("DATE(2024,14,1)")).toBe(45689);
    expect(calc("DATE(2024,1,0)")).toBe(45291);
    expect(calc("DATE(99,1,1)")).toBe(36161);
    expect(calc("DATE(-1,1,1)")).toEqual(e("#NUM!"));
    expect(calc("DATE(10000,1,1)")).toEqual(e("#NUM!"));
  });

  it("YEAR, MONTH, DAY, WEEKDAY", () => {
    expect(calc("YEAR(45292)")).toBe(2024);
    expect(calc("MONTH(60)*100+DAY(60)")).toBe(229);
    expect(calc("MONTH(61)*100+DAY(61)")).toBe(301);
    expect(calc("YEAR(0)*100+DAY(0)")).toBe(190_000);
    expect(calc("DAY(45292.75)")).toBe(1);
    expect(calc("WEEKDAY(45292)")).toBe(2);
    expect(calc("WEEKDAY(45292,2)")).toBe(1);
    expect(calc("WEEKDAY(45292,3)")).toBe(0);
    expect(calc("WEEKDAY(45292,12)")).toBe(7);
    expect(calc("WEEKDAY(45292,16)")).toBe(3);
    expect(calc("WEEKDAY(1)")).toBe(1);
    expect(calc("WEEKDAY(45292,9)")).toEqual(e("#NUM!"));
  });

  it("EDATE, EOMONTH, DAYS", () => {
    expect(calc("EDATE(DATE(2024,1,31),1)")).toBe(45351);
    expect(calc("EDATE(DATE(2024,1,31),-2)")).toBe(45260);
    expect(calc("EOMONTH(DATE(2024,1,15),1)")).toBe(45351);
    expect(calc("EOMONTH(DATE(2024,3,15),-1)")).toBe(45351);
    expect(calc("DAYS(DATE(2024,3,1),DATE(2024,1,1))")).toBe(60);
  });

  it("TODAY ve NOW verilen ana göre", () => {
    expect(calc("TODAY()")).toBe(45306);
    expect(calc("NOW()")).toBe(45306.5);
  });

  it("1904 tarih sistemi", () => {
    const o = { date1904: true };
    expect(calc("DATE(1904,1,1)", { S: {} }, "A1", o)).toBe(0);
    expect(calc("DATE(2024,1,1)", { S: {} }, "A1", o)).toBe(45292 - 1462);
    expect(calc("YEAR(0)", { S: {} }, "A1", o)).toBe(1904);
    expect(calc("WEEKDAY(0)", { S: {} }, "A1", o)).toBe(6);
    expect(calc("DATE(1903,1,1)", { S: {} }, "A1", o)).toEqual(e("#NUM!"));
  });
});

describe("başvurular", () => {
  const d: Input = {
    Ana: { A1: 1, B1: 2 },
    Sayfa2: { A1: 10, A2: 20 },
    "Adı boşluklu": { A1: 100, B2: 200 },
    "O'Brien": { A1: 7 },
  };

  it("sayfalar arası, tırnaklı ve büyük/küçük harf duyarsız sayfa adı", () => {
    expect(calc("Sayfa2!A1+A1", d)).toBe(11);
    expect(calc("SUM(sayfa2!A1:A2)", d)).toBe(30);
    expect(calc("SUM('Adı boşluklu'!A1:B2)", d)).toBe(300);
    expect(calc("'O''Brien'!A1", d)).toBe(7);
    expect(calc("$A$1+B$1+$B1", d)).toBe(5);
    expect(calc("Yok!A1", d)).toBeUndefined();
  });

  it("tanımlı adlar", () => {
    const names = { Oran: "0.2", Satislar: "Sayfa2!$A$1:$A$2", Tek: "Ana!$B$1", Goreli: "Ana!A1" };
    expect(calc("SUM(Satislar)*oran", d, "Z1", { names })).toBe(6);
    expect(calc("TEK*10", d, "Z1", { names })).toBe(20);
    expect(calc("Bilinmeyen+1", d, "Z1", { names })).toBeUndefined();
    expect(calc("Goreli", d, "Z1", { names })).toBeUndefined();
  });

  it("formül aralık döndürürse örtük kesişim", () => {
    const s: Input = { S: { A1: 1, A2: 2, A3: 3, B1: 4, C1: 5 } };
    expect(calc("A1:A3", s, "B2")).toBe(2);
    expect(calc("A1:A3*10", s, "D3")).toBe(30);
    expect(calc("A1:A3", s, "D5")).toEqual(e("#VALUE!"));
    expect(calc("A1:C1", s, "B7")).toBe(4);
    expect(calc("A1:B2", s, "C1")).toEqual(e("#VALUE!"));
    expect(calc("A:A", s, "Z3")).toBe(3);
  });
});

describe("recalculate", () => {
  it("formüllü her hücreyi bağımlılık sırasıyla hesaplar; düz hücre sonuçta yok", () => {
    const get = recalc({
      Ana: { A1: "=A2*2", A2: "=Veri!B1+1", A3: 5 },
      Veri: { B1: "=SUM(Ana!A3,1)" },
    });
    expect(get("Ana", "A1")).toBe(14);
    expect(get("Ana", "A2")).toBe(7);
    expect(get("Veri", "B1")).toBe(6);
    expect(get("Ana", "A3")).toBeUndefined();
  });

  it("döngüsel başvuru ve ona bağlı hücreler undefined", () => {
    const get = recalc({
      S: {
        A1: "=B1+1",
        B1: "=A1+1",
        C1: "=A1*2",
        D1: "=5",
        E1: "=E1",
        F1: "=SUM(F2:F3)",
        F3: "=F1",
      },
    });
    expect(get("S", "A1")).toBeUndefined();
    expect(get("S", "B1")).toBeUndefined();
    expect(get("S", "C1")).toBeUndefined();
    expect(get("S", "D1")).toBe(5);
    expect(get("S", "E1")).toBeUndefined();
    expect(get("S", "F1")).toBeUndefined();
    expect(get("S", "F3")).toBeUndefined();
  });

  it("desteklenmeyen işlev ve ona bağlı hücre undefined, bağımsızlar hesaplanır", () => {
    const get = recalc({
      S: {
        A1: '=TEXT(5,"0")',
        B1: "=A1&1",
        C1: "=SUM(A1:A2)",
        D1: '=INDIRECT("A2")',
        E1: "=OFFSET(A2,0,0)",
        F1: "=RAND()",
        A2: 3,
        G1: "=A2*2",
        H1: "=IF(A2>1,G1,A1)",
      },
    });
    for (const a of ["A1", "B1", "C1", "D1", "E1", "F1"]) expect(get("S", a)).toBeUndefined();
    expect(get("S", "G1")).toBe(6);
    expect(get("S", "H1")).toBe(6);
  });

  it("formül sonucu boş metin ve hata olarak saklanır", () => {
    const get = recalc({ S: { A1: '=""', A2: "=1/0", A3: "=B9" } });
    expect(get("S", "A1")).toBe("");
    expect(get("S", "A2")).toEqual(e("#DIV/0!"));
    expect(get("S", "A3")).toBe(0);
  });

  it("uzun zincir yığın taşırmaz (60000 hücre, iki yönde)", () => {
    const n = 60_000;
    const down: Record<string, Scalar> = { A1: 1 };
    const up: Record<string, Scalar> = { [`A${n}`]: 1 };
    for (let r = 2; r <= n; r++) down[`A${r}`] = `=A${r - 1}+1`;
    for (let r = 1; r < n; r++) up[`A${r}`] = `=A${r + 1}+1`;
    expect(recalc({ S: down })("S", `A${n}`)).toBe(n);
    expect(recalc({ S: up })("S", "A1")).toBe(n);
    const book = makeBook({ S: up });
    expect(evaluateFormula(book, "S", 1, 2, "A1*2", NOW)).toBe(2 * n);
  });

  it("aynı hücre bir kez hesaplanır (elmas zincir)", () => {
    const cells: Record<string, Scalar> = { A1: 1 };
    for (let r = 2; r <= 45; r++) cells[`A${r}`] = `=A${r - 1}+A${r - 1}`;
    expect(recalc({ S: cells })("S", "A45")).toBe(2 ** 44);
  });

  it("100 bin hücrelik tüm sütun aralıkları makul sürede", () => {
    const cells: Record<string, Scalar> = { B1: "=SUM(A:A)", B2: '=COUNTIF(A:A,">50000")' };
    for (let r = 1; r <= 100_000; r++) cells[`A${r}`] = r;
    cells.B3 = '=SUMIFS(A:A,A:A,"<=10")';
    const started = performance.now();
    const get = recalc({ S: cells });
    expect(get("S", "B1")).toBe(5_000_050_000);
    expect(get("S", "B2")).toBe(50_000);
    expect(get("S", "B3")).toBe(55);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
