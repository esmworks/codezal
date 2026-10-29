import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  child,
  elements,
  OoxmlError,
  parseXml,
  relsPathOf,
  resolvePart,
  textOf,
  type XmlNode,
  ZipArchive,
} from "./ooxml.js";
import {
  addressOf,
  colLetters,
  parseAddress,
  parseRange,
  translateFormula,
} from "./xlsx-formula.js";

/**
 * Excel (.xlsx) okuma: her sayfa sütun harfi ve satır numaralı bir Markdown tablosuna çevrilir;
 * formüller, birleşik hücreler, tablolar ve notlar tablonun altında listelenir.
 *
 * Pi'nin `read` aracı .xlsx'i tanımaz (ZIP baytları). Model hücreye adresle (B3) dokunacağı için
 * (`xlsx_edit`) görünüm adresleri açıkça taşır. Hücrede Excel'in gösterdiği değer yazılır (tarih
 * ISO, yüzde, ondalık basamak, birim eki), binlik ayırıcı konmaz ki model sayıyı yanlış okumasın.
 * Paket ve XML katmanı `ooxml.ts`; `xlsx-edit.ts` bu modülün kitap yükleyicisini paylaşır.
 */

export const isXlsx = (path: string) => /\.(xlsx|xlsm|xltx|xltm)$/i.test(path);

export class XlsxError extends Error {}

export type XlErrorCode = "#DIV/0!" | "#N/A" | "#NAME?" | "#NULL!" | "#NUM!" | "#REF!" | "#VALUE!";
export interface XlError {
  error: XlErrorCode | string;
}
/** `null` boş hücredir. */
export type XlValue = number | string | boolean | XlError | null;

export const isXlError = (v: unknown): v is XlError =>
  typeof v === "object" && v !== null && "error" in v;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const relType = (type: string | undefined, name: string) =>
  type === `${REL}${name}` || (type?.endsWith(`/${name}`) ?? false);

// ─── Kitap ──────────────────────────────────────────────────────────────────────────────────────

export interface SheetInfo {
  name: string;
  sheetId: string;
  rId: string;
  /** Çalışma sayfası parçası; grafik sayfasında yok. */
  part?: string;
  kind: "worksheet" | "chartsheet" | "other";
  state: "visible" | "hidden" | "veryHidden";
}

export interface WorkbookInfo {
  zip: ZipArchive;
  workbookPart: string;
  workbook: XmlNode;
  rels: Map<string, { target: string; type: string }>;
  sheets: SheetInfo[];
  shared: string[];
  /** Hücre stili (cellXfs sırası) → sayı biçimi kodu. */
  formats: string[];
  date1904: boolean;
  /** Kitap düzeyi tanımlı adlar (gizli ve `_xlnm.` olanlar hariç). */
  names: { name: string; formula: string; sheet?: string }[];
}

export function openXlsxPackage(bytes: Uint8Array, lang: Locale = "tr"): ZipArchive {
  try {
    return ZipArchive.open(bytes);
  } catch (error) {
    if (error instanceof OoxmlError) throw new XlsxError(dict(lang).xlsx[error.code]);
    throw error;
  }
}

export function readRels(
  zip: ZipArchive,
  part: string,
): Map<string, { target: string; type: string }> {
  const rels = new Map<string, { target: string; type: string }>();
  const xml = zip.readText(relsPathOf(part));
  if (!xml) return rels;
  const root = child(parseXml(xml), "Relationships");
  for (const rel of root ? elements(root) : []) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target) continue;
    rels.set(id, {
      target: rel.attrs.TargetMode === "External" ? target : resolvePart(part, target),
      type: rel.attrs.Type ?? "",
    });
  }
  return rels;
}

/** `_x000D_` gibi Excel kaçışlarını çözer (denetim karakterleri XML'de böyle saklanır). */
const unescapeX = (s: string) =>
  s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Paylaşılan metin ya da satır içi metin: düz `t` veya zengin `r/t`; fonetik (`rPh`) atlanır. */
