/**
 * Excel formül hesaplayıcısı: kitaptaki formülleri yeniden hesaplar ki `<v>` önbelleği okuma
 * görünümünde ve önizleyicilerde güncel olsun. Excel dosyayı açınca zaten yeniden hesaplar; bu yüzden
 * emin olunmayan her durumda (desteklenmeyen işlev, belirsiz semantik, döngü) sonuç `undefined`dır.
 * Yanlış değer yazmak, hiç yazmamaktan kötüdür.
 *
 * Akış: formül AST'ye ayrıştırılır; başvurduğu formüllü hücreler açık yığınla (özyinelemesiz)
 * bağımlılık sırasına dizilir ve her hücre bir kez hesaplanıp belleklenir.
 */

import { colIndex, MAX_COL, MAX_ROW } from "./xlsx-formula.js";

export type XlErrorCode = "#DIV/0!" | "#N/A" | "#NAME?" | "#NULL!" | "#NUM!" | "#REF!" | "#VALUE!";
export interface XlError {
  error: XlErrorCode;
}
/** null = boş hücre */
export type Scalar = number | string | boolean | XlError | null;
export interface CalcCell {
  value: Scalar;
  /** baştaki "=" olmadan, dosyadaki gibi (İngilizce işlev adları, virgül ayırıcı) */
  formula?: string;
}
export interface CalcWorkbook {
  sheets: readonly string[];
  cell(sheet: string, row: number, col: number): CalcCell | undefined;
  /** Sayfanın dolu alanının son satır/sütunu: A:A ve 1:1 gibi tüm sütun/satır başvurularını sınırlamak için */
  extent(sheet: string): { rows: number; cols: number };
  /** Kitap düzeyi tanımlı adlar: ad (büyük/küçük harf duyarsız) → formül metni, ör. "Sayfa1!$B$2:$B$9" ya da "0.2" */
  names?: ReadonlyMap<string, string>;
  /** 1904 tarih sistemi */
  date1904?: boolean;
}

export const calcKey = (sheet: string, row: number, col: number) =>
  `${sheet}\u0000${row}\u0000${col}`;

// ─── Değerler ───────────────────────────────────────────────────────────────────────────────────

/** Hesaplanamayan durum: yakalanır ve formül `undefined` olur. Tek örnek; yığın izi bir kez alınır. */
class Unsupported extends Error {}
const UNSUPPORTED = new Unsupported("unsupported");
function unsupported(): never {
  throw UNSUPPORTED;
}

const ERROR_CODES: readonly XlErrorCode[] = [
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
];
const err = (code: XlErrorCode): XlError => ({ error: code });
const DIV0 = err("#DIV/0!");
const NA = err("#N/A");
const NUM = err("#NUM!");
const REF = err("#REF!");
const VALUE = err("#VALUE!");

const isError = (v: unknown): v is XlError => typeof v === "object" && v !== null && "error" in v;

/** Hücre aralığı; tüm sütun/satır başvurularında gerçek boyut korunur, okuma `extent` ile kırpılır. */
interface Rng {
  kind: "range";
  sheet: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}
/** Dizi sabiti ya da dizi kipinde (SUMPRODUCT) ara sonuç. */
interface Arr {
  kind: "array";
  rows: Scalar[][];
}
type Val = Scalar | Rng | Arr;

const isRng = (v: Val): v is Rng =>
  typeof v === "object" && v !== null && "kind" in v && v.kind === "range";
const isArr = (v: Val): v is Arr =>
  typeof v === "object" && v !== null && "kind" in v && v.kind === "array";

// ─── Ayrıştırıcı ────────────────────────────────────────────────────────────────────────────────

interface RefPart {
  col?: number;
  row?: number;
  abs: boolean;
}
type Node =
  | { t: "lit"; v: Scalar }
  | { t: "arr"; rows: Scalar[][] }
  | { t: "ref"; sheet?: string; a: RefPart; b?: RefPart }
  | { t: "name"; name: string }
  | { t: "fn"; name: string; args: Node[] }
  | { t: "missing" }
  | { t: "neg"; e: Node }
  | { t: "pct"; e: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "range"; l: Node; r: Node };

const REF_BODY =
  /^(?:\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7})/;
const IDENT = /^[\p{L}_\\][\p{L}\p{N}_.\\?]*/u;
const IDENT_CHAR = /[\p{L}\p{N}_.\\?$]/u;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const UNQUOTED_SHEET = /^[\p{L}\p{N}_.]+!/u;

function parseRefPart(text: string): RefPart | undefined {
  const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$/.exec(text);
  if (!m || (!m[2] && !m[4])) return undefined;
  const part: RefPart = { abs: m[2] ? m[1] === "$" && (m[4] ? m[3] === "$" : true) : m[1] === "$" };
  if (m[2]) {
    const col = colIndex(m[2]);
    if (col < 1 || col > MAX_COL) return undefined;
    part.col = col;
  }
  if (m[4]) {
    const row = Number(m[4]);
    if (row < 1 || row > MAX_ROW) return undefined;
    part.row = row;
  }
  return part;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  static parse(text: string): Node {
    const p = new Parser(text);
    p.ws();
    const node = p.comparison();
    p.ws();
    if (p.i < p.s.length) unsupported();
    return node;
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  peek(n = 0) {
    return this.s[this.i + n] ?? "";
  }
  rest() {
    return this.s.slice(this.i);
  }

  comparison(): Node {
    let l = this.concat();
    for (;;) {
      this.ws();
      const op = /^(?:<>|<=|>=|=|<|>)/.exec(this.rest())?.[0];
      if (!op) return l;
      this.i += op.length;
      l = { t: "bin", op, l, r: this.concat() };
    }
  }
  concat(): Node {
    let l = this.additive();
    for (;;) {
      this.ws();
      if (this.peek() !== "&") return l;
      this.i++;
      l = { t: "bin", op: "&", l, r: this.additive() };
    }
  }
  additive(): Node {
    let l = this.multiplicative();
    for (;;) {
      this.ws();
      const op = this.peek();
      if (op !== "+" && op !== "-") return l;
      this.i++;
      l = { t: "bin", op, l, r: this.multiplicative() };
    }
  }
  multiplicative(): Node {
    let l = this.power();
    for (;;) {
      this.ws();
      const op = this.peek();
      if (op !== "*" && op !== "/") return l;
      this.i++;
      l = { t: "bin", op, l, r: this.power() };
    }
  }
  // Excel'de ^ soldan birleşir: 2^3^2 = 64.
  power(): Node {
    let l = this.percent();
    for (;;) {
      this.ws();
      if (this.peek() !== "^") return l;
      this.i++;
      l = { t: "bin", op: "^", l, r: this.percent() };
    }
  }
  percent(): Node {
    let e = this.unary();
    for (;;) {
      this.ws();
      if (this.peek() !== "%") return e;
      this.i++;
      e = { t: "pct", e };
    }
  }
  // Tekli eksi ^'den sıkı bağlanır: -2^2 = 4.
  unary(): Node {
    this.ws();
    const ch = this.peek();
    if (ch === "-") {
      this.i++;
      return { t: "neg", e: this.unary() };
    }
    if (ch === "+") {
      this.i++;
      return this.unary();
    }
    return this.range();
  }
  range(): Node {
    let l = this.primary();
    while (this.peek() === ":") {
      this.i++;
      l = { t: "range", l, r: this.primary() };
    }
    return l;
  }

  primary(): Node {
    this.ws();
    const ch = this.peek();
    if (ch === "(") {
      this.i++;
      const e = this.comparison();
      this.ws();
      // `(A1,B1)` birleşimi desteklenmez; kapanmayan parantez de ayrıştırma hatasıdır.
      if (this.peek() !== ")") unsupported();
      this.i++;
      return e;
    }
    if (ch === '"') return { t: "lit", v: this.string() };
    if (ch === "#") return { t: "lit", v: this.errorLiteral() };
    if (ch === "{") return this.arrayConst();
    if (ch === "[") unsupported();
    if (ch === "'") {
      let k = this.i + 1;
      while (k < this.s.length) {
        if (this.s[k] === "'") {
          if (this.s[k + 1] === "'") k += 2;
          else break;
        } else k++;
      }
      if (this.s[k + 1] !== "!") unsupported();
      const sheet = this.s.slice(this.i + 1, k).replace(/''/g, "'");
      this.i = k + 2;
      return this.sheetRef(sheet);
    }
    const ref = this.refBody();
    if (ref) return ref;
    if (/\d|\./.test(ch)) {
      const m = NUMBER.exec(this.rest());
      if (!m) unsupported();
      this.i += m[0].length;
      return { t: "lit", v: Number(m[0]) };
    }
    const sheetM = UNQUOTED_SHEET.exec(this.rest());
    if (sheetM) {
      this.i += sheetM[0].length;
      return this.sheetRef(sheetM[0].slice(0, -1));
    }
    const id = IDENT.exec(this.rest());
    if (!id) unsupported();
    this.i += id[0].length;
    const name = id[0];
    // Sayfa aralığı (Sayfa1:Sayfa3!A1) ya da yapılandırılmış başvuru (Tablo1[Sütun]) desteklenmez.
    if (this.peek() === "[" || this.peek() === ":" || this.peek() === "!") unsupported();
    this.ws();
    if (this.peek() === "(") {
      this.i++;
      return { t: "fn", name: normalizeFn(name), args: this.args() };
    }
    const upper = name.toUpperCase();
    if (upper === "TRUE") return { t: "lit", v: true };
    if (upper === "FALSE") return { t: "lit", v: false };
    return { t: "name", name };
  }

  args(): Node[] {
    const args: Node[] = [];
    this.ws();
    if (this.peek() === ")") {
      this.i++;
      return args;
    }
    for (;;) {
      this.ws();
      const ch = this.peek();
      args.push(ch === "," || ch === ")" ? { t: "missing" } : this.comparison());
      this.ws();
      const sep = this.peek();
      this.i++;
      if (sep === ")") return args;
      if (sep !== ",") unsupported();
    }
  }

  /** Başvuru gövdesi (`A1`, `$A$1:B2`, `A:C`, `1:3`); arkasından `(` ya da ad karakteri gelmemeli. */
  refBody(sheet?: string): Node | undefined {
    const m = REF_BODY.exec(this.rest());
    if (!m) return undefined;
    const next = this.s[this.i + m[0].length] ?? "";
    if (next === "(" || next === "[" || next === "!" || IDENT_CHAR.test(next)) return undefined;
    const [left, right] = m[0].split(":");
    const a = left ? parseRefPart(left) : undefined;
    const b = right !== undefined ? parseRefPart(right) : undefined;
    if (!a || (right !== undefined && !b)) return undefined;
    this.i += m[0].length;
    return { t: "ref", a, ...(b ? { b } : {}), ...(sheet !== undefined ? { sheet } : {}) };
  }

  sheetRef(sheet: string): Node {
    if (this.rest().startsWith("#REF!")) {
      this.i += 5;
      return { t: "lit", v: REF };
    }
    // Sayfa düzeyi tanımlı ad (Sayfa1!Ad) desteklenmez.
    return this.refBody(sheet) ?? unsupported();
  }

  string(): string {
    let out = "";
    let k = this.i + 1;
    for (;;) {
      if (k >= this.s.length) unsupported();
      const c = this.s[k] ?? "";
      if (c === '"') {
        if (this.s[k + 1] === '"') {
          out += '"';
          k += 2;
          continue;
        }
        break;
      }
      out += c;
      k++;
    }
    this.i = k + 1;
    return out;
  }

  errorLiteral(): XlError {
    const rest = this.rest().toUpperCase();
    const code = ERROR_CODES.find((c) => rest.startsWith(c));
    if (!code) unsupported();
    this.i += code.length;
    return err(code);
  }

  arrayConst(): Node {
    this.i++;
    const rows: Scalar[][] = [[]];
    for (;;) {
      this.ws();
      let v: Scalar;
      const ch = this.peek();
      if (ch === '"') v = this.string();
      else if (ch === "#") v = this.errorLiteral();
      else {
        const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|^(?:TRUE|FALSE)\b/i.exec(this.rest());
        if (!m) unsupported();
        this.i += m[0].length;
        const u = m[0].toUpperCase();
        v = u === "TRUE" ? true : u === "FALSE" ? false : Number(m[0]);
      }
      rows[rows.length - 1]?.push(v);
      this.ws();
      const sep = this.peek();
      this.i++;
      if (sep === "}") break;
      if (sep === ";") rows.push([]);
      else if (sep !== ",") unsupported();
    }
    const w = rows[0]?.length ?? 0;
    if (rows.some((r) => r.length !== w)) unsupported();
    return { t: "arr", rows };
  }
}

/** Yeni işlevler dosyada `_xlfn.` / `_xlfn._xlws.` önekiyle durur. */
function normalizeFn(name: string): string {
  return name
    .toUpperCase()
    .replace(/^_XLFN\./, "")
    .replace(/^_XLWS\./, "");
}

// ─── Zorlama ve karşılaştırma ───────────────────────────────────────────────────────────────────

const MAX_TEXT = 32_767;
const STRICT_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 15 anlamlı basamak: Excel'in sakladığı/gösterdiği hassasiyet. */
const round15 = (n: number) => (n === 0 || !Number.isFinite(n) ? n : Number(n.toPrecision(15)));

/**
 * Metin → sayı. Tarih, saat, para ve binlik ayraçlı biçimleri Excel yerel ayara göre çevirir; biz
 * bunu bilemeyiz. Bu yüzden rakam içeren ama düz sayı olmayan metin hesaplanamaz sayılır.
 */
function textToNumber(text: string): number | XlError {
  const t = text.trim();
  const pct = t.endsWith("%");
  const body = pct ? t.slice(0, -1).trim() : t;
  if (STRICT_NUMBER.test(body)) return pct ? Number(body) / 100 : Number(body);
  if (/\d/.test(t)) unsupported();
  return VALUE;
}

function toNumber(v: Scalar): number | XlError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return textToNumber(v);
  return v;
}

