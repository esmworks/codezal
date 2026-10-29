import { child, el, elements, parseXml, serializeXml, textOf, type XmlNode } from "./ooxml.js";
import {
  type CellData,
  dateToSerial,
  isXlError,
  readSheetCells,
  richText,
  type SheetCells,
  type XlValue,
} from "./xlsx.js";
import {
  type CalcWorkbook,
  calcKey,
  recalculate,
  type Scalar,
  type XlErrorCode,
} from "./xlsx-calc.js";
import { colLetters, MAX_COL, MAX_ROW, parseAddress } from "./xlsx-formula.js";
import { isDateFormat, type StyleSheet } from "./xlsx-style.js";

/**
 * Hücreye yazma: modelin verdiği değeri (sayı, metin, mantıksal, ISO tarih, `=formül`) Excel
 * hücresine çevirir; paylaşılan metin tablosu ve yeniden hesaplama. Üretim (`xlsx-build.ts`) ve
 * düzenleme (`xlsx-edit.ts`) paylaşır. Kütüphane tuzakları modele öğretilmez, burada çözülür:
 * Türkçe işlev adı ve `;` ayırıcı İngilizceye, yeni işlevler dosyanın beklediği `_xlfn.` önekine
 * çevrilir.
 */

export const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type CellInput = string | number | boolean | null;

// ─── Paylaşılan metin ───────────────────────────────────────────────────────────────────────────

export class SharedStrings {
  readonly #root: XmlNode;
  readonly #sst: XmlNode;
  readonly #index = new Map<string, number>();
  #count: number;
  changed = false;

  constructor(xml?: string) {
    this.#root = parseXml(
      xml ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${MAIN_NS}" count="0" uniqueCount="0"></sst>`,
    );
    const sst = child(this.#root, "sst");
    if (!sst) throw new Error("sharedStrings.xml: sst yok");
    this.#sst = sst;
    const items = elements(sst).filter((e) => e.name === "si");
    items.forEach((si, i) => {
      // Yalnız düz metinler yeniden kullanılır; zengin metnin biçimi yeni hücreye taşınmasın.
      const t = child(si, "t");
      if (t && elements(si).length === 1 && !this.#index.has(textOf(t)))
        this.#index.set(textOf(t), i);
    });
    this.#count = items.length;
  }

  get size(): number {
    return this.#count;
  }

  add(text: string): number {
    const known = this.#index.get(text);
    if (known !== undefined) return known;
    const attrs: Record<string, string> = /^\s|\s$|\n/.test(text)
      ? { "xml:space": "preserve" }
      : {};
    this.#sst.children.push(el("si", {}, [el("t", attrs, [escapeX(text)])]));
    this.#index.set(text, this.#count);
    this.changed = true;
    return this.#count++;
  }

  /** Metin listesi (okuyucunun `shared` dizisi yerine). */
  list(): string[] {
    return elements(this.#sst)
      .filter((e) => e.name === "si")
      .map((si) => richText(si));
  }

  toXml(): string {
    this.#sst.attrs.uniqueCount = String(this.#count);
    this.#sst.attrs.count = String(this.#count);
    return serializeXml(this.#root);
  }
}

/** XML 1.0'da yazılamayan denetim karakterleri Excel'in `_xHHHH_` kaçışıyla saklanır. */
const escapeX = (s: string) =>
  s
    .replace(/_x[0-9A-Fa-f]{4}_/g, (m) => `_x005F${m.slice(1)}`)
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: kaçırılacak karakterler bunlar
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
      (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
    );

// ─── Girdi yorumu ───────────────────────────────────────────────────────────────────────────────

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "formula"; formula: string }
  | { kind: "number"; value: number; format?: string }
  | { kind: "date"; value: number; time: boolean }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseInput(input: CellInput, date1904 = false): ParsedInput {
  if (input === null) return { kind: "empty" };
  if (typeof input === "boolean") return { kind: "bool", value: input };
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? { kind: "number", value: input }
      : { kind: "string", value: String(input) };
  }
  if (input === "") return { kind: "empty" };
  // Excel geleneği: baştaki kesme işareti metni zorlar ('=… formül değil, '0532 sıfırı korur).
  if (input.startsWith("'")) return { kind: "string", value: input.slice(1) };
  if (input.startsWith("=") && input.length > 1) {
    return { kind: "formula", formula: normalizeFormula(input.slice(1)) };
  }
  const date = ISO_DATE.exec(input);
  if (date) {
    const [, y, m, d, hh, mm, ss] = date;
    const ms = Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh ?? 0),
      Number(mm ?? 0),
      Number(ss ?? 0),
    );
    const valid = new Date(ms);
    if (valid.getUTCMonth() === Number(m) - 1 && valid.getUTCDate() === Number(d)) {
      return { kind: "date", value: dateToSerial(valid, date1904), time: hh !== undefined };
    }
  }
  // Başında sıfır olan (telefon, kod) ve 15 basamağı aşan metin sayıya çevrilmez.
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(input)) return { kind: "number", value: Number(input) };
  const pct = /^(-?(?:0|[1-9]\d{0,14})(?:\.(\d+))?)%$/.exec(input);
  if (pct?.[1]) {
    const decimals = pct[2]?.length ?? 0;
    return {
      kind: "number",
      value: Number(pct[1]) / 100,
      format: decimals > 0 ? `0.${"0".repeat(decimals)}%` : "0%",
    };
  }
  if (input === "TRUE" || input === "FALSE") return { kind: "bool", value: input === "TRUE" };
  return { kind: "string", value: input };
}