export function richText(node: XmlNode | undefined): string {
  if (!node) return "";
  let out = "";
  for (const c of elements(node)) {
    if (c.name === "t") out += textOf(c);
    else if (c.name === "r") out += textOf(child(c, "t") ?? c);
  }
  return unescapeX(out);
}

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "yyyy-mm-dd",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/** Yerel tarih biçimleri (27–36, 50–58) dilden dile değişir; tarih olarak gösterilir. */
export function builtinFormat(id: number): string {
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return "yyyy-mm-dd";
  return BUILTIN_FORMATS[id] ?? "General";
}

function readFormats(zip: ZipArchive, part: string | undefined): string[] {
  const xml = part ? zip.readText(part) : undefined;
  if (!xml) return [];
  const root = child(parseXml(xml), "styleSheet");
  const custom = new Map<number, string>();
  for (const f of elements(child(root, "numFmts") ?? { name: "", attrs: {}, children: [] })) {
    const id = Number(f.attrs.numFmtId);
    if (Number.isFinite(id) && f.attrs.formatCode !== undefined) custom.set(id, f.attrs.formatCode);
  }
  const xfs = child(root, "cellXfs");
  return (xfs ? elements(xfs) : []).map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    return custom.get(id) ?? builtinFormat(id);
  });
}

export function loadWorkbook(zip: ZipArchive, lang: Locale = "tr"): WorkbookInfo {
  const d = dict(lang);
  const rootRels = readRels(zip, "");
  const office = [...rootRels.values()].find((r) => relType(r.type, "officeDocument"));
  const workbookPart = office?.target ?? "xl/workbook.xml";
  const xml = zip.readText(workbookPart);
  if (!xml) throw new XlsxError(d.xlsx.noBody);
  const workbook = parseXml(xml);
  const wb = child(workbook, "workbook");
  if (!wb) throw new XlsxError(d.xlsx.noBody);
  const rels = readRels(zip, workbookPart);
  const sheets: SheetInfo[] = [];
  for (const s of elements(child(wb, "sheets") ?? wb).filter((e) => e.name === "sheet")) {
    const rId = s.attrs["r:id"] ?? "";
    const rel = rels.get(rId);
    const kind = relType(rel?.type, "worksheet")
      ? "worksheet"
      : relType(rel?.type, "chartsheet")
        ? "chartsheet"
        : "other";
    const state =
      s.attrs.state === "hidden" || s.attrs.state === "veryHidden" ? s.attrs.state : "visible";
    sheets.push({
      name: s.attrs.name ?? "",
      sheetId: s.attrs.sheetId ?? "",
      rId,
      ...(kind === "worksheet" && rel ? { part: rel.target } : {}),
      kind,
      state,
    });
  }
  const sharedRel = [...rels.values()].find((r) => relType(r.type, "sharedStrings"));
  const sharedXml = sharedRel ? zip.readText(sharedRel.target) : undefined;
  const sst = sharedXml ? child(parseXml(sharedXml), "sst") : undefined;
  const shared = sst
    ? elements(sst)
        .filter((e) => e.name === "si")
        .map(richText)
    : [];
  const stylesRel = [...rels.values()].find((r) => relType(r.type, "styles"));
  const pr = child(wb, "workbookPr");
  const date1904 = pr?.attrs.date1904 === "1" || pr?.attrs.date1904 === "true";
  const names: WorkbookInfo["names"] = [];
  for (const n of elements(child(wb, "definedNames") ?? { name: "", attrs: {}, children: [] })) {
    const name = n.attrs.name ?? "";
    if (!name || name.startsWith("_xlnm.") || n.attrs.hidden === "1") continue;
    const local = n.attrs.localSheetId;
    const sheet = local !== undefined ? sheets[Number(local)]?.name : undefined;
    names.push({ name, formula: textOf(n), ...(sheet !== undefined ? { sheet } : {}) });
  }
  return {
    zip,
    workbookPart,
    workbook,
    rels,
    sheets,
    shared,
    formats: readFormats(zip, stylesRel?.target),
    date1904,
    names,
  };
}

// ─── Hücreler ───────────────────────────────────────────────────────────────────────────────────

