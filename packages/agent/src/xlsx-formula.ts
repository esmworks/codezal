/**
 * Excel formüllerinde A1 başvuruları: adres çevirisi, paylaşılan formülün açılması ve satır/sütun
 * ekleme-silme ya da sayfa adı değişince başvuruların kaydırılması. Okuma (`xlsx.ts`), üretim ve
 * düzenleme (`xlsx-edit.ts`) paylaşır; hesaplama `xlsx-calc.ts`'tedir.
 *
 * Formül ayrıştırılmaz, taranır: metin sabitleri ("…"), köşeli ayraçlar (yapılandırılmış başvuru,
 * dış kitap `[1]`) atlanır; başvuru biçimine uyan ve arkasından `(` gelmeyen parça (`LOG10(` işlevdir)
 * başvuru sayılır. Excel başvuruya benzeyen tanımlı ada izin vermez; bu yüzden tarama güvenlidir.
 */

export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;

/** `A` → 1, `XFD` → 16384; geçersizse 0. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64;
    if (code < 1 || code > 26) return 0;
    n = n * 26 + code;
  }
  return n;
}

/** 1 → `A`, 28 → `AB`. */
export function colLetters(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface CellAddress {
  row: number;
  col: number;
}

/** `B3` / `$B$3` → { row: 3, col: 2 }; geçersizse `undefined`. */
export function parseAddress(text: string): CellAddress | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text.trim());
  if (!m?.[1] || !m[2]) return undefined;
  const col = colIndex(m[1]);
  const row = Number(m[2]);
  if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return undefined;
  return { row, col };
}

export const addressOf = (row: number, col: number) => `${colLetters(col)}${row}`;

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** `A1:C3`, `C3:A1` (köşeler sıralanır) ya da tek hücre `B2`. */
export function parseRange(text: string): CellRange | undefined {
  const [a, b, extra] = text.trim().split(":");
  if (extra !== undefined || !a) return undefined;
  const from = parseAddress(a);
  const to = b === undefined ? from : parseAddress(b);
  if (!from || !to) return undefined;
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.col, to.col),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.col, to.col),
  };
}

export const rangeText = (r: CellRange) =>
  r.top === r.bottom && r.left === r.right
    ? addressOf(r.top, r.left)
    : `${addressOf(r.top, r.left)}:${addressOf(r.bottom, r.right)}`;

/** Sayfa adı formülde tırnak ister mi: harf/rakam/alt çizgi/nokta dışı karakter ya da hücreye benzeme. */
export function quoteSheet(name: string): string {
  const plain =
    /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) &&
    !/^[A-Za-z]{1,3}\d+$/.test(name) &&
    !/^(R|C|RC|R\d+C\d+)$/i.test(name);
  return plain ? name : `'${name.replace(/'/g, "''")}'`;
}

// ─── Tarama ─────────────────────────────────────────────────────────────────────────────────────

/** Başvurunun bir ucu: hücre (`$A$1`), yalnız sütun (`A` in `A:C`) ya da yalnız satır (`1` in `1:3`). */
export interface RefPart {
  col?: number;
  row?: number;
  colAbs: boolean;
  rowAbs: boolean;
}

export interface FormulaRef {
  /** Tırnaksız sayfa adı; formülde yazılmadıysa yok (formülün kendi sayfası). */
  sheet?: string;
  a: RefPart;
  b?: RefPart;
}

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const COLS = String.raw`\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}`;
const ROWS = String.raw`\$?\d{1,7}:\$?\d{1,7}`;
// Yapışkan (`y`): tarama her konumda formülü dilimlemeden eşleşir; büyük kitapta fark ediyor.
const REF_BODY = new RegExp(`(?:${CELL}(?::${CELL})?|${COLS}|${ROWS})`, "y");
const UNQUOTED_SHEET = /[\p{L}\p{N}_.]+(?::[\p{L}\p{N}_.]+)?!/uy;
const IDENT_CHAR = /[\p{L}\p{N}_.$\\?]/u;
const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/y;