/** Türkçe Excel arayüzündeki işlev adları; dosyada İngilizce saklanır. */
const TR_FUNCTIONS: Record<string, string> = {
  TOPLA: "SUM",
  ORTALAMA: "AVERAGE",
  EĞER: "IF",
  EĞERHATA: "IFERROR",
  EĞERYOKSA: "IFNA",
  ÇOKEĞER: "IFS",
  DÜŞEYARA: "VLOOKUP",
  YATAYARA: "HLOOKUP",
  ÇAPRAZARA: "XLOOKUP",
  YUVARLA: "ROUND",
  YUKARIYUVARLA: "ROUNDUP",
  AŞAĞIYUVARLA: "ROUNDDOWN",
  TAVANAYUVARLA: "CEILING",
  TABANAYUVARLA: "FLOOR",
  MİN: "MIN",
  MAK: "MAX",
  BAĞ_DEĞ_SAY: "COUNT",
  BAĞ_DEĞ_DOLU_SAY: "COUNTA",
  BOŞLUKSAY: "COUNTBLANK",
  EĞERSAY: "COUNTIF",
  ÇOKEĞERSAY: "COUNTIFS",
  ETOPLA: "SUMIF",
  ÇOKETOPLA: "SUMIFS",
  ORTALAMAEĞER: "AVERAGEIF",
  ÇOKEĞERORTALAMA: "AVERAGEIFS",
  TOPLAÇARPIM: "SUMPRODUCT",
  VE: "AND",
  YADA: "OR",
  DEĞİL: "NOT",
  BUGÜN: "TODAY",
  ŞİMDİ: "NOW",
  TARİH: "DATE",
  YIL: "YEAR",
  AY: "MONTH",
  GÜN: "DAY",
  HAFTANINGÜNÜ: "WEEKDAY",
  SERİTARİH: "EDATE",
  SERİAY: "EOMONTH",
  BİRLEŞTİR: "CONCATENATE",
  ARALIKBİRLEŞTİR: "CONCAT",
  METİNBİRLEŞTİR: "TEXTJOIN",
  UZUNLUK: "LEN",
  SOLDAN: "LEFT",
  SAĞDAN: "RIGHT",
  PARÇAAL: "MID",
  BÜYÜKHARF: "UPPER",
  KÜÇÜKHARF: "LOWER",
  YAZIM: "PROPER",
  KIRP: "TRIM",
  YERİNEKOY: "SUBSTITUTE",
  DEĞİŞTİR: "REPLACE",
  BUL: "FIND",
  MBUL: "SEARCH",
  METNEÇEVİR: "TEXT",
  SAYIYAÇEVİR: "VALUE",
  İNDİS: "INDEX",
  KAÇINCI: "MATCH",
  ELEMAN: "CHOOSE",
  MUTLAK: "ABS",
  TAMSAYI: "INT",
  NSAT: "TRUNC",
  KAREKÖK: "SQRT",
  KUVVET: "POWER",
  EBOŞSA: "ISBLANK",
  ESAYIYSA: "ISNUMBER",
  EMETİNSE: "ISTEXT",
  EHATALIYSA: "ISERROR",
};