/** Sayının Excel'deki "Genel" metin karşılığı; emin olunmayan büyüklüklerde hesaplanamaz. */
function numberToText(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e15) return String(n);
  if (abs < 1e-4 || abs >= 1e15) unsupported();
  return String(Number(n.toPrecision(15)));
}

function toText(v: Scalar): string | XlError {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberToText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}

/** IF/AND gibi yerlerde mantıksal değer. Metnin nasıl yorumlandığından emin değiliz. */
function toBool(v: Scalar): boolean | XlError {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") unsupported();
  return v;
}

const lower = (s: string) => s.toLowerCase();
const collator = new Intl.Collator("en", { sensitivity: "accent", numeric: false });
const collatorTr = new Intl.Collator("tr", { sensitivity: "accent", numeric: false });

/**
 * I/İ/ı büyük-küçük eşleşmesi Excel'in yerel ayarına bağlı: Türkçe Excel "Çin" ile "ÇİN"i eşit,
 * İngilizce kural ayrı sayar. İki kural farklı sonuç verirse hesaplanamaz; Excel'in önbelleği kalır.
 * Metinlerden birinde bu harflerden hiçbiri yoksa iki kural hep aynı sonucu verir.
 */
const I_LETTERS = /[Iiİı]/;
const lowerTr = (s: string) => s.toLocaleLowerCase("tr");
const iSensitive = (a: string, b: string) => I_LETTERS.test(a) && I_LETTERS.test(b);

function sameText(a: string, b: string): boolean {
  const en = lower(a) === lower(b);
  if (iSensitive(a, b) && en !== (lowerTr(a) === lowerTr(b))) unsupported();
  return en;
}

/** Metin sıralaması: Excel'in harmanlaması noktalama işaretlerinde ICU'dan ayrılabilir. */
function compareText(a: string, b: string): number {
  const order = (x: string, y: string, c: Intl.Collator) => {
    if (x === y) return 0;
    if (!/^[\p{L}\p{N} ]*$/u.test(x) || !/^[\p{L}\p{N} ]*$/u.test(y)) unsupported();
    return Math.sign(c.compare(x, y));
  };
  const en = order(lower(a), lower(b), collator);
  if (iSensitive(a, b) && en !== order(lowerTr(a), lowerTr(b), collatorTr)) unsupported();
  return en;
}

const typeRank = (v: number | string | boolean) =>
  typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;

/** Excel karşılaştırması: sayı < metin < mantıksal; boş hücre karşı tarafın türünde boş değer olur. */
function compare(a: number | string | boolean | null, b: number | string | boolean | null): number {
  const blankOf = (o: number | string | boolean | null) =>
    typeof o === "string" ? "" : typeof o === "boolean" ? false : 0;
  const x = a === null ? blankOf(b) : a;
  const y = b === null ? blankOf(a) : b;
  const rx = typeRank(x);
  const ry = typeRank(y);
  if (rx !== ry) return rx - ry;
  if (typeof x === "number" && typeof y === "number") {
    if (x === y) return 0;
    // Excel eşitlikte 15 basamağa yuvarlar: 0.1+0.2=0.3 DOĞRU'dur.
    const p = round15(x);
    const q = round15(y);
    return p === q ? 0 : p < q ? -1 : 1;
  }
  if (typeof x === "string" && typeof y === "string") return compareText(x, y);
  return x === y ? 0 : x ? 1 : -1;
}

/** Eşitlik: sıralama gerekmediği için metinde harmanlama sorusu doğmaz. */
function equals(a: number | string | boolean | null, b: number | string | boolean | null): boolean {
  if (typeof a === "string" && typeof b === "string") return sameText(a, b);
  if (a === null && typeof b === "string") return b === "";
  if (b === null && typeof a === "string") return a === "";
  return compare(a, b) === 0;
}