const stickyAt = (re: RegExp, text: string, at: number) => {
  re.lastIndex = at;
  return re.exec(text);
};

function parsePart(text: string): RefPart | undefined {
  const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$/.exec(text);
  if (!m || (!m[2] && !m[4])) return undefined;
  const part: RefPart = { colAbs: m[1] === "$", rowAbs: m[3] === "$" };
  if (m[2]) {
    const col = colIndex(m[2]);
    if (col < 1 || col > MAX_COL) return undefined;
    part.col = col;
  } else {
    // Yalnız satır: `$1` biçiminde işaret sütun değil satır içindir.
    part.rowAbs = m[1] === "$";
    part.colAbs = false;
  }
  if (m[4]) {
    const row = Number(m[4]);
    if (row < 1 || row > MAX_ROW) return undefined;
    part.row = row;
  }
  return part;
}

function formatPart(part: RefPart): string {
  let out = "";
  if (part.col !== undefined) out += `${part.colAbs ? "$" : ""}${colLetters(part.col)}`;
  if (part.row !== undefined) out += `${part.rowAbs ? "$" : ""}${part.row}`;
  return out;
}

export function formatRef(ref: FormulaRef): string {
  const sheet = ref.sheet !== undefined ? `${quoteSheet(ref.sheet)}!` : "";
  return `${sheet}${formatPart(ref.a)}${ref.b ? `:${formatPart(ref.b)}` : ""}`;
}

/**
 * Formüldeki her başvuru için `visit` çağrılır; dönen metin başvurunun yerine yazılır (`undefined`
 * dokunmaz). Dış kitap başvuruları (`[1]Sayfa!A1`) ziyaret edilmez.
 */
export function mapRefs(formula: string, visit: (ref: FormulaRef) => string | undefined): string {
  let out = "";
  let i = 0;
  let external = false;
  const n = formula.length;
  const boundary = (at: number) => at === 0 || !IDENT_CHAR.test(formula[at - 1] ?? "");
  while (i < n) {
    const ch = formula[i] ?? "";
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (formula[j] === "[") depth++;
        else if (formula[j] === "]" && --depth === 0) break;
      }
      const bracket = formula.slice(i, j + 1);
      out += bracket;
      i = j + 1;
      // `[1]Sayfa!A1` dış kitaptır; `Tablo[Sütun]` gibi yapılandırılmış başvurunun içi atlanır.
      external = /^\[\d+\]$/.test(bracket);
      continue;
    }
    if (ch === "'" || (boundary(i) && /[\p{L}\p{N}_$]/u.test(ch))) {
      let sheet: string | undefined;
      let j = i;
      if (ch === "'") {
        let k = i + 1;
        while (k < n) {
          if (formula[k] === "'") {
            if (formula[k + 1] === "'") k += 2;
            else break;
          } else k++;
        }
        if (formula[k + 1] === "!") {
          sheet = formula.slice(i + 1, k).replace(/''/g, "'");
          j = k + 2;
        }
      } else {
        const m = stickyAt(UNQUOTED_SHEET, formula, i);
        if (m) {
          sheet = m[0].slice(0, -1);
          j = i + m[0].length;
        }
      }
      const body = stickyAt(REF_BODY, formula, j);
      const end = j + (body?.[0].length ?? 0);
      const next = formula[end] ?? "";
      // `LOG10(` işlev, `Tbl1[Sütun]` tablo adıdır.
      if (body && next !== "(" && next !== "[" && !IDENT_CHAR.test(next)) {
        const [left, right] = body[0].split(":");
        const a = left ? parsePart(left) : undefined;
        const b = right !== undefined ? parsePart(right) : undefined;
        if (a && (right === undefined || b)) {
          const ref: FormulaRef = {
            a,
            ...(b ? { b } : {}),
            ...(sheet !== undefined ? { sheet } : {}),
          };
          const replaced = external ? undefined : visit(ref);
          out += replaced ?? formula.slice(i, end);
          i = end;
          external = false;
          continue;
        }
      }
      if (ch === "'") {
        // Sayfa adı sanılan tırnak başvuruya bağlanmadı; olduğu gibi geçilir.
        out += ch;
        i++;
        continue;
      }
      const num = /\d/.test(ch) ? stickyAt(NUMBER, formula, i) : null;
      let k = i + (num?.[0].length ?? 0);
      if (!num) while (k < n && IDENT_CHAR.test(formula[k] ?? "")) k++;
      out += formula.slice(i, k);
      i = k;
      external = false;
      continue;
    }
    out += ch;
    i++;
    if (ch !== " ") external = false;
  }
  return out;
}