/** Dosyada `_xlfn.` önekiyle saklanması gereken (Excel 2010 sonrası) işlevler. */
const XLFN = new Set([
  "XLOOKUP",
  "XMATCH",
  "IFS",
  "SWITCH",
  "MAXIFS",
  "MINIFS",
  "CONCAT",
  "TEXTJOIN",
  "UNIQUE",
  "SEQUENCE",
  "LET",
  "LAMBDA",
  "IFNA",
  "DAYS",
  "XOR",
  "STDEV.S",
  "STDEV.P",
  "VAR.S",
  "VAR.P",
  "CEILING.MATH",
  "FLOOR.MATH",
  "RANDARRAY",
  "TEXTBEFORE",
  "TEXTAFTER",
  "TEXTSPLIT",
  "VSTACK",
  "HSTACK",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "TAKE",
  "DROP",
  "TOCOL",
  "TOROW",
  "ISOWEEKNUM",
  "NUMBERVALUE",
  "PERCENTILE.INC",
  "PERCENTILE.EXC",
  "QUARTILE.INC",
  "QUARTILE.EXC",
  "RANK.EQ",
  "RANK.AVG",
  "MODE.SNGL",
  "NORM.DIST",
  "NORM.INV",
  "WORKDAY.INTL",
  "NETWORKDAYS.INTL",
  "FORECAST.LINEAR",
  "AGGREGATE",
  "SHEET",
  "SHEETS",
  "FORMULATEXT",
  "ISFORMULA",
]);
/** Dinamik dizi işlevleri ayrıca `_xlws.` ister. */
const XLWS = new Set(["FILTER", "SORT", "SORTBY"]);

/** Tırnak dışındaki parçalara `fn` uygulanır; metin sabitleri olduğu gibi kalır. */
function outsideStrings(formula: string, fn: (part: string) => string): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/**
 * Modelin yazdığı formülü dosya biçimine çevirir: Türkçe ayırıcı (`;`, ondalık `,`) ve işlev adları
 * İngilizceye, yeni işlevler `_xlfn.` önekine. Sayfa adındaki (tırnaklı) `;` ya da harf etkilenmez:
 * tırnaklı sayfa adları da tek tırnak içinde olduğundan ayrıca korunur.
 */