/** Joker desen (* ? ~) → düzenli ifade; büyük/küçük harf duyarsız. */
function wildcardRegex(pattern: string, anchored: boolean): RegExp {
  let src = "";
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k] ?? "";
    if (c === "~" && k + 1 < pattern.length && /[*?~]/.test(pattern[k + 1] ?? "")) {
      src += `\\${pattern[k + 1]}`;
      k++;
    } else if (c === "*") src += "[\\s\\S]*";
    else if (c === "?") src += "[\\s\\S]";
    else src += c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${src}$` : src, "i");
}

/** Jokerli eşleşme; I/İ/ı katlamasına bağlı sonuç hesaplanamaz (bkz. `sameText`). */
function wildcardTest(pattern: string, anchored: boolean): (s: string) => boolean {
  const en = wildcardRegex(pattern, anchored);
  const tr = new RegExp(wildcardRegex(lowerTr(pattern), anchored).source);
  return (s) => {
    const hit = en.test(s);
    if (iSensitive(pattern, s) && hit !== tr.test(lowerTr(s))) unsupported();
    return hit;
  };
}

const hasWildcard = (s: string) => /[*?~]/.test(s);

// ─── Tarih ──────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const MAX_SERIAL = 2_958_465; // 9999-12-31

/**
 * Yıl/ay/gün → seri numarası. Ay taşması önce yıla, gün taşması sonra ayın ilk gününe eklenir; böylece
 * 1900 sisteminin hayali 29 Şubat'ı (seri 60) DATE(1900,3,0) gibi taşmalarda da Excel'le aynı çıkar.
 */
function dateSerial(y: number, m: number, d: number, date1904: boolean): number | XlError {
  let year = Math.trunc(y);
  if (year < 0 || year >= 10_000) return NUM;
  if (year < 1900) year += 1900;
  const total = year * 12 + Math.trunc(m) - 1;
  const yy = Math.floor(total / 12);
  const mm = total - yy * 12;
  const first = Date.UTC(yy, mm, 1);
  let serial: number;
  if (date1904) serial = (first - Date.UTC(1904, 0, 1)) / DAY_MS + Math.trunc(d) - 1;
  else {
    let f = (first - Date.UTC(1899, 11, 31)) / DAY_MS;
    if (f > 59) f += 1;
    serial = f + Math.trunc(d) - 1;
  }
  if (serial < 0 || serial > (date1904 ? MAX_SERIAL - 1462 : MAX_SERIAL)) return NUM;
  return serial;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function serialToYmd(serial: number, date1904: boolean): Ymd | XlError {
  if (serial < 0 || serial >= (date1904 ? MAX_SERIAL - 1462 : MAX_SERIAL) + 1) return NUM;
  const s = Math.floor(serial);
  let ms: number;
  if (date1904) ms = Date.UTC(1904, 0, 1) + s * DAY_MS;
  else {
    if (s === 0) return { y: 1900, m: 1, d: 0 };
    if (s === 60) return { y: 1900, m: 2, d: 29 };
    ms = Date.UTC(1899, 11, s < 60 ? 31 : 30) + s * DAY_MS;
  }
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ─── Motor ──────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  sheet: string;
  row: number;
  col: number;
  /** SUMPRODUCT argümanları: işleçler aralıklara öğe öğe uygulanır. */
  array: boolean;
  /** Kök düğüm: Excel son toplama/çıkarmada sıfıra çok yakın sonucu sıfırlar. */
  root: Node;
}

interface SheetIndex {
  /** Sütun → formüllü satırlar (artan). */
  cols: Map<number, number[]>;
  list: [number, number][];
}

interface Frame {
  key: string;
  sheet: string;
  row: number;
  col: number;
  deps: [string, number, number][] | undefined;
  i: number;
}

const MAX_ARRAY_CELLS = 3_000_000;

class Engine {
  readonly sheetByLower = new Map<string, string>();
  readonly names = new Map<string, string>();
  readonly nameAst = new Map<string, Node | null>();
  readonly index = new Map<string, SheetIndex>();
  readonly extents = new Map<string, { rows: number; cols: number }>();
  readonly memo = new Map<string, Scalar | undefined>();
  readonly ast = new Map<string, Node | null>();
  readonly state = new Map<string, number>();
  /**
   * Sayfa+sütun → baştan kaç formüllü satırın hesaplandığı. Her satırda `SUMIF(C:C;…)` ya da
   * birikimli `SUM($B$2:B9)` gibi büyük aralığa bakan formüller hesaplı başı yeniden gezmesin;
   * yoksa kenar sayısı satır × aralık olur (gerçek bir kitapta 82 milyon).
   */
  readonly donePrefix = new Map<string, number>();
  readonly date1904: boolean;
  nested = 0;

  constructor(
    readonly book: CalcWorkbook,
    readonly now: Date,
  ) {
    for (const s of book.sheets) this.sheetByLower.set(lower(s), s);
    for (const [k, v] of book.names ?? []) this.names.set(lower(k), v);
    this.date1904 = book.date1904 === true;
  }

  sheetName(name: string): string {
    return this.sheetByLower.get(lower(name)) ?? unsupported();
  }

  extent(sheet: string) {
    let e = this.extents.get(sheet);
    if (!e) {
      const raw = this.book.extent(sheet);
      e = { rows: Math.min(raw.rows, MAX_ROW), cols: Math.min(raw.cols, MAX_COL) };
      this.extents.set(sheet, e);
    }
    return e;
  }

  /** Sayfadaki formüllü hücreler; ilk gerektiğinde bir kez taranır. */
  sheetIndex(sheet: string): SheetIndex {
    let idx = this.index.get(sheet);
    if (idx) return idx;
    idx = { cols: new Map(), list: [] };
    const { rows, cols } = this.extent(sheet);
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        if (this.book.cell(sheet, r, c)?.formula === undefined) continue;
        idx.list.push([r, c]);
        const arr = idx.cols.get(c);
        if (arr) arr.push(r);
        else idx.cols.set(c, [r]);
      }
    }
    this.index.set(sheet, idx);
    return idx;
  }

  parseCell(key: string, formula: string): Node | null {
    let node = this.ast.get(key);
    if (node === undefined) {
      node = tryParse(formula);
      this.ast.set(key, node);
    }
    return node;
  }

  nameNode(name: string): Node | null {
    const k = lower(name);
    let node = this.nameAst.get(k);
    if (node === undefined) {
      const text = this.names.get(k);
      node = text === undefined ? null : tryParse(text);
      // Göreli ya da sayfasız başvuru içeren ad hücreye göre değişir; desteklenmez.
      if (node && !absoluteRefs(node)) node = null;
      this.nameAst.set(k, node);
    }
    return node;
  }

  /** Düğümün başvurduğu dikdörtgenler (sayfa, üst, sol, alt, sağ). */
  rects(
    node: Node,
    sheet: string,
    out: [string, number, number, number, number][],
    seen: Set<string>,
  ) {
    const walk = (n: Node): void => {
      switch (n.t) {
        case "ref": {
          const name = n.sheet === undefined ? sheet : this.sheetByLower.get(lower(n.sheet));
          if (name === undefined) return;
          const r = refRect(n);
          out.push([name, r.top, r.left, r.bottom, r.right]);
          return;
        }
        case "name": {
          const k = lower(n.name);
          if (seen.has(k)) return;
          seen.add(k);
          const target = this.nameNode(n.name);
          if (target) walk(target);
          return;
        }
        case "fn":
          for (const a of n.args) walk(a);
          return;
        case "neg":
        case "pct":
          walk(n.e);
          return;
        case "bin":
          walk(n.l);
          walk(n.r);
          return;
        case "range": {
          // A1:INDEX(D:D,5) iki ucun arasındaki sütunları da kapsar: sınırlayıcı kutu eklenir.
          const start = out.length;
          walk(n.l);
          walk(n.r);
          const part = out.slice(start);
          const first = part[0];
          if (first && part.every((p) => p[0] === first[0])) {
            out.push([
              first[0],
              Math.min(...part.map((p) => p[1])),
              Math.min(...part.map((p) => p[2])),
              Math.max(...part.map((p) => p[3])),
              Math.max(...part.map((p) => p[4])),
            ]);
          }
          return;
        }
        default:
          return;
      }
    };
    walk(node);
  }

  /** Düğümün bağlı olduğu formüllü hücreler. */
  deps(node: Node, sheet: string): [string, number, number][] {
    const rects: [string, number, number, number, number][] = [];
    this.rects(node, sheet, rects, new Set());
    const out: [string, number, number][] = [];
    for (const [s, top, left, bottom, right] of rects) {
      const idx = this.sheetIndex(s);
      const ext = this.extent(s);
      const lastCol = Math.min(right, ext.cols);
      for (let c = left; c <= lastCol; c++) {
        const rows = idx.cols.get(c);
        if (!rows) continue;
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((rows[mid] ?? 0) < top) lo = mid + 1;
          else hi = mid;
        }
        for (let k = Math.max(lo, this.prefix(s, c, rows)); k < rows.length; k++) {
          const r = rows[k] ?? 0;
          if (r > bottom) break;
          out.push([s, r, c]);
        }
      }
    }
    return out;
  }

  /** Sütunun baştan hesaplanmış formüllü satır sayısı; işaretçi yalnız ileri gider. */
  prefix(sheet: string, col: number, rows: number[]): number {
    const key = `${sheet}\u0000${col}`;
    let p = this.donePrefix.get(key) ?? 0;
    while (p < rows.length && this.state.get(calcKey(sheet, rows[p] ?? 0, col)) === 2) p++;
    this.donePrefix.set(key, p);
    return p;
  }

  /**
   * Formüllü hücreyi ve bağımlılıklarını açık yığınla (özyinelemesiz) sonradan-sıralı hesaplar;
   * yığında tekrar görülen hücre döngüdür ve döngüdeki tüm hücreler `undefined` olur.
   */
  ensure(sheet: string, row: number, col: number): void {
    const rootKey = calcKey(sheet, row, col);
    if (this.state.has(rootKey)) return;
    const cyclic = new Set<string>();
    const stack: Frame[] = [];
    const onStack = new Map<string, number>();
    const push = (s: string, r: number, c: number, key: string) => {
      this.state.set(key, 1);
      onStack.set(key, stack.length);
      stack.push({ key, sheet: s, row: r, col: c, deps: undefined, i: 0 });
    };
    push(sheet, row, col, rootKey);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      if (!top.deps) {
        const formula = this.book.cell(top.sheet, top.row, top.col)?.formula;
        const node = formula === undefined ? null : this.parseCell(top.key, formula);
        top.deps = node ? this.deps(node, top.sheet) : [];
      }
      const dep = top.deps[top.i++];
      if (dep) {
        const [s, r, c] = dep;
        const key = calcKey(s, r, c);
        const st = this.state.get(key);
        if (st === undefined) push(s, r, c, key);
        else if (st === 1) {
          // Dıştaki bir ensure yığınındaki hücre de döngüdür; yalnız bu hücre işaretlenir.
          const at = onStack.get(key);
          if (at === undefined) cyclic.add(top.key);
          else for (let k = at; k < stack.length; k++) cyclic.add(stack[k]?.key ?? "");
        }
        continue;
      }
      stack.pop();
      onStack.delete(top.key);
      this.state.set(top.key, 2);
      this.memo.set(top.key, cyclic.has(top.key) ? undefined : this.evalCell(top));
      this.ast.delete(top.key);
    }
  }

  evalCell(f: Frame): Scalar | undefined {
    const formula = this.book.cell(f.sheet, f.row, f.col)?.formula;
    if (formula === undefined) return undefined;
    const node = this.parseCell(f.key, formula);
    if (!node) return undefined;
    return this.run(node, f.sheet, f.row, f.col);
  }

  /** Kök değerlendirme: aralık sonucu örtük kesişimle tek değere iner, taşma hesaplanmaz. */
  run(node: Node, sheet: string, row: number, col: number): Scalar | undefined {
    const ctx: Ctx = { sheet, row, col, array: false, root: node };
    try {
      const v = this.ev(node, ctx);
      let s: Scalar;
      if (isArr(v)) {
        const only = v.rows.length === 1 && v.rows[0]?.length === 1 ? v.rows[0][0] : undefined;
        if (only === undefined) return undefined;
        s = only;
      } else s = this.scalarOf(v, ctx);
      if (s === null || s === 0) return 0;
      if (typeof s === "number") return Number.isFinite(s) ? round15(s) : NUM;
      return s;
    } catch {
      return undefined;
    }
  }

  /** Hücre değeri; formüllü hücrede hesaplanmış sonuç (hesaplanamadıysa hesaplanamaz). */
  get(sheet: string, row: number, col: number): Scalar {
    const cell = this.book.cell(sheet, row, col);
    if (!cell) return null;
    if (cell.formula === undefined) return cell.value;
    const key = calcKey(sheet, row, col);
    if (!this.state.has(key)) {
      // Bağımlılık çözümlemesinin kaçırdığı hücre: iç içe ensure, derinlik sınırlı.
      if (this.nested > 50) unsupported();
      this.nested++;
      try {
        this.ensure(sheet, row, col);
      } finally {
        this.nested--;
      }
    }
    const v = this.memo.get(key);
    if (v === undefined) unsupported();
    return v;
  }

  /** Aralık → tek değer: 1×1 ise o hücre, değilse formülün satırı/sütunuyla örtük kesişim. */
  scalarOf(v: Val, ctx: Ctx): Scalar {
    if (isArr(v)) {
      const only = v.rows.length === 1 && v.rows[0]?.length === 1 ? v.rows[0][0] : undefined;
      return only === undefined ? unsupported() : only;
    }
    if (!isRng(v)) return v;
    if (v.top === v.bottom && v.left === v.right) return this.get(v.sheet, v.top, v.left);
    if (ctx.array) unsupported();
    if (v.left === v.right && ctx.row >= v.top && ctx.row <= v.bottom)
      return this.get(v.sheet, ctx.row, v.left);
    if (v.top === v.bottom && ctx.col >= v.left && ctx.col <= v.right)
      return this.get(v.sheet, v.top, ctx.col);
    return VALUE;
  }

  ev(node: Node, ctx: Ctx): Val {
    return evalNode(this, node, ctx);
  }

  scalar(node: Node, ctx: Ctx): Scalar {
    return this.scalarOf(this.ev(node, ctx), ctx);
  }

  /** Aralığın dolu kısmındaki hücreler (satır satır); `extent` dışı boş sayılır ve atlanır. */
  each(v: Val, fn: (s: Scalar, r: number, c: number) => boolean | undefined): void {
    if (isRng(v)) {
      const ext = this.extent(v.sheet);
      const bottom = Math.min(v.bottom, ext.rows);
      const right = Math.min(v.right, ext.cols);
      for (let r = v.top; r <= bottom; r++)
        for (let c = v.left; c <= right; c++)
          if (fn(this.get(v.sheet, r, c), r - v.top, c - v.left) === false) return;
      return;
    }
    if (isArr(v)) {
      v.rows.forEach((row, r) => {
        row.forEach((s, c) => {
          fn(s, r, c);
        });
      });
      return;
    }
    fn(v, 0, 0);
  }

  /** Aralığın `extent` ile kırpılmış alanı (tüm sütun başvurusunda kalan hücreler boştur). */
  clippedArea(v: Val): number {
    if (!isRng(v)) return dims(v).h * dims(v).w;
    const ext = this.extent(v.sheet);
    const h = Math.max(0, Math.min(v.bottom, ext.rows) - v.top + 1);
    const w = Math.max(0, Math.min(v.right, ext.cols) - v.left + 1);
    return h * w;
  }

  at(v: Val, r: number, c: number): Scalar {
    if (isRng(v)) return this.get(v.sheet, v.top + r, v.left + c);
    if (isArr(v)) return v.rows[r]?.[c] ?? null;
    return v;
  }

  matrix(v: Val): Scalar[][] {
    if (isArr(v)) return v.rows;
    if (!isRng(v)) return [[v]];
    const { h, w } = dims(v);
    if (h * w > MAX_ARRAY_CELLS) unsupported();
    const ext = this.extent(v.sheet);
    const out: Scalar[][] = [];
    for (let r = 0; r < h; r++) {
      const row: Scalar[] = [];
      for (let c = 0; c < w; c++) {
        const rr = v.top + r;
        const cc = v.left + c;
        row.push(rr > ext.rows || cc > ext.cols ? null : this.get(v.sheet, rr, cc));
      }
      out.push(row);
    }
    return out;
  }
}

function tryParse(text: string): Node | null {
  try {
    return Parser.parse(text.startsWith("=") ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function refRect(n: { a: RefPart; b?: RefPart }) {
  const b = n.b ?? n.a;
  const rows = [n.a.row, b.row];
  const cols = [n.a.col, b.col];
  const top = Math.min(rows[0] ?? 1, rows[1] ?? 1);
  const bottom = n.a.row === undefined ? MAX_ROW : Math.max(rows[0] ?? 1, rows[1] ?? 1);
  const left = Math.min(cols[0] ?? 1, cols[1] ?? 1);
  const right = n.a.col === undefined ? MAX_COL : Math.max(cols[0] ?? 1, cols[1] ?? 1);
  return { top, left, bottom, right };
}

function absoluteRefs(node: Node): boolean {
  switch (node.t) {
    case "ref":
      return node.sheet !== undefined && node.a.abs && (node.b?.abs ?? true);
    case "fn":
      return node.args.every(absoluteRefs);
    case "neg":
    case "pct":
      return absoluteRefs(node.e);
    case "bin":
    case "range":
      return absoluteRefs(node.l) && absoluteRefs(node.r);
    default:
      return true;
  }
}

function dims(v: Val): { h: number; w: number } {
  if (isRng(v)) return { h: v.bottom - v.top + 1, w: v.right - v.left + 1 };
  if (isArr(v)) return { h: v.rows.length, w: v.rows[0]?.length ?? 0 };
  return { h: 1, w: 1 };
}

// ─── Değerlendirme ──────────────────────────────────────────────────────────────────────────────

const activeNames = new Set<string>();

function evalNode(e: Engine, node: Node, ctx: Ctx): Val {
  switch (node.t) {
    case "lit":
      return node.v;
    case "arr":
      return { kind: "array", rows: node.rows };
    case "missing":
      return null;
    case "ref": {
      const sheet = node.sheet === undefined ? ctx.sheet : e.sheetName(node.sheet);
      return { kind: "range", sheet, ...refRect(node) };
    }
    case "name": {
      const k = lower(node.name);
      const target = e.nameNode(node.name);
      // Bilinmeyen ad sayfa düzeyinde tanımlı olabilir; #NAME? demek yanlış olabilir.
      if (!target || activeNames.has(k)) unsupported();
      activeNames.add(k);
      try {
        return e.ev(target, ctx);
      } finally {
        activeNames.delete(k);
      }
    }
    case "fn":
      return callFn(e, node.name, node.args, ctx);
    case "neg":
      return mapUnary(e, e.ev(node.e, ctx), ctx, (n) => -n);
    case "pct":
      return mapUnary(e, e.ev(node.e, ctx), ctx, (n) => n / 100);
    case "bin":
      return binary(e, node, ctx);
    case "range": {
      const l = e.ev(node.l, ctx);
      const r = e.ev(node.r, ctx);
      if (!isRng(l) || !isRng(r) || l.sheet !== r.sheet) unsupported();
      return {
        kind: "range",
        sheet: l.sheet,
        top: Math.min(l.top, r.top),
        left: Math.min(l.left, r.left),
        bottom: Math.max(l.bottom, r.bottom),
        right: Math.max(l.right, r.right),
      };
    }
  }
}

function mapUnary(e: Engine, v: Val, ctx: Ctx, fn: (n: number) => number): Val {
  const one = (s: Scalar): Scalar => {
    const n = toNumber(s);
    return isError(n) ? n : fn(n);
  };
  if (ctx.array && (isRng(v) || isArr(v))) {
    const { h, w } = dims(v);
    if (h * w !== 1) return { kind: "array", rows: e.matrix(v).map((row) => row.map(one)) };
  }
  return one(e.scalarOf(v, ctx));
}

function binary(e: Engine, node: { op: string; l: Node; r: Node }, ctx: Ctx): Val {
  const { op } = node;
  if (ctx.array) {
    const a = e.ev(node.l, ctx);
    const b = e.ev(node.r, ctx);
    const da = dims(a);
    const db = dims(b);
    if (da.h * da.w !== 1 || db.h * db.w !== 1) {
      const ma = e.matrix(a);
      const mb = e.matrix(b);
      const h = Math.max(da.h, db.h);
      const w = Math.max(da.w, db.w);
      // Yayma: eşit boyut, tek hücre ya da tek satır/sütun. Uymayan boyutta Excel #N/A doldurur.
      const fits = (d: { h: number; w: number }) =>
        (d.h === h || d.h === 1) && (d.w === w || d.w === 1);
      if (!fits(da) || !fits(db)) unsupported();
      const rows: Scalar[][] = [];
      for (let r = 0; r < h; r++) {
        const row: Scalar[] = [];
        for (let c = 0; c < w; c++) {
          const x = ma[da.h === 1 ? 0 : r]?.[da.w === 1 ? 0 : c] ?? null;
          const y = mb[db.h === 1 ? 0 : r]?.[db.w === 1 ? 0 : c] ?? null;
          row.push(scalarOp(op, x, y, false));
        }
        rows.push(row);
      }
      return { kind: "array", rows };
    }
    return scalarOp(op, e.scalarOf(a, ctx), e.scalarOf(b, ctx), node === ctx.root);
  }
  return scalarOp(op, e.scalar(node.l, ctx), e.scalar(node.r, ctx), node === ctx.root);
}

function scalarOp(op: string, a: Scalar, b: Scalar, root: boolean): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === "&") {
    const x = toText(a);
    const y = toText(b);
    if (isError(x)) return x;
    if (isError(y)) return y;
    return x.length + y.length > MAX_TEXT ? VALUE : x + y;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    if (op === "=") return equals(a, b);
    if (op === "<>") return !equals(a, b);
    const c = compare(a, b);
    switch (op) {
      case "<":
        return c < 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      default:
        return c >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  let r: number;
  switch (op) {
    case "+":
      r = x + y;
      break;
    case "-":
      r = x - y;
      break;
    case "*":
      r = x * y;
      break;
    case "/":
      if (y === 0) return DIV0;
      r = x / y;
      break;
    case "^":
      if (x === 0 && y === 0) return NUM;
      if (x === 0 && y < 0) return DIV0;
      r = x ** y;
      break;
    default:
      unsupported();
  }
  if (!Number.isFinite(r)) return NUM;
  // Excel son toplama/çıkarmada sıfıra çok yakın sonucu 0'a çeker (=0.3-0.2-0.1); kuralı tam
  // bilinmediğinden bu durumda hesaplanmaz.
  if (
    root &&
    (op === "+" || op === "-") &&
    r !== 0 &&
    Math.abs(r) < Math.max(Math.abs(x), Math.abs(y)) * 1e-14
  )
    unsupported();
  return r;
}

// ─── İşlevler: yardımcılar ──────────────────────────────────────────────────────────────────────

type Fn = (e: Engine, args: Node[], ctx: Ctx) => Val;

/** Excel kabul etmeyeceği argüman sayısı dosyada olmaz; olursa hesaplanmaz. */
function arity(args: Node[], min: number, max = min) {
  if (args.length < min || args.length > max) unsupported();
}

function numArg(e: Engine, node: Node | undefined, ctx: Ctx, fallback?: number): number | XlError {
  if (!node || node.t === "missing") return fallback ?? 0;
  return toNumber(e.scalar(node, ctx));
}

function intArg(e: Engine, node: Node | undefined, ctx: Ctx, fallback?: number): number | XlError {
  const n = numArg(e, node, ctx, fallback);
  return isError(n) ? n : Math.trunc(n);
}

function textArg(e: Engine, node: Node | undefined, ctx: Ctx): string | XlError {
  if (!node) return "";
  return toText(e.scalar(node, ctx));
}

/** Tek sayı argümanlı işlev. */
const num1 =
  (fn: (n: number) => number | XlError): Fn =>
  (e, args, ctx) => {
    arity(args, 1);
    const n = numArg(e, args[0], ctx);
    return isError(n) ? n : fn(n);
  };

/** Tek metin argümanlı işlev. */
const text1 =
  (fn: (s: string) => Scalar): Fn =>
  (e, args, ctx) => {
    arity(args, 1);
    const s = textArg(e, args[0], ctx);
    return isError(s) ? s : fn(s);
  };

/**
 * SUM/AVERAGE/MIN/MAX sayıları: aralıktaki metin ve mantıksal yok sayılır, doğrudan argüman olan
 * sayısal metin ve mantıksal sayılır; hata yayılır.
 */
function numbers(e: Engine, args: Node[], ctx: Ctx): number[] | XlError {
  const out: number[] = [];
  for (const arg of args) {
    if (arg.t === "missing") unsupported();
    const v = e.ev(arg, ctx);
    if (isRng(v) || isArr(v)) {
      let bad: XlError | undefined;
      e.each(v, (s) => {
        if (typeof s === "number") out.push(s);
        else if (isError(s)) {
          bad = s;
          return false;
        }
        return undefined;
      });
      if (bad) return bad;
      continue;
    }
    if (v === null) unsupported();
    const n = toNumber(v);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

const sum = (xs: number[]) => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};

// ─── Ölçütler ───────────────────────────────────────────────────────────────────────────────────

type Test = (s: Scalar) => boolean;

/** Ölçüt hücresindeki metnin sayı olup olmadığı; tarih gibi görünen metin hesaplanamaz. */
function cellNumber(s: string): number | undefined {
  const t = s.trim();
  if (STRICT_NUMBER.test(t)) return Number(t);
  if (/\d/.test(t)) unsupported();
  return undefined;
}

function criterion(c: Scalar): Test {
  // Boş ya da hata değerli ölçüt hücresinin Excel'deki yorumundan emin değiliz.
  if (c === null || isError(c)) unsupported();
  if (typeof c === "boolean") {
    return (s) => {
      if (typeof s === "string" && /^(true|false)$/i.test(s)) unsupported();
      return s === c;
    };
  }
  if (typeof c === "number") return numberEq(c);
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c);
  const op = m?.[1] ?? "";
  const v = m?.[2] ?? "";
  const neg =
    (t: Test): Test =>
    (s) =>
      !t(s);
  if (v === "") {
    const blankOrEmpty = (s: Scalar) => {
      if (s === "" && op !== "") unsupported();
      return s === null || s === "";
    };
    if (op === "") return blankOrEmpty;
    if (op === "=") return blankOrEmpty;
    if (op === "<>") return neg(blankOrEmpty);
    unsupported();
  }
  const eqOrNe = (t: Test): Test => {
    if (op === "" || op === "=") return t;
    if (op === "<>") return neg(t);
    return unsupported();
  };
  if (STRICT_NUMBER.test(v)) {
    const n = Number(v);
    if (op === "" || op === "=" || op === "<>") return eqOrNe(numberEq(n));
    return (s) => {
      if (typeof s !== "number") return false;
      const d = compare(s, n);
      return op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
    };
  }
  const upper = v.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return eqOrNe(criterion(upper === "TRUE"));
  const code = ERROR_CODES.find((x) => x === upper);
  if (code) return eqOrNe((s) => isError(s) && s.error === code);
  if (/\d/.test(v)) unsupported();
  if (op === "" || op === "=" || op === "<>") {
    const re = hasWildcard(v) ? wildcardTest(v, true) : undefined;
    return eqOrNe((s) => typeof s === "string" && (re ? re(s) : sameText(s, v)));
  }
  return (s) => {
    if (typeof s !== "string") return false;
    const d = compareText(s, v);
    return op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
  };
}

/** Sayı ölçütü sayısal metinle de eşleşir. */
function numberEq(n: number): Test {
  return (s) => {
    if (typeof s === "number") return compare(s, n) === 0;
    if (typeof s === "string") {
      const x = cellNumber(s);
      return x !== undefined && compare(x, n) === 0;
    }
    return false;
  };
}

/** Aralığın `extent` içindeki yüksekliği/genişliği; ötesi boştur. */
function clipped(e: Engine, v: Val): { h: number; w: number } {
  const d = dims(v);
  if (!isRng(v)) return d;
  const ext = e.extent(v.sheet);
  return {
    h: Math.max(0, Math.min(v.bottom, ext.rows) - v.top + 1),
    w: Math.max(0, Math.min(v.right, ext.cols) - v.left + 1),
  };
}

/**
 * Ölçüt çiftleri: tüm aralıklar aynı boyutta olmalı. `visit` eşleşen her konum için çağrılır;
 * dolu alanın dışında kalan (tümü boş) konumların sayısı ayrıca döner.
 */
function matchPositions(
  e: Engine,
  ranges: Val[],
  tests: Test[],
  extra: Val[],
  visit: (r: number, c: number) => boolean | undefined,
): number | XlError {
  const first = ranges[0];
  if (!first) unsupported();
  const d = dims(first);
  for (const r of ranges) {
    if (!isRng(r) && !isArr(r)) return VALUE;
    const x = dims(r);
    if (x.h !== d.h || x.w !== d.w) return VALUE;
  }
  let lh = 0;
  let lw = 0;
  for (const r of [...ranges, ...extra]) {
    const c = clipped(e, r);
    lh = Math.max(lh, Math.min(c.h, d.h));
    lw = Math.max(lw, Math.min(c.w, d.w));
  }
  for (let r = 0; r < lh; r++) {
    for (let c = 0; c < lw; c++) {
      let ok = true;
      for (let k = 0; k < ranges.length && ok; k++) {
        const range = ranges[k];
        const test = tests[k];
        if (range === undefined || !test) break;
        ok = test(e.at(range, r, c));
      }
      if (ok && visit(r, c) === false) return 0;
    }
  }
  const rest = d.h * d.w - lh * lw;
  return rest > 0 && tests.every((t) => t(null)) ? rest : 0;
}

/** SUMIF(S)/AVERAGEIF(S) için eşleşen konumlardaki sayılar; toplam aralığındaki hata yayılır. */
function matchedNumbers(e: Engine, ranges: Val[], tests: Test[], target: Val): number[] | XlError {
  if (!isRng(target)) unsupported();
  const out: number[] = [];
  let bad: XlError | undefined;
  const res = matchPositions(e, ranges, tests, [target], (r, c) => {
    const s = e.get(target.sheet, target.top + r, target.left + c);
    if (typeof s === "number") out.push(s);
    else if (isError(s)) {
      bad = s;
      return false;
    }
    return undefined;
  });
  if (isError(res)) return res;
  return bad ?? out;
}

function criteriaArgs(
  e: Engine,
  args: Node[],
  ctx: Ctx,
  from: number,
): { ranges: Val[]; tests: Test[] } | XlError {
  const ranges: Val[] = [];
  const tests: Test[] = [];
  for (let k = from; k < args.length; k += 2) {
    const rn = args[k];
    const cn = args[k + 1];
    if (!rn || !cn) unsupported();
    const range = e.ev(rn, ctx);
    if (!isRng(range)) unsupported();
    ranges.push(range);
    const c = e.scalar(cn, ctx);
    tests.push(criterion(c));
  }
  return { ranges, tests };
}

// ─── İşlevler: matematik ────────────────────────────────────────────────────────────────────────

/**
 * Yarıda sıfırdan uzağa (ya da yukarı/aşağı) yuvarlama. Ölçekli değer önce 15 basamağa çekilir ki
 * 2.675*100 = 267.49999999999997 gibi kayan nokta artıkları Excel'deki gibi 268'e gitsin.
 */
function roundTo(x: number, digits: number, mode: "half" | "up" | "down"): number {
  const d = Math.trunc(digits);
  if (d > 15) return x;
  if (d < -308) return 0;
  const scale = 10 ** Math.abs(d);
  const y = round15(d >= 0 ? x * scale : x / scale);
  const a = Math.abs(y);
  const r =
    Math.sign(y) *
    (mode === "half" ? Math.floor(a + 0.5) : mode === "up" ? Math.ceil(a) : Math.floor(a));
  return round15(d >= 0 ? r / scale : r * scale);
}

const roundFn =
  (mode: "half" | "up" | "down", defaultDigits?: number): Fn =>
  (e, args, ctx) => {
    arity(args, defaultDigits === undefined ? 2 : 1, 2);
    const x = numArg(e, args[0], ctx);
    if (isError(x)) return x;
    const d = numArg(e, args[1], ctx, defaultDigits);
    if (isError(d)) return d;
    return roundTo(x, d, mode);
  };

const num2 =
  (fn: (a: number, b: number) => Scalar, defaultB?: number): Fn =>
  (e, args, ctx) => {
    arity(args, defaultB === undefined ? 2 : 1, 2);
    const a = numArg(e, args[0], ctx);
    if (isError(a)) return a;
    const b = numArg(e, args[1], ctx, defaultB);
    if (isError(b)) return b;
    return fn(a, b);
  };

const MATH: Record<string, Fn> = {
  ROUND: roundFn("half"),
  ROUNDUP: roundFn("up"),
  ROUNDDOWN: roundFn("down"),
  TRUNC: roundFn("down", 0),
  INT: num1(Math.floor),
  ABS: num1(Math.abs),
  SIGN: num1(Math.sign),
  SQRT: num1((n) => (n < 0 ? NUM : Math.sqrt(n))),
  EXP: num1(Math.exp),
  LN: num1((n) => (n <= 0 ? NUM : Math.log(n))),
  LOG10: num1((n) => (n <= 0 ? NUM : Math.log10(n))),
  LOG: num2((x, b) => {
    if (x <= 0 || b <= 0) return NUM;
    if (b === 1) return DIV0;
    return b === 10 ? Math.log10(x) : Math.log(x) / Math.log(b);
  }, 10),
  PI: (_e, args) => {
    arity(args, 0);
    return Math.PI;
  },
  MOD: num2((n, d) => (d === 0 ? DIV0 : n - d * Math.floor(round15(n / d)))),
  POWER: num2((x, y) => scalarOp("^", x, y, false)),
  // Klasik iki argümanlı CEILING/FLOOR: pozitif sayı + negatif anlam #NUM!.
  CEILING: num2((x, s) => {
    if (s === 0) return 0;
    if (x > 0 && s < 0) return NUM;
    return round15(Math.ceil(round15(x / s)) * s);
  }),
  FLOOR: num2((x, s) => {
    if (s === 0) return x === 0 ? 0 : DIV0;
    if (x > 0 && s < 0) return NUM;
    return round15(Math.floor(round15(x / s)) * s);
  }),
  MROUND: num2((n, m) => {
    if (m === 0 || n === 0) return 0;
    if (n * m < 0) return NUM;
    return round15(Math.floor(round15(n / m) + 0.5) * m);
  }),
};

// ─── İşlevler: toplama ──────────────────────────────────────────────────────────────────────────

const AGG: Record<string, Fn> = {
  SUM: (e, args, ctx) => {
    const xs = numbers(e, args, ctx);
    return isError(xs) ? xs : sum(xs);
  },
  AVERAGE: (e, args, ctx) => {
    const xs = numbers(e, args, ctx);
    if (isError(xs)) return xs;
    return xs.length === 0 ? DIV0 : sum(xs) / xs.length;
  },
  MIN: (e, args, ctx) => {
    const xs = numbers(e, args, ctx);
    if (isError(xs)) return xs;
    return xs.length === 0 ? 0 : xs.reduce((a, b) => (b < a ? b : a));
  },
  MAX: (e, args, ctx) => {
    const xs = numbers(e, args, ctx);
    if (isError(xs)) return xs;
    return xs.length === 0 ? 0 : xs.reduce((a, b) => (b > a ? b : a));
  },
  COUNT: (e, args, ctx) => {
    let n = 0;
    for (const arg of args) {
      if (arg.t === "missing") unsupported();
      const v = e.ev(arg, ctx);
      if (isRng(v) || isArr(v)) {
        e.each(v, (s) => {
          if (typeof s === "number") n++;
          return undefined;
        });
      } else if (typeof v === "number" || typeof v === "boolean") n++;
      else if (typeof v === "string" && !isError(textToNumber(v))) n++;
    }
    return n;
  },
  COUNTA: (e, args, ctx) => {
    let n = 0;
    for (const arg of args) {
      if (arg.t === "missing") unsupported();
      const v = e.ev(arg, ctx);
      if (isRng(v) || isArr(v)) {
        e.each(v, (s) => {
          if (s !== null) n++;
          return undefined;
        });
      } else n++;
    }
    return n;
  },
  COUNTBLANK: (e, args, ctx) => {
    arity(args, 1);
    const [a] = args;
    const v = a ? e.ev(a, ctx) : null;
    if (!isRng(v)) unsupported();
    let n = 0;
    e.each(v, (s) => {
      if (s === null || s === "") n++;
      return undefined;
    });
    const { h, w } = dims(v);
    return n + h * w - e.clippedArea(v);
  },
  SUMPRODUCT: (e, args, ctx) => {
    if (args.length === 0) unsupported();
    const actx: Ctx = { ...ctx, array: true };
    const ms: Scalar[][][] = [];
    for (const arg of args) {
      if (arg.t === "missing") unsupported();
      ms.push(e.matrix(e.ev(arg, actx)));
    }
    const first = ms[0] ?? [];
    const h = first.length;
    const w = first[0]?.length ?? 0;
    if (ms.some((m) => m.length !== h || (m[0]?.length ?? 0) !== w)) return VALUE;
    for (const m of ms) for (const row of m) for (const s of row) if (isError(s)) return s;
    let total = 0;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let p = 1;
        for (const m of ms) {
          const s = m[r]?.[c] ?? null;
          p *= typeof s === "number" ? s : 0;
        }
        total += p;
      }
    }
    return total;
  },
  COUNTIF: (e, args, ctx) => {
    arity(args, 2);
    return countIfs(e, args, ctx);
  },
  COUNTIFS: (e, args, ctx) => {
    if (args.length < 2 || args.length % 2 !== 0) unsupported();
    return countIfs(e, args, ctx);
  },
  SUMIF: (e, args, ctx) => ifAggregate(e, args, ctx, "sum", false),
  SUMIFS: (e, args, ctx) => ifAggregate(e, args, ctx, "sum", true),
  AVERAGEIF: (e, args, ctx) => ifAggregate(e, args, ctx, "avg", false),
  AVERAGEIFS: (e, args, ctx) => ifAggregate(e, args, ctx, "avg", true),
};

function countIfs(e: Engine, args: Node[], ctx: Ctx): Scalar {
  const crit = criteriaArgs(e, args, ctx, 0);
  if (isError(crit)) return crit;
  let n = 0;
  const rest = matchPositions(e, crit.ranges, crit.tests, [], () => {
    n++;
    return undefined;
  });
  return isError(rest) ? rest : n + rest;
}

/** SUMIF/AVERAGEIF (ölçüt, ölçüt, [hedef]) ve SUMIFS/AVERAGEIFS (hedef, aralık, ölçüt, …). */
function ifAggregate(
  e: Engine,
  args: Node[],
  ctx: Ctx,
  kind: "sum" | "avg",
  multi: boolean,
): Scalar {
  let crit: { ranges: Val[]; tests: Test[] } | XlError;
  let target: Val;
  if (multi) {
    if (args.length < 3 || args.length % 2 !== 1) unsupported();
    const [t] = args;
    target = t ? e.ev(t, ctx) : null;
    crit = criteriaArgs(e, args, ctx, 1);
    if (isError(crit)) return crit;
    const d0 = dims(target);
    const d1 = crit.ranges[0] ? dims(crit.ranges[0]) : d0;
    if (d0.h !== d1.h || d0.w !== d1.w) return VALUE;
  } else {
    arity(args, 2, 3);
    crit = criteriaArgs(e, args.slice(0, 2), ctx, 0);
    if (isError(crit)) return crit;
    const range = crit.ranges[0];
    const t = args[2];
    if (!range) unsupported();
    if (t && t.t !== "missing") {
      const v = e.ev(t, ctx);
      if (!isRng(v)) unsupported();
      // Excel toplam aralığını ölçüt aralığının boyutuna, sol üst köşesinden genişletir.
      const d = dims(range);
      target = { ...v, bottom: v.top + d.h - 1, right: v.left + d.w - 1 };
      if (target.bottom > MAX_ROW || target.right > MAX_COL) unsupported();
    } else target = range;
  }
  const xs = matchedNumbers(e, crit.ranges, crit.tests, target);
  if (isError(xs)) return xs;
  if (kind === "sum") return sum(xs);
  return xs.length === 0 ? DIV0 : sum(xs) / xs.length;
}

// ─── İşlevler: mantıksal ────────────────────────────────────────────────────────────────────────

/** Seçilen dalı hesaplar; boş argüman (IF(A1,,1)) 0 döner. */
function branch(e: Engine, node: Node | undefined, ctx: Ctx): Val {
  if (!node || node.t === "missing") return 0;
  return e.ev(node, ctx);
}

function logicals(e: Engine, args: Node[], ctx: Ctx): boolean[] | XlError {
  const out: boolean[] = [];
  for (const arg of args) {
    if (arg.t === "missing") unsupported();
    const v = e.ev(arg, ctx);
    if (isRng(v) || isArr(v)) {
      let bad: XlError | undefined;
      e.each(v, (s) => {
        if (typeof s === "boolean") out.push(s);
        else if (typeof s === "number") out.push(s !== 0);
        else if (isError(s)) {
          bad = s;
          return false;
        }
        return undefined;
      });
      if (bad) return bad;
      continue;
    }
    const b = toBool(v);
    if (isError(b)) return b;
    if (v === null) unsupported();
    out.push(b);
  }
  return out.length === 0 ? VALUE : out;
}

const LOGIC: Record<string, Fn> = {
  IF: (e, args, ctx) => {
    arity(args, 2, 3);
    const c = toBool(e.scalar(args[0] ?? { t: "missing" }, ctx));
    if (isError(c)) return c;
    if (c) return branch(e, args[1], ctx);
    return args.length < 3 ? false : branch(e, args[2], ctx);
  },
  IFS: (e, args, ctx) => {
    if (args.length < 2 || args.length % 2 !== 0) unsupported();
    for (let k = 0; k < args.length; k += 2) {
      const c = toBool(e.scalar(args[k] ?? { t: "missing" }, ctx));
      if (isError(c)) return c;
      if (c) return branch(e, args[k + 1], ctx);
    }
    return NA;
  },
  IFERROR: (e, args, ctx) => {
    arity(args, 2);
    const v = e.scalar(args[0] ?? { t: "missing" }, ctx);
    return isError(v) ? branch(e, args[1], ctx) : v;
  },
  IFNA: (e, args, ctx) => {
    arity(args, 2);
    const v = e.scalar(args[0] ?? { t: "missing" }, ctx);
    return isError(v) && v.error === "#N/A" ? branch(e, args[1], ctx) : v;
  },
  AND: (e, args, ctx) => {
    const bs = logicals(e, args, ctx);
    return isError(bs) ? bs : bs.every(Boolean);
  },
  OR: (e, args, ctx) => {
    const bs = logicals(e, args, ctx);
    return isError(bs) ? bs : bs.some(Boolean);
  },
  XOR: (e, args, ctx) => {
    const bs = logicals(e, args, ctx);
    return isError(bs) ? bs : bs.filter(Boolean).length % 2 === 1;
  },
  NOT: (e, args, ctx) => {
    arity(args, 1);
    const b = toBool(e.scalar(args[0] ?? { t: "missing" }, ctx));
    return isError(b) ? b : !b;
  },
  TRUE: (_e, args) => {
    arity(args, 0);
    return true;
  },
  FALSE: (_e, args) => {
    arity(args, 0);
    return false;
  },
  NA: (_e, args) => {
    arity(args, 0);
    return NA;
  },
  CHOOSE: (e, args, ctx) => {
    if (args.length < 2) unsupported();
    const i = intArg(e, args[0], ctx);
    if (isError(i)) return i;
    if (i < 1 || i >= args.length) return VALUE;
    return branch(e, args[i], ctx);
  },
  SWITCH: (e, args, ctx) => {
    if (args.length < 3) unsupported();
    const x = e.scalar(args[0] ?? { t: "missing" }, ctx);
    if (isError(x)) return x;
    if (x === null) unsupported();
    let k = 1;
    for (; k + 1 < args.length; k += 2) {
      const v = e.scalar(args[k] ?? { t: "missing" }, ctx);
      if (isError(v) || v === null) unsupported();
      if (typeof v !== typeof x) continue;
      if (typeof v === "string" && typeof x === "string" && v !== x) {
        // Büyük/küçük harf farkında SWITCH'in davranışından emin değiliz.
        if (lower(v) === lower(x)) unsupported();
        continue;
      }
      if (compare(x, v) === 0) return branch(e, args[k + 1], ctx);
    }
    return k < args.length ? branch(e, args[k], ctx) : NA;
  },
  ISBLANK: isFn((s) => s === null),
  ISNUMBER: isFn((s) => typeof s === "number"),
  ISTEXT: isFn((s) => typeof s === "string"),
  ISLOGICAL: isFn((s) => typeof s === "boolean"),
  ISERROR: isFn((s) => isError(s)),
  ISNA: isFn((s) => isError(s) && s.error === "#N/A"),
};

function isFn(test: (s: Scalar) => boolean): Fn {
  return (e, args, ctx) => {
    arity(args, 1);
    const [a] = args;
    if (!a || a.t === "missing") unsupported();
    return test(e.scalar(a, ctx));
  };
}

// ─── İşlevler: metin ────────────────────────────────────────────────────────────────────────────

const textLimit = (s: string): Scalar => (s.length > MAX_TEXT ? VALUE : s);

/** Büyük/küçük harf dönüşümü uzunluğu değiştiriyorsa (ß → SS, İ → i̇) Excel'le aynı olmaz. */
function caseMap(s: string, fn: (t: string) => string): string {
  const out = fn(s);
  if (out.length !== s.length || /[İı]/.test(s)) unsupported();
  return out;
}

/** Aralıkları düzleştirerek her değeri metne çevirir (CONCAT, TEXTJOIN). */
function flatTexts(e: Engine, args: Node[], ctx: Ctx): string[] | XlError {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.t === "missing") {
      out.push("");
      continue;
    }
    const v = e.ev(arg, ctx);
    let bad: XlError | undefined;
    const push = (s: Scalar) => {
      const t = toText(s);
      if (isError(t)) {
        bad = t;
        return false;
      }
      out.push(t);
      return undefined;
    };
    if (isRng(v) || isArr(v)) e.each(v, push);
    else push(v);
    if (bad) return bad;
  }
  return out;
}

const TEXT: Record<string, Fn> = {
  CONCATENATE: (e, args, ctx) => {
    let out = "";
    for (const arg of args) {
      const t = arg.t === "missing" ? "" : textArg(e, arg, ctx);
      if (isError(t)) return t;
      out += t;
    }
    return textLimit(out);
  },
  CONCAT: (e, args, ctx) => {
    const ts = flatTexts(e, args, ctx);
    return isError(ts) ? ts : textLimit(ts.join(""));
  },
  TEXTJOIN: (e, args, ctx) => {
    if (args.length < 3) unsupported();
    const d = textArg(e, args[0], ctx);
    if (isError(d)) return d;
    const ig = toBool(e.scalar(args[1] ?? { t: "missing" }, ctx));
    if (isError(ig)) return ig;
    const ts = flatTexts(e, args.slice(2), ctx);
    if (isError(ts)) return ts;
    return textLimit((ig ? ts.filter((t) => t !== "") : ts).join(d));
  },
  LEN: text1((s) => s.length),
  LEFT: (e, args, ctx) => {
    arity(args, 1, 2);
    const s = textArg(e, args[0], ctx);
    const n = intArg(e, args[1], ctx, 1);
    if (isError(s)) return s;
    if (isError(n)) return n;
    return n < 0 ? VALUE : s.slice(0, n);
  },
  RIGHT: (e, args, ctx) => {
    arity(args, 1, 2);
    const s = textArg(e, args[0], ctx);
    const n = intArg(e, args[1], ctx, 1);
    if (isError(s)) return s;
    if (isError(n)) return n;
    return n < 0 ? VALUE : s.slice(Math.max(0, s.length - n));
  },
  MID: (e, args, ctx) => {
    arity(args, 3);
    const s = textArg(e, args[0], ctx);
    const start = intArg(e, args[1], ctx);
    const n = intArg(e, args[2], ctx);
    if (isError(s)) return s;
    if (isError(start)) return start;
    if (isError(n)) return n;
    if (start < 1 || n < 0) return VALUE;
    return s.substr(start - 1, n);
  },
  UPPER: text1((s) => caseMap(s, (t) => t.toUpperCase())),
  LOWER: text1((s) => caseMap(s, (t) => t.toLowerCase())),
  PROPER: text1((s) =>
    caseMap(s, (t) => {
      let out = "";
      let prevLetter = false;
      for (const ch of t) {
        out += prevLetter ? ch.toLowerCase() : ch.toUpperCase();
        prevLetter = /\p{L}/u.test(ch);
      }
      return out;
    }),
  ),
  // Excel TRIM yalnız boşluk karakterini (32) kırpar ve aradakileri teke indirir.
  TRIM: text1((s) => s.replace(/ +/g, " ").replace(/^ | $/g, "")),
  SUBSTITUTE: (e, args, ctx) => {
    arity(args, 3, 4);
    const s = textArg(e, args[0], ctx);
    const from = textArg(e, args[1], ctx);
    const to = textArg(e, args[2], ctx);
    if (isError(s)) return s;
    if (isError(from)) return from;
    if (isError(to)) return to;
    if (args.length < 4 || args[3]?.t === "missing") {
      if (args[3]?.t === "missing") unsupported();
      return from === "" ? s : textLimit(s.split(from).join(to));
    }
    const nth = intArg(e, args[3], ctx);
    if (isError(nth)) return nth;
    if (nth < 1) return VALUE;
    if (from === "") return s;
    let at = -from.length;
    for (let k = 0; k < nth; k++) {
      at = s.indexOf(from, at + from.length);
      if (at < 0) return s;
    }
    return textLimit(s.slice(0, at) + to + s.slice(at + from.length));
  },
  REPLACE: (e, args, ctx) => {
    arity(args, 4);
    const s = textArg(e, args[0], ctx);
    const start = intArg(e, args[1], ctx);
    const n = intArg(e, args[2], ctx);
    const to = textArg(e, args[3], ctx);
    if (isError(s)) return s;
    if (isError(start)) return start;
    if (isError(n)) return n;
    if (isError(to)) return to;
    if (start < 1 || n < 0) return VALUE;
    return textLimit(s.slice(0, start - 1) + to + s.slice(start - 1 + n));
  },
  FIND: (e, args, ctx) => findFn(e, args, ctx, false),
  SEARCH: (e, args, ctx) => findFn(e, args, ctx, true),
  REPT: (e, args, ctx) => {
    arity(args, 2);
    const s = textArg(e, args[0], ctx);
    const n = intArg(e, args[1], ctx);
    if (isError(s)) return s;
    if (isError(n)) return n;
    if (n < 0 || s.length * n > MAX_TEXT) return VALUE;
    return s.repeat(n);
  },
  VALUE: (e, args, ctx) => {
    arity(args, 1);
    const v = e.scalar(args[0] ?? { t: "missing" }, ctx);
    if (typeof v === "boolean") unsupported();
    if (typeof v === "string") return textToNumber(v);
    return v === null ? 0 : v;
  },
  EXACT: (e, args, ctx) => {
    arity(args, 2);
    const a = textArg(e, args[0], ctx);
    const b = textArg(e, args[1], ctx);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return a === b;
  },
};

function findFn(e: Engine, args: Node[], ctx: Ctx, search: boolean): Scalar {
  arity(args, 2, 3);
  const needle = textArg(e, args[0], ctx);
  const hay = textArg(e, args[1], ctx);
  const start = intArg(e, args[2], ctx, 1);
  if (isError(needle)) return needle;
  if (isError(hay)) return hay;
  if (isError(start)) return start;
  if (start < 1 || start > hay.length) return needle === "" && start === 1 ? 1 : VALUE;
  if (needle === "") return start;
  let at: number;
  if (search) {
    const rest = hay.slice(start - 1);
    const idx = rest.search(wildcardRegex(needle, false));
    if (iSensitive(needle, rest)) {
      const tr = rest
        .toLocaleLowerCase("tr")
        .search(new RegExp(wildcardRegex(lowerTr(needle), false).source));
      // Türkçe küçültme uzunluğu değiştirmez; İngilizcede İ iki karaktere açılır, konum kayabilir.
      if (tr !== idx) unsupported();
    }
    at = idx < 0 ? -1 : idx + start - 1;
  } else at = hay.indexOf(needle, start - 1);
  return at < 0 ? VALUE : at + 1;
}

// ─── İşlevler: arama ────────────────────────────────────────────────────────────────────────────

/** Tam eşleşme sınayıcısı: metinde büyük/küçük harf duyarsız, istenirse jokerli. */
function exactMatcher(x: Scalar, wildcard: boolean): Test {
  if (x === null) unsupported();
  if (typeof x === "string") {
    if (wildcard && hasWildcard(x)) {
      const re = wildcardTest(x, true);
      return (s) => typeof s === "string" && re(s);
    }
    const lx = lower(x);
    const sensitive = I_LETTERS.test(x);
    return (s) => {
      if (typeof s !== "string") return false;
      return sensitive ? sameText(s, x) : lower(s) === lx;
    };
  }
  if (typeof x === "number") return (s) => typeof s === "number" && compare(s, x) === 0;
  return (s) => s === x;
}

/**
 * Yaklaşık eşleşme. Excel ikili arama yapar; sırasız ya da karışık türlü veride sonucu algoritmanın
 * ayrıntısına bağlıdır. Bu yüzden yalnız tek türlü ve sıralı veride hesaplanır.
 */
function approxIndex(values: Scalar[], x: Scalar, descending: boolean): number | XlError {
  if (x === null || isError(x)) unsupported();
  let last = values.length - 1;
  while (last >= 0 && values[last] === null) last--;
  for (let k = 0; k <= last; k++) {
    const v = values[k] ?? null;
    if (v === null || isError(v) || typeof v !== typeof x) unsupported();
    if (k > 0) {
      const prev = values[k - 1] ?? null;
      if (prev === null || isError(prev) || isError(v)) unsupported();
      const d = compare(prev, v);
      if (descending ? d < 0 : d > 0) unsupported();
    }
  }
  let found = -1;
  for (let k = 0; k <= last; k++) {
    const v = values[k] ?? null;
    if (v === null || isError(v)) continue;
    const d = compare(v, x);
    if (descending ? d >= 0 : d <= 0) found = k;
    else break;
  }
  return found < 0 ? NA : found;
}

/** Aralığın bir sütunu ya da satırı (dolu alanla sınırlı). */
function line(e: Engine, v: Val, index: number, byColumn: boolean): Scalar[] {
  const c = clipped(e, v);
  const out: Scalar[] = [];
  const n = byColumn ? c.h : c.w;
  for (let k = 0; k < n; k++) out.push(byColumn ? e.at(v, k, index) : e.at(v, index, k));
  return out;
}

function tableArg(e: Engine, node: Node | undefined, ctx: Ctx): Rng | Arr {
  const v = node ? e.ev(node, ctx) : null;
  if (!isRng(v) && !isArr(v)) unsupported();
  return v;
}

/** Alt aralık/dizi: satır ya da sütun indisi 0 ise tümü. */
function slice(v: Rng | Arr, r: number, c: number): Val {
  const { h, w } = dims(v);
  const r0 = r === 0 ? 0 : r - 1;
  const r1 = r === 0 ? h - 1 : r - 1;
  const c0 = c === 0 ? 0 : c - 1;
  const c1 = c === 0 ? w - 1 : c - 1;
  if (isRng(v))
    return { ...v, top: v.top + r0, bottom: v.top + r1, left: v.left + c0, right: v.left + c1 };
  const rows = v.rows.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1));
  return rows.length === 1 && rows[0]?.length === 1
    ? (rows[0][0] ?? null)
    : { kind: "array", rows };
}

function lookupFn(vertical: boolean): Fn {
  return (e, args, ctx) => {
    arity(args, 3, 4);
    const x = e.scalar(args[0] ?? { t: "missing" }, ctx);
    if (isError(x)) return x;
    const table = tableArg(e, args[1], ctx);
    const k = intArg(e, args[2], ctx);
    if (isError(k)) return k;
    const approxArg = args[3];
    const approx =
      approxArg === undefined
        ? true
        : toBool(approxArg.t === "missing" ? false : e.scalar(approxArg, ctx));
    if (isError(approx)) return approx;
    const d = dims(table);
    if (k < 1) return VALUE;
    if (k > (vertical ? d.w : d.h)) return REF;
    const values = line(e, table, 0, vertical);
    let idx: number | XlError;
    if (approx) idx = approxIndex(values, x, false);
    else {
      const test = exactMatcher(x, true);
      idx = values.findIndex(test);
      if (idx < 0) idx = NA;
    }
    if (isError(idx)) return idx;
    return vertical ? e.at(table, idx, k - 1) : e.at(table, k - 1, idx);
  };
}

const LOOKUP: Record<string, Fn> = {
  VLOOKUP: lookupFn(true),
  HLOOKUP: lookupFn(false),
  XLOOKUP: (e, args, ctx) => {
    arity(args, 3, 6);
    for (const [k, def] of [
      [4, 0],
      [5, 1],
    ] as const) {
      const a = args[k];
      if (a && a.t !== "missing") {
        const mode = intArg(e, a, ctx);
        // Yalnız tam eşleşme + baştan arama; diğer kipler desteklenmez.
        if (mode !== def) unsupported();
      }
    }
    const x = e.scalar(args[0] ?? { t: "missing" }, ctx);
    if (isError(x)) return x;
    const look = tableArg(e, args[1], ctx);
    const ret = tableArg(e, args[2], ctx);
    const dl = dims(look);
    const dr = dims(ret);
    const vertical = dl.w === 1;
    if (!vertical && dl.h !== 1) return VALUE;
    if (vertical ? dr.h !== dl.h : dr.w !== dl.w) return VALUE;
    const idx = line(e, look, 0, vertical).findIndex(exactMatcher(x, false));
    if (idx < 0) {
      const nf = args[3];
      return nf && nf.t !== "missing" ? e.ev(nf, ctx) : NA;
    }
    return vertical ? slice(ret, idx + 1, 0) : slice(ret, 0, idx + 1);
  },
  INDEX: (e, args, ctx) => {
    arity(args, 2, 3);
    const v = tableArg(e, args[0], ctx);
    const r = intArg(e, args[1], ctx, 0);
    if (isError(r)) return r;
    let c: number | XlError | undefined;
    if (args.length === 3) c = intArg(e, args[2], ctx, 0);
    if (isError(c)) return c;
    if (r < 0 || (c ?? 0) < 0) return VALUE;
    const { h, w } = dims(v);
    let rr = r;
    let cc = c ?? 0;
    // Tek satırlı aralıkta tek indis sütunu seçer: INDEX(A1:E1, 3) = C1.
    if (c === undefined && h === 1 && w > 1) {
      rr = 0;
      cc = r;
    } else if (c === undefined && w === 1) cc = 1;
    if (rr > h || cc > w) return REF;
    return slice(v, rr, cc);
  },
  MATCH: (e, args, ctx) => {
    arity(args, 2, 3);
    const x = e.scalar(args[0] ?? { t: "missing" }, ctx);
    if (isError(x)) return x;
    const v = tableArg(e, args[1], ctx);
    const t = intArg(e, args[2], ctx, 1);
    if (isError(t)) return t;
    const { h, w } = dims(v);
    if (h !== 1 && w !== 1) return NA;
    const values = line(e, v, 0, w === 1);
    let idx: number | XlError;
    if (t === 0) {
      idx = values.findIndex(exactMatcher(x, true));
      if (idx < 0) idx = NA;
    } else if (t === 1 || t === -1) idx = approxIndex(values, x, t === -1);
    else unsupported();
    return isError(idx) ? idx : idx + 1;
  },
  ROWS: (e, args, ctx) => {
    arity(args, 1);
    return dims(e.ev(args[0] ?? { t: "missing" }, ctx)).h;
  },
  COLUMNS: (e, args, ctx) => {
    arity(args, 1);
    return dims(e.ev(args[0] ?? { t: "missing" }, ctx)).w;
  },
  ROW: (e, args, ctx) => rowCol(e, args, ctx, true),
  COLUMN: (e, args, ctx) => rowCol(e, args, ctx, false),
};

/** ROW/COLUMN: çok satırlı/sütunlu aralıkta dizi döner (taşma); hesaplanmaz. */
function rowCol(e: Engine, args: Node[], ctx: Ctx, row: boolean): Scalar {
  arity(args, 0, 1);
  const [a] = args;
  if (!a || a.t === "missing") return row ? ctx.row : ctx.col;
  const v = e.ev(a, ctx);
  if (!isRng(v)) unsupported();
  if (row ? v.top !== v.bottom : v.left !== v.right) unsupported();
  return row ? v.top : v.left;
}

// ─── İşlevler: tarih ────────────────────────────────────────────────────────────────────────────

function ymdArg(e: Engine, node: Node | undefined, ctx: Ctx): Ymd | XlError {
  const n = numArg(e, node, ctx);
  if (isError(n)) return n;
  return serialToYmd(n, e.date1904);
}

/** EDATE/EOMONTH: 1900'ün hayali 29 Şubat'ı çevresinde Excel'in davranışından emin değiliz. */
function monthShift(e: Engine, args: Node[], ctx: Ctx, endOfMonth: boolean): Scalar {
  arity(args, 2);
  const start = numArg(e, args[0], ctx);
  if (isError(start)) return start;
  const months = intArg(e, args[1], ctx);
  if (isError(months)) return months;
  const ymd = serialToYmd(start, e.date1904);
  if (isError(ymd)) return ymd;
  if (!e.date1904 && Math.floor(start) <= 60) unsupported();
  const total = ymd.y * 12 + ymd.m - 1 + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (y < (e.date1904 ? 1904 : 1900) || y > 9999) return NUM;
  if (!e.date1904 && y === 1900 && m <= 2) unsupported();
  const last = daysInMonth(y, m);
  return dateSerial(y, m, endOfMonth ? last : Math.min(ymd.d, last), e.date1904);
}

const DATE: Record<string, Fn> = {
  DATE: (e, args, ctx) => {
    arity(args, 3);
    const y = numArg(e, args[0], ctx);
    const m = numArg(e, args[1], ctx);
    const d = numArg(e, args[2], ctx);
    if (isError(y)) return y;
    if (isError(m)) return m;
    if (isError(d)) return d;
    return dateSerial(y, m, d, e.date1904);
  },
  YEAR: (e, args, ctx) => {
    arity(args, 1);
    const v = ymdArg(e, args[0], ctx);
    return isError(v) ? v : v.y;
  },
  MONTH: (e, args, ctx) => {
    arity(args, 1);
    const v = ymdArg(e, args[0], ctx);
    return isError(v) ? v : v.m;
  },
  DAY: (e, args, ctx) => {
    arity(args, 1);
    const v = ymdArg(e, args[0], ctx);
    return isError(v) ? v : v.d;
  },
  WEEKDAY: (e, args, ctx) => {
    arity(args, 1, 2);
    const n = numArg(e, args[0], ctx);
    const type = intArg(e, args[1], ctx, 1);
    if (isError(n)) return n;
    if (isError(type)) return type;
    if (n < 0) return NUM;
    // 1900 sisteminde seri 1 Excel'e göre Pazar'dır; 1904 serisi 1462 gün kaydırılır.
    const s = Math.floor(n) + (e.date1904 ? 1462 : 0);
    const sun0 = (((s - 1) % 7) + 7) % 7; // 0 = Pazar
    const mon0 = (sun0 + 6) % 7; // 0 = Pazartesi
    if (type === 1 || type === 17) return sun0 + 1;
    if (type === 2 || type === 11) return mon0 + 1;
    if (type === 3) return mon0;
    if (type >= 12 && type <= 16) return ((mon0 - (type - 11) + 7) % 7) + 1;
    return NUM;
  },
  EDATE: (e, args, ctx) => monthShift(e, args, ctx, false),
  EOMONTH: (e, args, ctx) => monthShift(e, args, ctx, true),
  DAYS: (e, args, ctx) => {
    arity(args, 2);
    const end = numArg(e, args[0], ctx);
    const start = numArg(e, args[1], ctx);
    if (isError(end)) return end;
    if (isError(start)) return start;
    return Math.floor(end) - Math.floor(start);
  },
  TODAY: (e, args) => {
    arity(args, 0);
    const n = e.now;
    return dateSerial(n.getFullYear(), n.getMonth() + 1, n.getDate(), e.date1904);
  },
  NOW: (e, args) => {
    arity(args, 0);
    const n = e.now;
    const day = dateSerial(n.getFullYear(), n.getMonth() + 1, n.getDate(), e.date1904);
    if (isError(day)) return day;
    const secs =
      n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds() + n.getMilliseconds() / 1000;
    return day + secs / 86_400;
  },
};

const FUNCS: Record<string, Fn> = { ...MATH, ...AGG, ...LOGIC, ...TEXT, ...LOOKUP, ...DATE };

function callFn(e: Engine, name: string, args: Node[], ctx: Ctx): Val {
  const fn = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
  // Listede olmayan işlev (TEXT, INDIRECT, OFFSET, RAND…) hesaplanmaz.
  if (!fn) unsupported();
  return fn(e, args, ctx);
}

// ─── Dışa açık API ──────────────────────────────────────────────────────────────────────────────

/** Formüllü her hücre için sonuç; hesaplanamayanlar `undefined`. `now` TODAY/NOW içindir. */
export function recalculate(
  book: CalcWorkbook,
  now: Date = new Date(),
): Map<string, Scalar | undefined> {
  const e = new Engine(book, now);
  const out = new Map<string, Scalar | undefined>();
  for (const sheet of book.sheets) {
    for (const [r, c] of e.sheetIndex(sheet).list) {
      e.ensure(sheet, r, c);
      out.set(calcKey(sheet, r, c), e.memo.get(calcKey(sheet, r, c)));
    }
  }
  return out;
}

/** Tek formülü (baştaki = olmadan) `sheet` sayfasındaki (row,col) hücresindeymiş gibi hesaplar; testler ve önizleme için */
export function evaluateFormula(
  book: CalcWorkbook,
  sheet: string,
  row: number,
  col: number,
  formula: string,
  now: Date = new Date(),
): Scalar | undefined {
  const e = new Engine(book, now);
  const name = e.sheetByLower.get(lower(sheet));
  const node = tryParse(formula);
  if (name === undefined || !node) return undefined;
  for (const [s, r, c] of e.deps(node, name)) e.ensure(s, r, c);
  return e.run(node, name, row, col);
}