export function collectRefs(formula: string): FormulaRef[] {
  const refs: FormulaRef[] = [];
  mapRefs(formula, (ref) => {
    refs.push(ref);
    return undefined;
  });
  return refs;
}

// ─── Paylaşılan formül ──────────────────────────────────────────────────────────────────────────

/**
 * Paylaşılan formülün ana hücredeki metnini `dr` satır, `dc` sütun ötedeki hücreye çevirir: göreli
 * uçlar kayar, `$` sabit kalır. Sınır dışına düşen uç `#REF!` olur (Excel de öyle yapar).
 */
export function translateFormula(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula;
  return mapRefs(formula, (ref) => {
    const move = (p: RefPart): RefPart | undefined => {
      const q = { ...p };
      if (q.row !== undefined && !q.rowAbs) q.row += dr;
      if (q.col !== undefined && !q.colAbs) q.col += dc;
      if (q.row !== undefined && (q.row < 1 || q.row > MAX_ROW)) return undefined;
      if (q.col !== undefined && (q.col < 1 || q.col > MAX_COL)) return undefined;
      return q;
    };
    const a = move(ref.a);
    const b = ref.b ? move(ref.b) : undefined;
    if (!a || (ref.b && !b)) return "#REF!";
    return formatRef({ ...ref, a, ...(b ? { b } : {}) });
  });
}

// ─── Yapısal değişiklik ─────────────────────────────────────────────────────────────────────────

export interface StructuralShift {
  /** Değişen sayfanın adı. */
  sheet: string;
  axis: "row" | "col";
  /** Eklemede ilk yeni satır/sütun; silmede ilk silinen. */
  at: number;
  /** Pozitif: eklenen sayısı; negatif: silinen sayısı. */
  count: number;
}

/** Tek bir konumun kaydırılması; silinen konumda `undefined`. */
export function shiftIndex(index: number, shift: Pick<StructuralShift, "at" | "count">) {
  const { at, count } = shift;
  if (index < at) return index;
  if (count > 0) return index + count;
  if (index < at - count) return undefined;
  return index + count;
}

/**
 * Bir aralığın bir eksendeki uçlarını kaydırır (Excel davranışı): ekleme aralığın içine düşerse
 * aralık büyür, silme bir ucu yerse aralık daralır, tümünü yerse `undefined`.
 */
export function shiftSpan(
  start: number,
  end: number,
  shift: Pick<StructuralShift, "at" | "count">,
  max: number,
): [number, number] | undefined {
  const { at, count } = shift;
  if (count > 0) {
    const s = start >= at ? start + count : start;
    const e = end >= at ? end + count : end;
    if (s > max) return undefined;
    return [s, Math.min(e, max)];
  }
  const last = at - count - 1;
  if (start >= at && end <= last) return undefined;
  const s = start < at ? start : start > last ? start + count : at;
  const e = end < at ? end : end > last ? end + count : at - 1;
  return [s, e];
}