export function normalizeFormula(raw: string): string {
  let formula = raw.trim().replace(/^=/, "");
  const protect = (text: string, fn: (part: string) => string) =>
    text
      .split(/('(?:[^']|'')*'!)/)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join("");
  const apply = (fn: (part: string) => string) => {
    formula = outsideStrings(formula, (part) => protect(part, fn));
  };
  let semicolon = false;
  apply((part) => {
    if (part.includes(";")) semicolon = true;
    return part;
  });
  if (semicolon) {
    // Türkçe yazımda `,` ondalık, `;` argüman ayırıcıdır. Dizi sabitinin `{1;2}` satır ayırıcısı da
    // `;` olduğundan yalnız süslü ayraç dışındakiler çevrilir.
    apply((part) => {
      let depth = 0;
      let out = "";
      for (const ch of part) {
        if (ch === "{") depth++;
        else if (ch === "}") depth = Math.max(0, depth - 1);
        if (depth === 0 && ch === ",") out += ".";
        else if (depth === 0 && ch === ";") out += ",";
        else out += ch;
      }
      return out;
    });
  }
  apply((part) =>
    part.replace(
      /(^|[^\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_.]*)(?=\s*\()/gu,
      (whole, lead: string, name: string) => {
        const upper = name.toLocaleUpperCase("tr-TR");
        const english = TR_FUNCTIONS[upper] ?? name.toUpperCase();
        const bare = english.replace(/^_XLFN\.(_XLWS\.)?/i, "");
        if (XLWS.has(bare)) return `${lead}_xlfn._xlws.${bare}`;
        if (XLFN.has(bare)) return `${lead}_xlfn.${bare}`;
        if (/^_xlfn\./i.test(name)) return whole;
        return TR_FUNCTIONS[upper] ? `${lead}${english}` : whole;
      },
    ),
  );
  return formula;
}

/** Okuma görünümü ve hata iletisi için önekleri atar. */
export const displayFormula = (formula: string) => formula.replace(/_xlfn\.(_xlws\.)?/g, "");

// ─── Hücre yazımı ───────────────────────────────────────────────────────────────────────────────

export interface WriteContext {
  strings: SharedStrings;
  styles: StyleSheet;
  date1904: boolean;
  /** Tarih hücresine biçim yoksa verilecek kod. */
  dateFormat: string;
  dateTimeFormat: string;
}

/**
 * `c` düğümünün içeriğini değiştirir; stil (`s`) korunur. Tarih yazılan hücrenin biçimi tarih
 * değilse tarih biçimli kopya stile geçilir (yoksa Excel seri numarasını sayı gösterir); yüzde
 * metni de yüzde biçimi alır. Formülün değeri yeniden hesaplamada yazılır.
 */
export function writeCell(c: XmlNode, parsed: ParsedInput, ctx: WriteContext): void {
  const keep = c.children.filter(
    (x) => typeof x === "string" || "raw" in x || !["f", "v", "is"].includes(x.name),
  );
  c.children = keep.filter((x) => typeof x !== "string");
  delete c.attrs.t;
  delete c.attrs.cm;
  delete c.attrs.vm;
  const style = Number(c.attrs.s ?? 0) || 0;
  const setStyle = (s: number) => {
    if (s === 0) delete c.attrs.s;
    else c.attrs.s = String(s);
  };
  switch (parsed.kind) {
    case "empty":
      return;
    case "formula":
      c.children.unshift(el("f", {}, [parsed.formula]));
      return;
    case "number":
      if (parsed.format && !ctx.styles.formatOf(style).includes("%")) {
        setStyle(ctx.styles.derive(style, { numFmt: parsed.format }));
      }
      c.children.unshift(el("v", {}, [String(parsed.value)]));
      return;
    case "date":
      if (!isDateFormat(ctx.styles.formatOf(style))) {
        setStyle(
          ctx.styles.derive(style, { numFmt: parsed.time ? ctx.dateTimeFormat : ctx.dateFormat }),
        );
      }
      c.children.unshift(el("v", {}, [String(parsed.value)]));
      return;
    case "bool":
      c.attrs.t = "b";
      c.children.unshift(el("v", {}, [parsed.value ? "1" : "0"]));
      return;
    case "string":
      c.attrs.t = "s";
      c.children.unshift(el("v", {}, [String(ctx.strings.add(parsed.value))]));
      return;
  }
}

// ─── Yeniden hesaplama ──────────────────────────────────────────────────────────────────────────

export interface RecalcSheet {
  name: string;
  root: XmlNode;
}

export interface RecalcResult {
  /** Değeri hesaplanan formül sayısı. */
  computed: number;
  /** Hesaplanamayan (desteklenmeyen işlev, döngü) formül sayısı; Excel açılışta hesaplar. */
  pending: number;
  /** Hata sonucu veren formüller: `Sayfa!B3 #DIV/0!`. */
  errors: { sheet: string; ref: string; error: string; formula: string }[];
  /** Önbellek değeri değişen sayfalar (düzenlemede yalnız bunlar yeniden yazılır). */
  changed: Set<string>;
}

function sheetData(root: XmlNode): XmlNode | undefined {
  return child(child(root, "worksheet") ?? root, "sheetData");
}

/** Hücre düğümleri adresle: yazılan değer doğru `c`'ye gitsin. */
function cellNodes(root: XmlNode): Map<string, XmlNode> {
  const out = new Map<string, XmlNode>();
  const data = sheetData(root);
  if (!data) return out;
  let rowNo = 0;
  for (const row of elements(data)) {
    if (row.name !== "row") continue;
    rowNo = Number(row.attrs.r) || rowNo + 1;
    let colNo = 0;
    for (const c of elements(row)) {
      if (c.name !== "c") continue;
      colNo = (c.attrs.r ? parseAddress(c.attrs.r)?.col : undefined) ?? colNo + 1;
      out.set(`${rowNo}:${colNo}`, c);
    }
  }
  return out;
}

const CALC_ERRORS: readonly XlErrorCode[] = [
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
];

// Motorun bilmediği hata kodları (#SPILL!, #CALC!…) yine hata olarak yayılsın; tam kod sonucu
// yalnız ERROR.TYPE/ISNA gibi nadir işlevlerde değiştirir.
const toScalar = (v: XlValue): Scalar => {
  if (!isXlError(v)) return v;
  return { error: CALC_ERRORS.find((code) => code === v.error) ?? "#VALUE!" };
};

/**
 * Dizi (CSE/dinamik) ve veri tablosu formülleri motorda tek hücre gibi hesaplanamaz: önbellekleri
 * sabit değer sayılır, üzerine yazılmaz.
 */
function isFixedFormula(c: XmlNode): boolean {
  if (c.attrs.cm !== undefined) return true;
  const t = child(c, "f")?.attrs.t;
  return t === "array" || t === "dataTable";
}

/**
 * Kitaptaki tüm formülleri hesaplar ve sonucu hücrenin `<v>` önbelleğine yazar. Hesaplanamayan
 * formülün önbelleği olduğu gibi kalır (düzenlemede eski değer; Excel `fullCalcOnLoad` ile açılışta
 * düzeltir).
 */
export function recalcSheets(
  sheets: readonly RecalcSheet[],
  shared: readonly string[],
  options: {
    date1904: boolean;
    names?: ReadonlyMap<string, string>;
    /** Önceden aynı hatayı taşıyan düğümler uyarı listesine girmez. */
    known?: WeakMap<XmlNode, string>;
    now?: Date;
  },
): RecalcResult {
  const cells = new Map<string, SheetCells>();
  const nodes = new Map<string, Map<string, XmlNode>>();
  const extents = new Map<string, { rows: number; cols: number }>();
  for (const s of sheets) {
    const map = readSheetCells(s.root, shared);
    const key = s.name.toLowerCase();
    cells.set(key, map);
    nodes.set(key, cellNodes(s.root));
    let rows = 0;
    let cols = 0;
    for (const [r, row] of map) {
      rows = Math.max(rows, r);
      for (const c of row.keys()) cols = Math.max(cols, c);
    }
    extents.set(key, { rows: Math.min(rows, MAX_ROW), cols: Math.min(cols, MAX_COL) });
  }
  const fixed = (key: string, row: number, col: number) => {
    const node = nodes.get(key)?.get(`${row}:${col}`);
    return node ? isFixedFormula(node) : false;
  };
  const book: CalcWorkbook = {
    sheets: sheets.map((s) => s.name),
    cell(sheet, row, col) {
      const key = sheet.toLowerCase();
      const cell: CellData | undefined = cells.get(key)?.get(row)?.get(col);
      if (!cell) return undefined;
      const value = toScalar(cell.value);
      return cell.formula && !fixed(key, row, col) ? { value, formula: cell.formula } : { value };
    },
    extent: (sheet) => extents.get(sheet.toLowerCase()) ?? { rows: 0, cols: 0 },
    ...(options.names ? { names: options.names } : {}),
    date1904: options.date1904,
  };
  const results = recalculate(book, options.now);
  const result: RecalcResult = { computed: 0, pending: 0, errors: [], changed: new Set() };
  for (const s of sheets) {
    const key = s.name.toLowerCase();
    const map = cells.get(key);
    if (!map) continue;
    for (const [r, row] of map) {
      for (const [col, cell] of row) {
        if (!cell.formula || fixed(key, r, col)) continue;
        const value = results.get(calcKey(s.name, r, col));
        const node = nodes.get(key)?.get(`${r}:${col}`);
        if (value === undefined || !node) {
          result.pending++;
          continue;
        }
        result.computed++;
        if (setCachedValue(node, value)) result.changed.add(s.name);
        if (
          typeof value === "object" &&
          value !== null &&
          options.known?.get(node) !== value.error
        ) {
          result.errors.push({
            sheet: s.name,
            ref: `${colLetters(col)}${r}`,
            error: value.error,
            formula: displayFormula(cell.formula),
          });
        }
      }
    }
  }
  return result;
}

/** Önbelleği yazar; değer değiştiyse `true`. */
function setCachedValue(c: XmlNode, value: Scalar): boolean {
  const before = serializeXml(c);
  c.children = c.children.filter(
    (x) => typeof x === "string" || "raw" in x || (x.name !== "v" && x.name !== "is"),
  );
  delete c.attrs.t;
  if (value === null) return serializeXml(c) !== before;
  let text: string;
  if (typeof value === "number") text = String(value);
  else if (typeof value === "boolean") {
    c.attrs.t = "b";
    text = value ? "1" : "0";
  } else if (typeof value === "string") {
    c.attrs.t = "str";
    text = value;
  } else {
    c.attrs.t = "e";
    text = value.error;
  }
  const at = c.children.findIndex((x) => typeof x !== "string" && "name" in x && x.name === "f");
  c.children.splice(at + 1, 0, el("v", {}, [text]));
  return serializeXml(c) !== before;
}