export interface CellData {
  value: XlValue;
  /** Baştaki `=` olmadan; paylaşılan formül bu hücreye çevrilmiş olarak. */
  formula?: string;
  style: number;
}

/** satır → sütun → hücre. Değeri ve formülü olmayan (yalnız biçimli) hücreler alınmaz. */
export type SheetCells = Map<number, Map<number, CellData>>;

export function cellValue(c: XmlNode, shared: readonly string[]): XlValue {
  const type = c.attrs.t ?? "n";
  if (type === "inlineStr") return richText(child(c, "is"));
  const v = child(c, "v");
  if (!v) return null;
  const raw = textOf(v);
  switch (type) {
    case "s":
      return shared[Number(raw)] ?? "";
    case "str":
      return unescapeX(raw);
    case "b":
      return raw === "1" || raw === "true";
    case "e":
      return { error: raw };
    case "d":
      return raw;
    default: {
      if (raw.trim() === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
  }
}

/**
 * Sayfanın hücreleri. `r` özniteliği isteğe bağlıdır (bazı üreticiler yazmaz): yoksa satır bir
 * öncekinin, hücre soldakinin ardından sayılır. Paylaşılan formülün bağımlı hücreleri ana formülün
 * kaydırılmış hâlini alır.
 */
export function readSheetCells(sheetRoot: XmlNode, shared: readonly string[]): SheetCells {
  const cells: SheetCells = new Map();
  const ws = child(sheetRoot, "worksheet") ?? sheetRoot;
  const data = child(ws, "sheetData");
  if (!data) return cells;
  const masters = new Map<string, { formula: string; row: number; col: number }>();
  const pending: { row: number; col: number; si: string }[] = [];
  let rowNo = 0;
  for (const rowEl of elements(data)) {
    if (rowEl.name !== "row") continue;
    rowNo = Number(rowEl.attrs.r) || rowNo + 1;
    let colNo = 0;
    for (const c of elements(rowEl)) {
      if (c.name !== "c") continue;
      const at = c.attrs.r ? parseAddress(c.attrs.r) : undefined;
      colNo = at?.col ?? colNo + 1;
      const f = child(c, "f");
      const formula: string | undefined = f ? textOf(f) : undefined;
      if (f?.attrs.t === "shared" && f.attrs.si !== undefined) {
        if (formula) masters.set(f.attrs.si, { formula, row: rowNo, col: colNo });
        else pending.push({ row: rowNo, col: colNo, si: f.attrs.si });
      }
      const value = cellValue(c, shared);
      if (value === null && !f) continue;
      let row = cells.get(rowNo);
      if (!row) {
        row = new Map();
        cells.set(rowNo, row);
      }
      row.set(colNo, {
        value,
        ...(formula ? { formula } : {}),
        style: Number(c.attrs.s ?? 0) || 0,
      });
    }
  }
  for (const p of pending) {
    const master = masters.get(p.si);
    const cell = cells.get(p.row)?.get(p.col);
    if (!master || !cell) continue;
    cell.formula = translateFormula(master.formula, p.row - master.row, p.col - master.col);
  }
  return cells;
}

// ─── Değer gösterimi ────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Seri numarası → UTC tarih. 1900 sisteminde Excel 1900'ü artık yıl sayar (seri 60 = 29 Şubat). */
export function serialToDate(serial: number, date1904 = false): Date {
  if (date1904) return new Date(Date.UTC(1904, 0, 1) + Math.round(serial * DAY_MS));
  const base = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(serial * DAY_MS));
}

export function dateToSerial(date: Date, date1904 = false): number {
  const ms = date.getTime();
  if (date1904) return (ms - Date.UTC(1904, 0, 1)) / DAY_MS;
  const serial = (ms - Date.UTC(1899, 11, 30)) / DAY_MS;
  return serial < 61 ? serial - 1 : serial;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 15 anlamlı basamağa yuvarlanmış genel gösterim: 0.1+0.2 → 0.3. */
export function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return String(n);
  return String(Number(n.toPrecision(15)));
}

interface FormatPlan {
  kind: "general" | "number" | "percent" | "scientific" | "date" | "text";
  prefix: string;
  suffix: string;
  decimals: number;
  /** Bölümde `0` yer tutucusu var mı: yoksa sıfır rakamsız görünür (muhasebedeki "- ₺"). */
  zeros?: boolean;
  date?: { date: boolean; time: boolean; seconds: boolean };
}

/** Bölümleri `;` ile ayırır; tırnak, köşeli ayraç ve kaçış içindeki `;` sayılmaz. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] ?? "";
    if (ch === "\\" && !quoted) {
      cur += ch + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function planSection(section: string): FormatPlan {
  if (/^\s*general\s*$/i.test(section)) {
    return { kind: "general", prefix: "", suffix: "", decimals: 0 };
  }
  let prefix = "";
  let suffix = "";
  let seenNumber = false;
  let lastWasNumber = false;
  let decimals = 0;
  let zeros = false;
  let inDecimals = false;
  let percent = false;
  let scientific = false;
  let text = false;
  let hasY = false;
  let hasD = false;
  let hasM = false;
  let hasH = false;
  let hasS = false;
  const literal = (s: string) => {
    if (seenNumber) suffix += s;
    else prefix += s;
  };
  for (let i = 0; i < section.length; i++) {
    const ch = section[i] ?? "";
    const lower = ch.toLowerCase();
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      const stop = end < 0 ? section.length : end;
      literal(section.slice(i + 1, stop));
      i = stop;
      lastWasNumber = false;
    } else if (ch === "\\") {
      literal(section[i + 1] ?? "");
      i++;
      lastWasNumber = false;
    } else if (ch === "_" || ch === "*") {
      i++;
    } else if (ch === "[") {
      const end = section.indexOf("]", i);
      const inner = section.slice(i + 1, end < 0 ? section.length : end);
      if (inner.startsWith("$")) literal(inner.slice(1).split("-")[0] ?? "");
      else if (/^(h+|m+|s+)$/i.test(inner)) {
        if (/h/i.test(inner)) hasH = true;
        else if (/s/i.test(inner)) hasS = true;
        else hasM = true;
      }
      i = end < 0 ? section.length : end;
    } else if ("0#?".includes(ch)) {
      seenNumber = true;
      lastWasNumber = true;
      if (ch === "0") zeros = true;
      if (inDecimals) decimals++;
    } else if (ch === "." && (lastWasNumber || /[0#?]/.test(section[i + 1] ?? ""))) {
      seenNumber = true;
      inDecimals = true;
      lastWasNumber = true;
    } else if (ch === "," && lastWasNumber) {
      // binlik ayırıcı ya da ölçek; gösterilmez
    } else if (ch === "%") {
      percent = true;
      literal("%");
    } else if ((ch === "E" || ch === "e") && /[+-]/.test(section[i + 1] ?? "") && seenNumber) {
      scientific = true;
      i++;
      while (/[0#?]/.test(section[i + 1] ?? "")) i++;
    } else if (ch === "@") {
      text = true;
    } else if (/^a(m\/pm|\/p)/i.test(section.slice(i))) {
      i += section.slice(i, i + 5).toUpperCase() === "AM/PM" ? 4 : 2;
    } else if ("ydmhsbge".includes(lower) && !seenNumber) {
      if (lower === "y" || lower === "e" || lower === "b" || lower === "g") hasY = true;
      else if (lower === "d") hasD = true;
      else if (lower === "m") hasM = true;
      else if (lower === "h") hasH = true;
      else if (lower === "s") hasS = true;
    } else {
      literal(ch);
      lastWasNumber = false;
      if (inDecimals) inDecimals = false;
    }
  }
  const isDate = hasY || hasD || (hasM && !hasH && !hasS);
  const isTime = hasH || hasS;
  if (isDate || isTime) {
    return {
      kind: "date",
      prefix: "",
      suffix: "",
      decimals: 0,
      date: { date: isDate, time: isTime, seconds: hasS },
    };
  }
  if (text && !seenNumber) return { kind: "text", prefix, suffix, decimals: 0 };
  if (!seenNumber) return { kind: "general", prefix, suffix, decimals: 0 };
  if (scientific) return { kind: "scientific", prefix, suffix, decimals };
  if (percent) {
    return { kind: "percent", prefix, suffix: suffix.replace("%", ""), decimals, zeros };
  }
  return { kind: "number", prefix, suffix, decimals, zeros };
}

/** Hücrenin Excel'deki görünümü (tarih ISO, binlik ayırıcı yok). */
export function formatNumber(n: number, code: string | undefined, date1904 = false): string {
  if (!code || /^\s*general\s*$/i.test(code)) return generalNumber(n);
  const sections = splitSections(code);
  let section = sections[0] ?? "";
  let value = n;
  let sign = "";
  if (n < 0 && sections.length > 1 && sections[1]) {
    section = sections[1];
    value = -n;
  } else if (n === 0 && sections.length > 2 && sections[2]) {
    section = sections[2];
  } else if (n < 0) {
    sign = "-";
    value = -n;
  }
  const plan = planSection(section);
  const wrap = (body: string) => `${plan.prefix}${body}${plan.suffix}`.trim();
  switch (plan.kind) {
    case "date": {
      const dt = serialToDate(n, date1904);
      const flags = plan.date ?? { date: true, time: false, seconds: false };
      const day = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
      const time = `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}${
        flags.seconds ? `:${pad(dt.getUTCSeconds())}` : ""
      }`;
      if (flags.date && flags.time) return `${day} ${time}`;
      return flags.date ? day : time;
    }
    case "percent":
      return `${sign}${wrap(`${(value * 100).toFixed(plan.decimals)}%`)}`;
    case "scientific":
      return `${sign}${wrap(value.toExponential(plan.decimals).toUpperCase())}`;
    case "number":
      if (value === 0 && !plan.zeros) return wrap("");
      return `${sign}${wrap(value.toFixed(plan.decimals))}`;
    case "text":
      return generalNumber(n);
    default: {
      const body = generalNumber(value);
      return plan.prefix || plan.suffix ? `${sign}${wrap(body)}` : `${sign}${body}`;
    }
  }
}

export function displayValue(value: XlValue, format: string | undefined, date1904 = false): string {
  if (value === null) return "";
  if (typeof value === "number") return formatNumber(value, format, date1904);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (isXlError(value)) return value.error;
  return value;
}

// ─── Markdown ───────────────────────────────────────────────────────────────────────────────────

const escapeCell = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

interface SheetExtras {
  merges: string[];
  tables: { name: string; ref: string }[];
  notes: { ref: string; author?: string; text: string }[];
}

function sheetExtras(info: WorkbookInfo, sheet: SheetInfo, ws: XmlNode): SheetExtras {
  const merges = elements(child(ws, "mergeCells") ?? ws)
    .filter((m) => m.name === "mergeCell" && m.attrs.ref)
    .map((m) => m.attrs.ref ?? "");
  const tables: SheetExtras["tables"] = [];
  const notes: SheetExtras["notes"] = [];
  if (!sheet.part) return { merges, tables, notes };
  for (const rel of readRels(info.zip, sheet.part).values()) {
    if (relType(rel.type, "table")) {
      const xml = info.zip.readText(rel.target);
      const t = xml ? child(parseXml(xml), "table") : undefined;
      if (t?.attrs.ref)
        tables.push({ name: t.attrs.displayName ?? t.attrs.name ?? "", ref: t.attrs.ref });
    } else if (relType(rel.type, "comments")) {
      const xml = info.zip.readText(rel.target);
      const root = xml ? child(parseXml(xml), "comments") : undefined;
      if (!root) continue;
      const authors = elements(child(root, "authors") ?? root)
        .filter((a) => a.name === "author")
        .map(textOf);
      for (const c of elements(child(root, "commentList") ?? root)) {
        if (c.name !== "comment" || !c.attrs.ref) continue;
        const author = authors[Number(c.attrs.authorId)];
        let text = richText(child(c, "text")).trim();
        // Excel notu yazar adını metnin başına "Ad:\n" olarak da koyar; tekrar etmesin.
        if (author && text.startsWith(`${author}:`)) text = text.slice(author.length + 1).trim();
        notes.push({ ref: c.attrs.ref, ...(author ? { author } : {}), text });
      }
    }
  }
  return { merges, tables, notes };
}

/**
 * Aynı sütunda art arda gelen ve bir öncekinin bir satır kaydırılmışı olan formüller tek satırda
 * toplanır (`D2:D40 =B2*C2`): uzun tabloda formül listesi satır sayısı kadar büyümesin.
 */
function formulaLines(cells: SheetCells): string[] {
  const byCol = new Map<number, { row: number; formula: string }[]>();
  for (const [row, cols] of cells) {
    for (const [col, cell] of cols) {
      if (!cell.formula) continue;
      const list = byCol.get(col) ?? [];
      list.push({ row, formula: cell.formula });
      byCol.set(col, list);
    }
  }
  const groups: { row: number; col: number; end: number; formula: string }[] = [];
  for (const [col, list] of byCol) {
    list.sort((a, b) => a.row - b.row);
    let group: (typeof groups)[number] | undefined;
    for (const item of list) {
      if (
        group &&
        item.row === group.end + 1 &&
        translateFormula(group.formula, item.row - group.row, 0) === item.formula
      ) {
        group.end = item.row;
        continue;
      }
      group = { row: item.row, col, end: item.row, formula: item.formula };
      groups.push(group);
    }
  }
  groups.sort((a, b) => a.row - b.row || a.col - b.col);
  return groups.map((g) => {
    const at =
      g.end > g.row
        ? `${addressOf(g.row, g.col)}:${addressOf(g.end, g.col)}`
        : addressOf(g.row, g.col);
    return `- ${at}: \`=${g.formula}\``;
  });
}

export interface XlsxConversion {
  markdown: string;
  sheets: number;
  formulas: number;
}

export interface XlsxConvertOptions {
  /** Sayfa başına en çok satır (önizleme); verilmezse hepsi. */
  maxRows?: number;
}

export function convertXlsx(
  bytes: Uint8Array,
  lang: Locale = "tr",
  options: XlsxConvertOptions = {},
): XlsxConversion {
  const d = dict(lang);
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const info = loadWorkbook(openXlsxPackage(bytes, lang), lang);
  const parts: string[] = [];
  let formulas = 0;
  if (info.names.length > 0) {
    const list = info.names.map(
      (n) => `\`${n.name}\` = \`${n.formula}\`${n.sheet !== undefined ? ` (${n.sheet})` : ""}`,
    );
    parts.push(`**${d.xlsx.names}:** ${list.join(", ")}`);
  }
  info.sheets.forEach((sheet, index) => {
    const tags: string[] = [];
    if (sheet.state !== "visible") tags.push(d.xlsx.hidden);
    if (sheet.kind === "chartsheet") tags.push(d.xlsx.chartSheet);
    const title = `## ${fill(d.xlsx.sheetTitle, { n: index + 1, name: sheet.name })}${
      tags.length > 0 ? ` (${tags.join(", ")})` : ""
    }`;
    const xml = sheet.part ? info.zip.readText(sheet.part) : undefined;
    if (!xml) {
      parts.push(`${title}\n\n${d.xlsx.noCells}`);
      return;
    }
    const root = parseXml(xml);
    const ws = child(root, "worksheet") ?? root;
    const cells = readSheetCells(root, info.shared);
    const extras = sheetExtras(info, sheet, ws);
    const section: string[] = [title];
    if (cells.size === 0) {
      section.push(d.xlsx.noCells);
    } else {
      const rows = [...cells.keys()].sort((a, b) => a - b);
      let left = Number.POSITIVE_INFINITY;
      let right = 0;
      let count = 0;
      for (const cols of cells.values()) {
        for (const col of cols.keys()) {
          left = Math.min(left, col);
          right = Math.max(right, col);
        }
        for (const cell of cols.values()) if (cell.formula) count++;
      }
      formulas += count;
      const top = rows[0] ?? 1;
      const bottom = rows[rows.length - 1] ?? top;
      const range = `${addressOf(top, left)}:${addressOf(bottom, right)}`;
      section.push(
        count > 0
          ? fill(d.xlsx.rangeWithFormulas, { range, rows: rows.length, formulas: count })
          : fill(d.xlsx.range, { range, rows: rows.length }),
      );
      const letters: string[] = [];
      for (let c = left; c <= right; c++) letters.push(colLetters(c));
      const lines = [
        `|   | ${letters.join(" | ")} |`,
        `|---|${letters.map(() => "---").join("|")}|`,
      ];
      const shownRows = options.maxRows !== undefined ? rows.slice(0, options.maxRows) : rows;
      for (const r of shownRows) {
        const cols = cells.get(r);
        const values: string[] = [];
        for (let c = left; c <= right; c++) {
          const cell = cols?.get(c);
          if (!cell) {
            values.push("");
            continue;
          }
          const shown =
            cell.formula && cell.value === null
              ? `=${cell.formula}`
              : displayValue(cell.value, info.formats[cell.style], info.date1904);
          values.push(escapeCell(shown));
        }
        lines.push(`| ${r} | ${values.join(" | ")} |`);
      }
      section.push(lines.join("\n"));
      if (shownRows.length < rows.length) {
        section.push(fill(d.xlsx.moreRows, { n: rows.length - shownRows.length }));
      }
      const list = formulaLines(cells);
      if (list.length > 0) section.push(`**${d.xlsx.formulas}:**\n${list.join("\n")}`);
    }
    if (extras.merges.length > 0) {
      section.push(`**${d.xlsx.merged}:** ${extras.merges.join(", ")}`);
    }
    if (extras.tables.length > 0) {
      section.push(
        `**${d.xlsx.tables}:** ${extras.tables.map((t) => `${t.name} (${t.ref})`).join(", ")}`,
      );
    }
    if (extras.notes.length > 0) {
      const list = extras.notes.map(
        (n) => `- ${n.ref}${n.author ? ` (${n.author})` : ""}: ${n.text.replace(/\s*\n\s*/g, " ")}`,
      );
      section.push(`**${d.xlsx.notes}:**\n${list.join("\n")}`);
    }
    parts.push(section.join("\n\n"));
  });
  return { markdown: parts.join("\n\n"), sheets: info.sheets.length, formulas };
}

export function xlsxToMarkdown(bytes: Uint8Array, lang: Locale = "tr"): string {
  return convertXlsx(bytes, lang).markdown;
}

export interface XlsxReadOptions {
  lang?: Locale;
  /** 1 tabanlı başlangıç satırı (çevrilmiş Markdown'da). */
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
}

/** `read` sonucu: başlık satırı + Markdown; `offset`/`limit` çevrilmiş satırlara uygulanır. */
export async function readXlsxContent(
  path: string,
  options: XlsxReadOptions,
): Promise<TextContent[]> {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const converted = convertXlsx(await readFile(path), lang);
  const lines = converted.markdown.split("\n");
  const total = lines.length;
  const header = fill(d.xlsx.header, {
    name: basename(path),
    sheets: converted.sheets,
    lines: total,
  });
  if (!converted.markdown.trim()) return [{ type: "text", text: `${header}\n\n${d.xlsx.empty}` }];
  const start = Math.max(1, Math.floor(options.offset ?? 1));
  if (start > total) throw new XlsxError(fill(d.xlsx.offsetOutOfRange, { asked: start, total }));
  const maxLines = Math.min(
    options.maxLines,
    Math.max(1, Math.floor(options.limit ?? options.maxLines)),
  );
  const shown: string[] = [];
  let bytes = 0;
  for (let i = start - 1; i < total && shown.length < maxLines; i++) {
    const line = lines[i] ?? "";
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (shown.length > 0 && bytes + size > options.maxBytes) break;
    shown.push(line);
    bytes += size;
  }
  const last = start + shown.length - 1;
  let text = `${header}\n\n${shown.join("\n")}`;
  if (last < total) text += `\n\n${fill(d.xlsx.more, { shown: last, total, next: last + 1 })}`;
  return [{ type: "text", text }];
}

/** Aralık metninin geçerli olup olmadığı; araçların girdi denetimi için. */
export const isRangeText = (text: string) => parseRange(text) !== undefined;