export function sameSheet(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * Satır/sütun ekleme-silmeden sonra formül: `formulaSheet` formülün bulunduğu sayfa (tanımlı adlarda
 * `undefined`; onların başvuruları hep sayfa adlıdır). Değişen sayfaya bakan başvurular kayar, tümüyle
 * silinen başvuru `#REF!` olur.
 */
export function shiftFormula(
  formula: string,
  formulaSheet: string | undefined,
  shift: StructuralShift,
): string {
  const max = shift.axis === "row" ? MAX_ROW : MAX_COL;
  return mapRefs(formula, (ref) => {
    if (!sameSheet(ref.sheet ?? formulaSheet, shift.sheet)) return undefined;
    const key = shift.axis;
    const a = { ...ref.a };
    const b = ref.b ? { ...ref.b } : undefined;
    const av = a[key];
    if (av === undefined) return undefined;
    if (!b) {
      const moved = shiftIndex(av, shift);
      if (moved === undefined || moved > max) return "#REF!";
      if (moved === av) return undefined;
      a[key] = moved;
      return formatRef({ ...ref, a });
    }
    const bv = b[key];
    if (bv === undefined) return undefined;
    const span = shiftSpan(Math.min(av, bv), Math.max(av, bv), shift, max);
    if (!span) return "#REF!";
    const [s, e] = av <= bv ? span : [span[1], span[0]];
    if (s === av && e === bv) return undefined;
    a[key] = s;
    b[key] = e;
    return formatRef({ ...ref, a, b });
  });
}

/** Aralık metnini (`A1:C3`, `B2`) kaydırır; tümü silindiyse `undefined`. `sqref` boşlukla ayrılmış olabilir. */
export function shiftRangeText(text: string, shift: StructuralShift): string | undefined {
  const parts: string[] = [];
  for (const piece of text.trim().split(/\s+/)) {
    if (!piece) continue;
    const shifted = shiftFormula(piece, shift.sheet, shift);
    if (shifted !== "#REF!") parts.push(shifted);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Sayfa adı değişince (`to`) ya da sayfa silinince (`to` yok) o sayfaya bakan başvurular. */
export function renameSheetInFormula(
  formula: string,
  from: string,
  to: string | undefined,
): string {
  return mapRefs(formula, (ref) => {
    if (!sameSheet(ref.sheet, from)) return undefined;
    if (to === undefined) return "#REF!";
    return formatRef({ ...ref, sheet: to });
  });
}

// ─── Yapılandırılmış başvurular (Tablo1[Sütun]) ───

/** Aralığa dönüştürülen ya da silinen tablonun başvuru çözümü için gereken bilgisi. */
export interface TableShape {
  name: string;
  sheet: string;
  range: CellRange;
  header: boolean;
  totals: boolean;
  /** Sütun adları, soldan sağa. */
  columns: string[];
}

interface TableSpec {
  areas: Set<string>;
  thisRow: boolean;
  cols?: [string, string];
}

/** `[...]` grubunun kapanışı; `'` sonraki karakteri kaçırır (sütun adındaki `[`, `]`, `#`). */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const unescapeColumn = (s: string) => s.trim().replace(/'(.)/g, "$1");
const SPECIALS = new Set(["#all", "#data", "#headers", "#totals", "#this row"]);

function parseTableSpec(inner: string): TableSpec | undefined {
  const spec: TableSpec = { areas: new Set(), thisRow: false };
  const columns: string[] = [];
  let range = false;
  const item = (raw: string) => {
    const text = raw.trim();
    const special = text.toLowerCase();
    if (SPECIALS.has(special)) {
      if (special === "#this row") spec.thisRow = true;
      else spec.areas.add(special);
    } else columns.push(unescapeColumn(text));
  };
  let s = inner.trim();
  if (s.startsWith("@")) {
    spec.thisRow = true;
    s = s.slice(1).trim();
    if (s && !s.startsWith("[")) s = `[${s}]`;
  }
  if (s && !s.startsWith("[")) item(s);
  else {
    let i = 0;
    while (i < s.length) {
      if (s[i] !== "[") return undefined;
      const end = closingBracket(s, i);
      if (end < 0) return undefined;
      item(s.slice(i + 1, end));
      i = end + 1;
      while (s[i] === " ") i++;
      if (i >= s.length) break;
      if (s[i] === ":") range = true;
      else if (s[i] !== ",") return undefined;
      i++;
      while (s[i] === " ") i++;
    }
  }
  if (columns.length > 2 || (range && columns.length !== 2)) return undefined;
  const [from, to] = columns;
  if (from !== undefined) spec.cols = [from, to ?? from];
  return spec;
}

/** Sayfa başvurusu ya da tanımlı ad gibi tabloyla aynı adı taşıyabilecek karakterler. */
const NAME_START = /[A-Za-z_\\À-￿]/;
const NAME_PART = /[\w.\\À-￿]/;

/**
 * Formüldeki `tablo[...]` başvurularını A1 aralığına çevirir (Excel'in "Aralığa Dönüştür"ü gibi).
 * `at` formülün bulunduğu hücredir: `[#This Row]`/`@` o satırı alır; `at` yoksa (tanımlı ad) ya da
 * satır bilinmiyorsa `#REF!` olur. Aralıklar mutlak (`$C$2:$C$9`), aynı satır göreli (`C5`) yazılır.
 */
export function replaceTableRefs(
  formula: string,
  table: TableShape,
  at?: { sheet: string; row?: number },
): string {
  const target = table.name.toLowerCase();
  // Hızlı yol: tablo adı ve ardından `[` hiç geçmiyorsa taramaya gerek yok.
  if (!formula.toLowerCase().includes(`${target}[`)) return formula;
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i] ?? "";
    if (ch === '"' || ch === "'") {
      // Metin sabiti ve tırnaklı sayfa adı olduğu gibi geçer ("" ve '' kaçışı dahil).
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (NAME_START.test(ch) && (i === 0 || !NAME_PART.test(formula[i - 1] ?? ""))) {
      let j = i + 1;
      while (j < formula.length && NAME_PART.test(formula[j] ?? "")) j++;
      const name = formula.slice(i, j);
      if (formula[j] === "[" && name.toLowerCase() === target) {
        const end = closingBracket(formula, j);
        if (end > 0) {
          out += resolveTableRef(formula.slice(j + 1, end), table, at);
          i = end + 1;
          continue;
        }
      }
      out += name;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function resolveTableRef(
  inner: string,
  table: TableShape,
  at: { sheet: string; row?: number } | undefined,
): string {
  const spec = parseTableSpec(inner);
  if (!spec) return "#REF!";
  const { range } = table;
  const dataTop = table.header ? range.top + 1 : range.top;
  const dataBottom = table.totals ? range.bottom - 1 : range.bottom;
  let left = range.left;
  let right = range.right;
  if (spec.cols) {
    const index = (name: string) =>
      table.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    const a = index(spec.cols[0]);
    const b = index(spec.cols[1]);
    if (a < 0 || b < 0) return "#REF!";
    left = range.left + Math.min(a, b);
    right = range.left + Math.max(a, b);
  }
  const prefix =
    at === undefined || !sameSheet(at.sheet, table.sheet) ? `${quoteSheet(table.sheet)}!` : "";
  if (spec.thisRow) {
    if (spec.areas.size > 0 || !at?.row || at.row < dataTop || at.row > dataBottom) return "#REF!";
    const row = at.row;
    return left === right
      ? `${prefix}${colLetters(left)}${row}`
      : `${prefix}${colLetters(left)}${row}:${colLetters(right)}${row}`;
  }
  let top: number;
  let bottom: number;
  const areas = spec.areas;
  if (areas.has("#all")) {
    top = range.top;
    bottom = range.bottom;
  } else {
    const headers = areas.has("#headers");
    const totals = areas.has("#totals");
    const data = areas.has("#data") || (!headers && !totals);
    if ((headers && !table.header) || (totals && !table.totals)) return "#REF!";
    // Başlık ve toplam birlikte (veri olmadan) bitişik değildir; Excel de kabul etmez.
    if (headers && totals && !data) return "#REF!";
    top = headers ? range.top : data ? dataTop : range.bottom;
    bottom = totals ? range.bottom : data ? dataBottom : range.top;
  }
  if (bottom < top) return "#REF!";
  const a = `$${colLetters(left)}$${top}`;
  const b = `$${colLetters(right)}$${bottom}`;
  return `${prefix}${a === b ? a : `${a}:${b}`}`;
}
