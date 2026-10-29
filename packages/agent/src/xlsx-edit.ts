import { dirname, isAbsolute, resolve } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import {
  child,
  cloneNode,
  el,
  elements,
  isElement,
  parseXml,
  relsPathOf,
  serializeXml,
  textOf,
  type XmlNode,
  type ZipArchive,
} from "./ooxml.js";
import { expandReadPath } from "./read-path.js";
import { expandPath } from "./resources.js";
import { loadWorkbook, openXlsxPackage, readRels, type WorkbookInfo } from "./xlsx.js";
import { buildWorksheet, dateFormats, sheetNameProblem } from "./xlsx-build.js";
import {
  addressOf,
  type CellRange,
  colIndex,
  MAX_COL,
  MAX_ROW,
  parseAddress,
  parseRange,
  rangeText,
  renameSheetInFormula,
  replaceTableRefs,
  type StructuralShift,
  sameSheet,
  shiftFormula,
  shiftIndex,
  shiftRangeText,
  shiftSpan,
  type TableShape,
  translateFormula,
} from "./xlsx-formula.js";
import { type HAlign, type StyleChange, StyleSheet, type VAlign } from "./xlsx-style.js";
import {
  type CellInput,
  parseInput,
  type RecalcResult,
  recalcSheets,
  SharedStrings,
  type WriteContext,
  writeCell,
} from "./xlsx-write.js";

/**
 * Var olan Excel kitabını düzenleme (`xlsx_edit`). İlke `docx_edit` ile aynı: dokunulmayan her şey
 * (paket girdileri, stiller, grafikler, makrolar) olduğu gibi kalır; değişen XML ayrıştırılıp geri
 * yazılır (`ooxml.ts`).
 *
 * Satır/sütun ekleyip silmek Excel'deki gibi davranır: bütün sayfalardaki formüller, tanımlı adlar,
 * birleşik hücreler, koşullu biçim ve veri doğrulama aralıkları, tablolar, otomatik filtre, grafik
 * seri başvuruları, pivot kaynağı, çizim konumları ve notlar kayar; silinen hücreye bakan başvuru
 * `#REF!` olur. Paylaşılan formüller önce tek tek açılır: ana hücresi kayınca bağımlıları yanlış
 * hücreye dönerdi. `calcChain.xml` silinir, kitap `fullCalcOnLoad` ile açılır; değerler yazımda
 * yeniden hesaplanır (`xlsx-calc.ts`).
 */

export type XlsxEditAction =
  | "set"
  | "clear"
  | "append"
  | "row_insert"
  | "row_delete"
  | "col_insert"
  | "col_delete"
  | "merge"
  | "unmerge"
  | "format"
  | "sheet_add"
  | "sheet_delete"
  | "sheet_rename"
  | "table_remove";

export const XLSX_EDIT_ACTIONS: readonly XlsxEditAction[] = [
  "set",
  "clear",
  "append",
  "row_insert",
  "row_delete",
  "col_insert",
  "col_delete",
  "merge",
  "unmerge",
  "format",
  "sheet_add",
  "sheet_delete",
  "sheet_rename",
  "table_remove",
];

export interface XlsxFormat {
  numberFormat?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
  align?: HAlign;
  valign?: VAlign;
  wrap?: boolean;
  border?: "all" | "bottom" | "none";
  width?: number;
}

export interface XlsxEdit extends XlsxFormat {
  action: XlsxEditAction;
  sheet?: string;
  range?: string;
  value?: CellInput;
  values?: CellInput[][];
  count?: number;
  name?: string;
}

export class XlsxEditError extends Error {}

export interface XlsxEditResult {
  bytes: Buffer;
  counts: Partial<Record<XlsxEditAction, number>>;
  recalc: RecalcResult;
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_SHARED = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
const CT_STYLES = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
/** Tek eylemde yazılabilecek/biçimlenebilecek en çok hücre. */
const MAX_CELLS = 200_000;

const isType = (type: string | undefined, name: string) => type?.endsWith(`/${name}`) ?? false;

/** Worksheet çocuklarının şemadaki sırası: yeni öğe (mergeCells, cols) doğru yere girsin. */
const WS_ORDER = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "mergeCells",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst",
];

/** Workbook çocuklarının sırası (`calcPr` eklemek için). */
const WB_ORDER = [
  "fileVersion",
  "fileSharing",
  "workbookPr",
  "workbookProtection",
  "bookViews",
  "sheets",
  "functionGroups",
  "externalReferences",
  "definedNames",
  "calcPr",
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
  "extLst",
];

function ensureChild(parent: XmlNode, name: string, order: readonly string[]): XmlNode {
  const found = child(parent, name);
  if (found) return found;
  const node = el(name);
  const rank = order.indexOf(name);
  const at = parent.children.findIndex((c) => isElement(c) && order.indexOf(c.name) > rank);
  if (at < 0) parent.children.push(node);
  else parent.children.splice(at, 0, node);
  return node;
}

function removeChild(parent: XmlNode, node: XmlNode) {
  parent.children = parent.children.filter((c) => c !== node);
}

/** `A1` ya da `Sayfa 2!B3:C4` / `'Sayfa 2'!B3`: sayfa öneki ayrılır. */
function splitSheet(text: string): { sheet?: string; range: string } {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(text.trim());
  if (!m) return { range: text.trim() };
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? "");
  return { sheet, range: m[3] ?? "" };
}

// ─── Sayfa ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Düzenlemeden önce hata önbelleği taşıyan hücreler: uyarıda yalnız düzenlemenin doğurduğu hatalar
 * gösterilsin. Düğüm taşımada aynı nesne kaldığından satır/sütun kaymasına da dayanır.
 */
const cachedErrors = new WeakMap<XmlNode, string>();
const ERROR_TEXTS = new Set([
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
  "#SPILL!",
  "#CALC!",
]);

function rewrite(node: XmlNode, parsed: Parameters<typeof writeCell>[1], ctx: WriteContext) {
  cachedErrors.delete(node);
  writeCell(node, parsed, ctx);
}

class SheetDoc {
  readonly ws: XmlNode;
  readonly data: XmlNode;
  readonly rows = new Map<number, XmlNode>();
  dirty = false;

  constructor(
    public name: string,
    readonly part: string,
    readonly root: XmlNode,
  ) {
    const ws = child(root, "worksheet");
    if (!ws) throw new XlsxEditError("worksheet");
    this.ws = ws;
    this.data = ensureChild(ws, "sheetData", WS_ORDER);
    // `r` öznitelikleri isteğe bağlıdır; konum hesabı her yerde açık adrese dayansın.
    let r = 0;
    for (const row of elements(this.data)) {
      if (row.name !== "row") continue;
      r = Number(row.attrs.r) || r + 1;
      row.attrs.r = String(r);
      let c = 0;
      for (const cell of elements(row)) {
        if (cell.name !== "c") continue;
        c = (cell.attrs.r ? parseAddress(cell.attrs.r)?.col : undefined) ?? c + 1;
        cell.attrs.r = addressOf(r, c);
        // Excel dışı araçlar hatayı metin olarak da saklar (t="str", "#N/A").
        const cached = textOf(child(cell, "v") ?? el("v"));
        if (cell.attrs.t === "e" || (cell.attrs.t === "str" && ERROR_TEXTS.has(cached))) {
          cachedErrors.set(cell, cached);
        }
      }
    }
    this.reindex();
  }

  reindex() {
    this.rows.clear();
    for (const row of elements(this.data)) {
      if (row.name === "row") this.rows.set(Number(row.attrs.r), row);
    }
  }

  row(r: number, create: boolean): XmlNode | undefined {
    const found = this.rows.get(r);
    if (found || !create) return found;
    const row = el("row", { r: String(r) });
    const at = this.data.children.findIndex(
      (c) => isElement(c) && c.name === "row" && Number(c.attrs.r) > r,
    );
    if (at < 0) this.data.children.push(row);
    else this.data.children.splice(at, 0, row);
    this.rows.set(r, row);
    return row;
  }

  cell(r: number, c: number, create: boolean): XmlNode | undefined {
    const row = this.row(r, create);
    if (!row) return undefined;
    const cells = row.children;
    let at = cells.length;
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i];
      if (!x || !isElement(x) || x.name !== "c") continue;
      const col = parseAddress(x.attrs.r ?? "")?.col ?? 0;
      if (col === c) return x;
      if (col > c) {
        at = i;
        break;
      }
    }
    if (!create) return undefined;
    const node = el("c", { r: addressOf(r, c) });
    const s = this.defaultStyle(r, c);
    if (s) node.attrs.s = String(s);
    cells.splice(at, 0, node);
    delete row.attrs.spans;
    return node;
  }

  styleAt(r: number, c: number): number | undefined {
    const cell = this.cell(r, c, false);
    return cell ? Number(cell.attrs.s ?? 0) || 0 : undefined;
  }

  colAttrs(c: number): Record<string, string> | undefined {
    for (const col of elements(child(this.ws, "cols") ?? el("cols"))) {
      if (Number(col.attrs.min) <= c && c <= Number(col.attrs.max)) return col.attrs;
    }
    return undefined;
  }

  /**
   * Boş hücreye yazılırken verilecek stil: satırın ya da sütunun stili (Excel böyle yapar); üstteki
   * iki hücre aynı stildeyse o (liste düzenini sürdürür: kenarlık, para biçimi).
   */
  defaultStyle(r: number, c: number): number {
    const row = this.rows.get(r);
    if (row?.attrs.customFormat === "1" && row.attrs.s) return Number(row.attrs.s) || 0;
    const above = r > 2 ? this.styleAt(r - 1, c) : undefined;
    if (above && above === this.styleAt(r - 2, c)) return above;
    return Number(this.colAttrs(c)?.style ?? 0) || 0;
  }

  *cells(): Generator<{ r: number; c: number; node: XmlNode; row: XmlNode }> {
    for (const row of elements(this.data)) {
      if (row.name !== "row") continue;
      const r = Number(row.attrs.r);
      for (const node of elements(row)) {
        if (node.name !== "c") continue;
        yield { r, c: parseAddress(node.attrs.r ?? "")?.col ?? 0, node, row };
      }
    }
  }

  /** Değeri ya da formülü olan son satır (yalnız biçimli hücreler sayılmaz). */
  lastDataRow(): number {
    let last = 0;
    for (const { r, node } of this.cells()) {
      if (r > last && (child(node, "v") || child(node, "f") || child(node, "is"))) last = r;
    }
    return last;
  }

  updateDimension() {
    let top = MAX_ROW;
    let left = MAX_COL;
    let bottom = 0;
    let right = 0;
    for (const { r, c } of this.cells()) {
      top = Math.min(top, r);
      bottom = Math.max(bottom, r);
      left = Math.min(left, c);
      right = Math.max(right, c);
    }
    const ref = bottom === 0 ? "A1" : rangeText({ top, left, bottom, right });
    ensureChild(this.ws, "dimension", WS_ORDER).attrs.ref = ref;
  }
}

/** Hücrenin formülünü (varsa) `fn` ile değiştirir. */
function mapCellFormula(node: XmlNode, fn: (f: string) => string): boolean {
  const f = child(node, "f");
  if (!f) return false;
  const text = textOf(f);
  if (!text) return false;
  const next = fn(text);
  if (next === text) return false;
  f.children = [next];
  return true;
}

/** Koşullu biçim, veri doğrulama (ve x14 uzantılarındaki) formül öğeleri. */
const META_FORMULAS = new Set(["formula", "formula1", "formula2", "xm:f"]);

function mapMetaFormulas(node: XmlNode, fn: (f: string) => string): boolean {
  let changed = false;
  for (const c of elements(node)) {
    if (c.name === "sheetData") continue;
    if (META_FORMULAS.has(c.name)) {
      const text = textOf(c);
      const next = text ? fn(text) : text;
      if (next !== text) {
        c.children = [next];
        changed = true;
      }
    } else if (mapMetaFormulas(c, fn)) changed = true;
  }
  return changed;
}

// ─── Düzenleyici ────────────────────────────────────────────────────────────────────────────────

class Editor {
  readonly #zip: ZipArchive;
  readonly #info: WorkbookInfo;
  readonly #wb: XmlNode;
  readonly #lang: Locale;
  readonly #d: ReturnType<typeof dict>;
  readonly #styles: StyleSheet;
  readonly #strings: SharedStrings;
  readonly #ctx: WriteContext;
  readonly #docs = new Map<string, SheetDoc>();
  readonly #parts = new Map<string, XmlNode>();
  readonly #dirtyParts = new Set<string>();
  #wbRels: XmlNode;
  #types: XmlNode;
  #wbDirty = true;
  #relsDirty = false;
  #typesDirty = false;
  #unshared = new Set<string>();
  /** Parça → ilişkileri; zip'ten açıp ayrıştırmak tablo başına tekrarlanmasın. */
  readonly #relsCache = new Map<string, Map<string, { target: string; type: string }>>();
  /**
   * `ad[` biçiminde geçen her ad (küçük harf) → o formüllü hücreler. Art arda `table_remove`'lar
   * kitabı bir kez gezsin; tablo kaldırma hücreleri yerinden oynatmaz.
   */
  #formulaIndex: Map<string, { doc: SheetDoc; r: number; node: XmlNode }[]> | undefined;
  #stylesPart: string | undefined;
  #sharedPart: string | undefined;

  constructor(bytes: Uint8Array, lang: Locale) {
    this.#lang = lang;
    this.#d = dict(lang);
    this.#zip = openXlsxPackage(bytes, lang);
    this.#info = loadWorkbook(this.#zip, lang);
    const wb = child(this.#info.workbook, "workbook");
    if (!wb) throw new XlsxEditError(this.#d.xlsx.noBody);
    this.#wb = wb;
    this.#wbRels = parseXml(
      this.#zip.readText(relsPathOf(this.#info.workbookPart)) ??
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    );
    this.#types = parseXml(this.#zip.readText("[Content_Types].xml") ?? "");
    const rels = [...this.#info.rels.values()];
    this.#stylesPart = rels.find((r) => isType(r.type, "styles"))?.target;
    this.#sharedPart = rels.find((r) => isType(r.type, "sharedStrings"))?.target;
    const stylesXml = this.#stylesPart ? this.#zip.readText(this.#stylesPart) : undefined;
    this.#styles = new StyleSheet(stylesXml);
    const sharedXml = this.#sharedPart ? this.#zip.readText(this.#sharedPart) : undefined;
    this.#strings = new SharedStrings(sharedXml);
    this.#ctx = {
      strings: this.#strings,
      styles: this.#styles,
      date1904: this.#info.date1904,
      ...dateFormats(lang),
    };
  }

  #fail(message: string, vars: Record<string, string | number> = {}): never {
    const text = Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)),
      message,
    );
    throw new XlsxEditError(text);
  }

  // ─── Parçalar ───

  #part(path: string): XmlNode | undefined {
    const cached = this.#parts.get(path);
    if (cached) return cached;
    const xml = this.#zip.readText(path);
    if (xml === undefined) return undefined;
    const root = parseXml(xml);
    this.#parts.set(path, root);
    return root;
  }

  #sheetEls(): XmlNode[] {
    return elements(child(this.#wb, "sheets") ?? el("sheets")).filter((s) => s.name === "sheet");
  }

  #relTarget(rId: string): { target: string; type: string } | undefined {
    const rel = elements(child(this.#wbRels, "Relationships") ?? el("x")).find(
      (r) => r.attrs.Id === rId,
    );
    if (!rel?.attrs.Target) return undefined;
    const target = rel.attrs.Target.startsWith("/")
      ? rel.attrs.Target.slice(1)
      : `${dirname(this.#info.workbookPart) === "." ? "" : `${dirname(this.#info.workbookPart)}/`}${rel.attrs.Target}`;
    return { target: normalizePath(target), type: rel.attrs.Type ?? "" };
  }

  /** Çalışma sayfaları, kitaptaki sırayla (grafik sayfaları hariç). */
  #allDocs(): SheetDoc[] {
    const out: SheetDoc[] = [];
    for (const s of this.#sheetEls()) {
      const doc = this.#docByName(s.attrs.name ?? "", false);
      if (doc) out.push(doc);
    }
    return out;
  }

  #docByName(name: string, required = true): SheetDoc | undefined {
    const key = name.toLowerCase();
    const cached = this.#docs.get(key);
    if (cached) return cached;
    const sheet = this.#sheetEls().find((s) => (s.attrs.name ?? "").toLowerCase() === key);
    const rel = sheet ? this.#relTarget(sheet.attrs["r:id"] ?? "") : undefined;
    if (!sheet || !rel) {
      if (!required) return undefined;
      this.#fail(this.#d.xlsxEdit.sheetNotFound, { name, names: this.#names().join(", ") });
    }
    if (!isType(rel.type, "worksheet")) {
      if (!required) return undefined;
      this.#fail(this.#d.xlsxEdit.chartSheet, { name });
    }
    const xml = this.#zip.readText(rel.target);
    if (!xml) this.#fail(this.#d.xlsxEdit.sheetNotFound, { name, names: this.#names().join(", ") });
    const doc = new SheetDoc(sheet.attrs.name ?? name, rel.target, parseXml(xml));
    this.#docs.set(key, doc);
    return doc;
  }

  #names(): string[] {
    return this.#sheetEls().map((s) => s.attrs.name ?? "");
  }

  /** `sheet` verilmezse ilk çalışma sayfası; aralıktaki `Sayfa!` öneki önceliklidir. */
  #target(edit: XlsxEdit): { doc: SheetDoc; range?: string } {
    const split = edit.range ? splitSheet(edit.range) : undefined;
    const name = split?.sheet ?? edit.sheet;
    if (name?.trim()) {
      const doc = this.#docByName(name.trim());
      if (!doc)
        this.#fail(this.#d.xlsxEdit.sheetNotFound, { name, names: this.#names().join(", ") });
      return { doc, ...(split ? { range: split.range } : {}) };
    }
    const first = this.#allDocs()[0];
    if (!first) this.#fail(this.#d.xlsxEdit.sheetNotFound, { name: "", names: "" });
    return { doc: first, ...(split ? { range: split.range } : {}) };
  }

  #cellRange(text: string | undefined): CellRange {
    if (!text?.trim()) this.#fail(this.#d.xlsxEdit.rangeRequired);
    const range = parseRange(text);
    if (!range) this.#fail(this.#d.xlsxEdit.badRange, { range: text });
    return range;
  }

  // ─── Paylaşılan ve dizi formülleri ───

  /** Sayfadaki paylaşılan formülleri hücre başına ayrı formüle açar. */
  #unshare(doc: SheetDoc) {
    if (this.#unshared.has(doc.part)) return;
    this.#unshared.add(doc.part);
    const masters = new Map<string, { text: string; r: number; c: number }>();
    const shared: { node: XmlNode; f: XmlNode; r: number; c: number }[] = [];
    for (const { r, c, node } of doc.cells()) {
      const f = child(node, "f");
      if (f?.attrs.t !== "shared") continue;
      const text = textOf(f);
      if (text && f.attrs.si !== undefined) masters.set(f.attrs.si, { text, r, c });
      shared.push({ node, f, r, c });
    }
    for (const { f, r, c } of shared) {
      const master = masters.get(f.attrs.si ?? "");
      const text =
        textOf(f) || (master ? translateFormula(master.text, r - master.r, c - master.c) : "");
      const ca = f.attrs.ca;
      f.attrs = ca ? { ca } : {};
      f.children = text ? [text] : [];
      doc.dirty = true;
    }
  }

  #unshareAll() {
    for (const doc of this.#allDocs()) this.#unshare(doc);
  }

  /** Dizi formülünün bir kısmı yazılamaz (Excel de izin vermez). */
  #checkArrays(doc: SheetDoc, range: CellRange) {
    for (const { node } of doc.cells()) {
      const f = child(node, "f");
      if (f?.attrs.t !== "array" || !f.attrs.ref) continue;
      const a = parseRange(f.attrs.ref);
      if (!a) continue;
      const overlaps =
        a.left <= range.right &&
        range.left <= a.right &&
        a.top <= range.bottom &&
        range.top <= a.bottom;
      const covered =
        range.top <= a.top &&
        range.left <= a.left &&
        range.bottom >= a.bottom &&
        range.right >= a.right;
      if (overlaps && !covered) this.#fail(this.#d.xlsxEdit.arrayPartial, { range: f.attrs.ref });
    }
  }

  // ─── Hücre yazma ───

  #write(
    doc: SheetDoc,
    r: number,
    c: number,
    input: CellInput,
    translate?: { dr: number; dc: number },
  ) {
    const parsed = parseInput(input, this.#info.date1904);
    const node = doc.cell(r, c, parsed.kind !== "empty");
    if (!node) return;
    if (parsed.kind === "formula" && translate) {
      parsed.formula = translateFormula(parsed.formula, translate.dr, translate.dc);
    }
    rewrite(node, parsed, this.#ctx);
    doc.dirty = true;
  }

  set(edit: XlsxEdit): number {
    const { doc, range: text } = this.#target(edit);
    const range = this.#cellRange(text ?? edit.range);
    this.#unshare(doc);
    if (edit.values !== undefined) {
      const rows = edit.values.length;
      const cols = Math.max(0, ...edit.values.map((v) => v.length));
      if (rows === 0 || cols === 0) this.#fail(this.#d.xlsxEdit.valuesRequired);
      const single = range.top === range.bottom && range.left === range.right;
      const height = range.bottom - range.top + 1;
      const width = range.right - range.left + 1;
      if (!single && (rows > height || cols > width)) {
        this.#fail(this.#d.xlsxEdit.valuesTooLarge, { rows, cols, height, width });
      }
      if (range.top + rows - 1 > MAX_ROW || range.left + cols - 1 > MAX_COL) {
        this.#fail(this.#d.xlsxEdit.outOfSheet);
      }
      if (rows * cols > MAX_CELLS) this.#fail(this.#d.xlsxEdit.tooManyCells, { n: MAX_CELLS });
      const area = { ...range, bottom: range.top + rows - 1, right: range.left + cols - 1 };
      this.#checkArrays(doc, area);
      edit.values.forEach((row, i) => {
        row.forEach((v, j) => {
          this.#write(doc, range.top + i, range.left + j, v);
        });
      });
      return rows * cols;
    }
    if (edit.value === undefined) this.#fail(this.#d.xlsxEdit.valuesRequired);
    const n = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (n > MAX_CELLS) this.#fail(this.#d.xlsxEdit.tooManyCells, { n: MAX_CELLS });
    this.#checkArrays(doc, range);
    // Tek formül aralığa verilince Excel'deki doldurma gibi göreli başvurular hücreye göre kayar.
    for (let r = range.top; r <= range.bottom; r++) {
      for (let c = range.left; c <= range.right; c++) {
        this.#write(doc, r, c, edit.value, { dr: r - range.top, dc: c - range.left });
      }
    }
    return n;
  }

  clear(edit: XlsxEdit): number {
    const { doc, range: text } = this.#target(edit);
    const range = this.#cellRange(text ?? edit.range);
    this.#unshare(doc);
    this.#checkArrays(doc, range);
    let n = 0;
    for (const { r, c, node } of [...doc.cells()]) {
      if (r < range.top || r > range.bottom || c < range.left || c > range.right) continue;
      if (child(node, "v") || child(node, "f") || child(node, "is")) n++;
      rewrite(node, { kind: "empty" }, this.#ctx);
    }
    doc.dirty = true;
    return n;
  }

  /**
   * Son dolu satırın altına satır ekler: biçim son satırdan kopyalanır; verilmeyen sondaki
   * sütunlarda son satırın formülü kaydırılarak sürer (tablodaki hesaplı sütun gibi). Son satırda
   * biten tablo ve otomatik filtre yeni satırları kapsayacak şekilde büyür.
   */
  append(edit: XlsxEdit): number {
    const { doc } = this.#target(edit);
    const values = edit.values ?? (edit.value !== undefined ? [[edit.value]] : undefined);
    if (!values || values.length === 0) this.#fail(this.#d.xlsxEdit.valuesRequired);
    this.#unshare(doc);
    const last = doc.lastDataRow();
    const start = last + 1;
    if (start + values.length - 1 > MAX_ROW) this.#fail(this.#d.xlsxEdit.outOfSheet);
    const template = last > 1 ? doc.rows.get(last) : undefined;
    values.forEach((row, i) => {
      const r = start + i;
      this.#copyRowFormat(doc, template, r);
      row.forEach((v, j) => {
        this.#write(doc, r, j + 1, v);
      });
      if (template) {
        for (const cell of elements(template)) {
          const col = parseAddress(cell.attrs.r ?? "")?.col ?? 0;
          const f = child(cell, "f");
          if (col <= row.length || !f || !textOf(f)) continue;
          this.#write(doc, r, col, `=${translateFormula(textOf(f), r - last, 0)}`);
        }
      }
    });
    if (last > 0) this.#growTables(doc, last, values.length);
    doc.dirty = true;
    return values.length;
  }

  #copyRowFormat(doc: SheetDoc, template: XmlNode | undefined, r: number) {
    const row = doc.row(r, true);
    if (!row || !template) return;
    for (const key of ["ht", "customHeight", "s", "customFormat"]) {
      const v = template.attrs[key];
      if (v !== undefined) row.attrs[key] = v;
    }
    for (const cell of elements(template)) {
      const col = parseAddress(cell.attrs.r ?? "")?.col ?? 0;
      const s = cell.attrs.s;
      if (!col || !s || s === "0") continue;
      const node = doc.cell(r, col, true);
      if (node) node.attrs.s = s;
    }
  }

  /** `last` satırında biten tabloları ve otomatik filtreyi `n` satır uzatır. */
  #growTables(doc: SheetDoc, last: number, n: number) {
    const grow = (node: XmlNode | undefined) => {
      const range = node?.attrs.ref ? parseRange(node.attrs.ref) : undefined;
      if (!node || !range || range.bottom !== last) return false;
      node.attrs.ref = rangeText({ ...range, bottom: last + n });
      return true;
    };
    grow(child(doc.ws, "autoFilter"));
    for (const part of this.#sheetParts(doc, "table")) {
      const table = child(this.#part(part) ?? el("x"), "table");
      if (table && grow(table)) {
        grow(child(table, "autoFilter"));
        this.#dirtyParts.add(part);
      }
    }
  }

  #rels(part: string): Map<string, { target: string; type: string }> {
    let rels = this.#relsCache.get(part);
    if (!rels) {
      rels = readRels(this.#zip, part);
      this.#relsCache.set(part, rels);
    }
    return rels;
  }

  #sheetParts(doc: SheetDoc, type: string): string[] {
    return [...this.#rels(doc.part).values()]
      .filter((r) => isType(r.type, type))
      .map((r) => r.target);
  }

  // ─── Satır/sütun ekleme ve silme ───

  #lineSpan(edit: XlsxEdit, axis: "row" | "col", text: string | undefined): [number, number] {
    const raw = (text ?? edit.range ?? "").trim().replace(/\$/g, "");
    if (!raw) this.#fail(this.#d.xlsxEdit.rangeRequired);
    const [a, b, extra] = raw.split(":");
    const one = (s: string | undefined) => {
      if (!s) return undefined;
      if (axis === "row") {
        const n = /^\d+$/.test(s) ? Number(s) : parseAddress(s)?.row;
        return n !== undefined && n >= 1 && n <= MAX_ROW ? n : undefined;
      }
      const n = /^[A-Za-z]{1,3}$/.test(s) ? colIndex(s) : parseAddress(s)?.col;
      return n !== undefined && n >= 1 && n <= MAX_COL ? n : undefined;
    };
    const from = one(a);
    const to = b === undefined ? from : one(b);
    if (extra !== undefined || from === undefined || to === undefined) {
      this.#fail(axis === "row" ? this.#d.xlsxEdit.badRows : this.#d.xlsxEdit.badCols, {
        range: raw,
      });
    }
    return [Math.min(from, to), Math.max(from, to)];
  }

  insertLines(edit: XlsxEdit, axis: "row" | "col"): number {
    const { doc, range } = this.#target(edit);
    const [from, to] = this.#lineSpan(edit, axis, range);
    const count = Math.max(1, Math.floor(edit.count ?? to - from + 1));
    const max = axis === "row" ? MAX_ROW : MAX_COL;
    let lastUsed = 0;
    for (const { r, c } of doc.cells()) lastUsed = Math.max(lastUsed, axis === "row" ? r : c);
    if (lastUsed + count > max) this.#fail(this.#d.xlsxEdit.outOfSheet);
    this.#structural(doc, { sheet: doc.name, axis, at: from, count });
    if (edit.values) {
      edit.values.forEach((row, i) => {
        row.forEach((v, j) => {
          if (axis === "row") this.#write(doc, from + i, j + 1, v);
          else this.#write(doc, j + 1, from + i, v);
        });
      });
    }
    return count;
  }

  deleteLines(edit: XlsxEdit, axis: "row" | "col"): number {
    const { doc, range } = this.#target(edit);
    const [from, to] = this.#lineSpan(edit, axis, range);
    this.#structural(doc, { sheet: doc.name, axis, at: from, count: -(to - from + 1) });
    return to - from + 1;
  }

  #structural(target: SheetDoc, shift: StructuralShift) {
    const removed = this.#checkTables(target, shift);
    this.#unshareAll();
    // Başvurular önce A1'e çevrilir, ardından kaydırma silinen alana düştükleri için `#REF!` yapar.
    for (const { part, table } of removed) this.#removeTable(target, part, table);
    this.#moveCells(target, shift);
    const formula = (doc: SheetDoc) => (f: string) => shiftFormula(f, doc.name, shift);
    for (const doc of this.#allDocs()) {
      let changed = false;
      for (const { node } of doc.cells()) {
        if (mapCellFormula(node, formula(doc))) changed = true;
      }
      if (mapMetaFormulas(doc.ws, formula(doc))) changed = true;
      if (changed) doc.dirty = true;
    }
    this.#shiftMeta(target, shift);
    this.#mapNames((f) => shiftFormula(f, undefined, shift));
    this.#shiftTables(target, shift);
    this.#mapCharts((f) => shiftFormula(f, undefined, shift));
    this.#mapPivots(target.name, (src) => {
      const ref = src.attrs.ref;
      if (!ref) return false;
      const next = shiftRangeText(ref, shift);
      if (!next || next === ref) return false;
      src.attrs.ref = next;
      return true;
    });
    this.#shiftDrawings(target, shift);
    this.#shiftComments(target, shift);
    target.dirty = true;
  }

  /** Satır/sütun taşıma, silinenleri atma ve eklenenlere komşunun biçimini verme. */
  #moveCells(doc: SheetDoc, shift: StructuralShift) {
    const { axis, at, count } = shift;
    if (axis === "row") {
      doc.data.children = doc.data.children.filter((row) => {
        if (!isElement(row) || row.name !== "row") return true;
        const r = Number(row.attrs.r);
        const moved = shiftIndex(r, shift);
        if (moved === undefined) return false;
        if (moved !== r) {
          row.attrs.r = String(moved);
          for (const c of elements(row)) {
            const col = parseAddress(c.attrs.r ?? "")?.col;
            if (col) c.attrs.r = addressOf(moved, col);
            const f = child(c, "f");
            if (f?.attrs.ref) f.attrs.ref = shiftRangeText(f.attrs.ref, shift) ?? f.attrs.ref;
          }
        }
        return true;
      });
      doc.reindex();
      if (count > 0) {
        // Başlığın altına eklenen satır başlığın değil ilk gövde satırının biçimini alır.
        const source =
          at === 2 ? (doc.rows.get(at + count) ?? doc.rows.get(1)) : doc.rows.get(at - 1);
        for (let r = at; r < at + count; r++) this.#copyRowFormat(doc, source, r);
      }
      return;
    }
    for (const row of elements(doc.data)) {
      if (row.name !== "row") continue;
      delete row.attrs.spans;
      const r = Number(row.attrs.r);
      row.children = row.children.filter((c) => {
        if (!isElement(c) || c.name !== "c") return true;
        const col = parseAddress(c.attrs.r ?? "")?.col ?? 0;
        const moved = shiftIndex(col, shift);
        if (moved === undefined) return false;
        c.attrs.r = addressOf(r, moved);
        const f = child(c, "f");
        if (f?.attrs.ref) f.attrs.ref = shiftRangeText(f.attrs.ref, shift) ?? f.attrs.ref;
        return true;
      });
      if (count > 0) {
        const sourceCol = at > 1 ? at - 1 : at + count;
        const source = elements(row).find((c) => parseAddress(c.attrs.r ?? "")?.col === sourceCol);
        const s = source?.attrs.s;
        if (s && s !== "0") {
          for (let c = at; c < at + count; c++) {
            const node = doc.cell(r, c, true);
            if (node) node.attrs.s = s;
          }
        }
      }
    }
    this.#shiftCols(doc, shift);
  }

  /** `<cols>` aralıkları; eklenen sütun soldakinin genişliğini ve stilini alır. */
  #shiftCols(doc: SheetDoc, shift: StructuralShift) {
    const cols = child(doc.ws, "cols");
    if (!cols) return;
    const out: XmlNode[] = [];
    for (const col of elements(cols)) {
      const span = shiftSpan(Number(col.attrs.min), Number(col.attrs.max), shift, MAX_COL);
      if (!span) continue;
      col.attrs.min = String(span[0]);
      col.attrs.max = String(span[1]);
      out.push(col);
    }
    if (shift.count > 0 && shift.at > 1) {
      const left = out.find((c) => Number(c.attrs.max) === shift.at - 1);
      const covered = out.some(
        (c) => Number(c.attrs.min) <= shift.at && shift.at <= Number(c.attrs.max),
      );
      if (left && !covered) {
        const copy = cloneNode(left);
        copy.attrs.min = String(shift.at);
        copy.attrs.max = String(shift.at + shift.count - 1);
        out.push(copy);
      }
    }
    out.sort((a, b) => Number(a.attrs.min) - Number(b.attrs.min));
    if (out.length === 0) removeChild(doc.ws, cols);
    else cols.children = out;
  }

  /** Sayfadaki aralık öznitelikleri: birleşim, filtre, koşullu biçim, doğrulama, köprü, seçim. */
  #shiftMeta(doc: SheetDoc, shift: StructuralShift) {
    const collapse = (text: string | undefined) => (text ? shiftRangeText(text, shift) : undefined);
    const removable = new Set([
      "mergeCell",
      "hyperlink",
      "conditionalFormatting",
      "dataValidation",
      "protectedRange",
      "ignoredError",
      "autoFilter",
      "x14:conditionalFormatting",
      "x14:dataValidation",
      "brk",
    ]);
    const walk = (node: XmlNode) => {
      node.children = node.children.filter((c) => {
        if (!isElement(c) || c.name === "sheetData" || c.name === "dimension") return true;
        for (const key of ["ref", "sqref"]) {
          const v = c.attrs[key];
          if (v === undefined) continue;
          const next = collapse(v);
          if (next === undefined) {
            if (removable.has(c.name)) return false;
            c.attrs[key] = "A1";
          } else c.attrs[key] = next;
        }
        for (const key of ["topLeftCell", "activeCell"]) {
          const v = c.attrs[key];
          if (v !== undefined) c.attrs[key] = collapse(v) ?? "A1";
        }
        if (c.name === "xm:sqref") {
          const next = collapse(textOf(c));
          if (next === undefined) return false;
          c.children = [next];
        }
        if (c.name === "brk" && c.attrs.id !== undefined) {
          const owner = node.name === "rowBreaks" ? "row" : "col";
          if (owner === shift.axis) {
            const moved = shiftIndex(Number(c.attrs.id), shift);
            if (moved === undefined) return false;
            c.attrs.id = String(moved);
          }
        }
        walk(c);
        // Kapsayıcısı boşalan koşullu biçim/doğrulama x14 sarmalayıcıyla birlikte düşer.
        if (c.name === "x14:conditionalFormatting" || c.name === "x14:dataValidation") {
          return child(c, "xm:sqref") !== undefined;
        }
        return true;
      });
    };
    walk(doc.ws);
    const merges = child(doc.ws, "mergeCells");
    if (merges) {
      merges.children = elements(merges).filter((m) => {
        const r = parseRange(m.attrs.ref ?? "");
        return r !== undefined && (r.top !== r.bottom || r.left !== r.right);
      });
      if (merges.children.length === 0) removeChild(doc.ws, merges);
      else merges.attrs.count = String(merges.children.length);
    }
    for (const name of [
      "dataValidations",
      "hyperlinks",
      "rowBreaks",
      "colBreaks",
      "protectedRanges",
      "ignoredErrors",
    ]) {
      const list = child(doc.ws, name);
      if (!list) continue;
      const n = elements(list).length;
      if (n === 0) removeChild(doc.ws, list);
      else if (list.attrs.count !== undefined) list.attrs.count = String(n);
      if (name === "rowBreaks" || name === "colBreaks") {
        if (list.attrs.manualBreakCount !== undefined) list.attrs.manualBreakCount = String(n);
      }
    }
  }

  #mapNames(fn: (f: string) => string) {
    for (const n of elements(child(this.#wb, "definedNames") ?? el("x"))) {
      const text = textOf(n);
      const next = text ? fn(text) : text;
      if (next !== text) {
        n.children = [next];
        this.#wbDirty = true;
      }
    }
  }

  #chartParts(): string[] {
    return this.#zip.names().filter((n) => /^xl\/charts\/chart[^/]*\.xml$/i.test(n));
  }

  #mapCharts(fn: (f: string) => string) {
    for (const part of this.#chartParts()) {
      const root = this.#part(part);
      if (!root) continue;
      let changed = false;
      const walk = (node: XmlNode) => {
        for (const c of elements(node)) {
          if (c.name.endsWith(":f")) {
            const text = textOf(c);
            const next = text ? fn(text) : text;
            if (next !== text) {
              c.children = [next];
              changed = true;
            }
          } else walk(c);
        }
      };
      walk(root);
      if (changed) this.#dirtyParts.add(part);
    }
  }

  #mapPivots(sheet: string, fn: (source: XmlNode) => boolean) {
    for (const part of this.#zip.names()) {
      if (!/^xl\/pivotCache\/pivotCacheDefinition[^/]*\.xml$/i.test(part)) continue;
      const root = this.#part(part);
      const src = root ? findFirst(root, "worksheetSource") : undefined;
      if (!src || !sameSheet(src.attrs.sheet, sheet)) continue;
      if (fn(src)) this.#dirtyParts.add(part);
    }
  }

  /**
   * Silme bir tablonun başlığını ya da tüm veri satırlarını yok edecekse durdurur; tabloyu tümüyle
   * kapsıyorsa tablo kaldırılacaklar listesine girer (Excel de siler).
   */
  #checkTables(doc: SheetDoc, shift: StructuralShift): { part: string; table: XmlNode }[] {
    const whole: { part: string; table: XmlNode }[] = [];
    if (shift.count > 0) return whole;
    const first = shift.at;
    const last = shift.at - shift.count - 1;
    for (const part of this.#sheetParts(doc, "table")) {
      const table = child(this.#part(part) ?? el("x"), "table");
      const range = table?.attrs.ref ? parseRange(table.attrs.ref) : undefined;
      if (!table || !range) continue;
      const [lo, hi] = shift.axis === "row" ? [range.top, range.bottom] : [range.left, range.right];
      if (hi < first || lo > last) continue;
      const name = table.attrs.displayName ?? table.attrs.name ?? "";
      if (first <= lo && hi <= last) {
        whole.push({ part, table });
        continue;
      }
      if (shift.axis === "row") {
        const header = table.attrs.headerRowCount !== "0";
        const totals = Number(table.attrs.totalsRowCount ?? 0) > 0;
        if (header && first <= lo && lo <= last) this.#fail(this.#d.xlsxEdit.tableHeader, { name });
        const dataTop = header ? lo + 1 : lo;
        const dataBottom = totals ? hi - 1 : hi;
        if (first <= dataTop && dataBottom <= last)
          this.#fail(this.#d.xlsxEdit.tableEmpty, { name });
      }
    }
    return whole;
  }

  /** Tablo aralığı; sütun ekleme/silmede tablo sütun listesi de güncellenir. */
  #shiftTables(doc: SheetDoc, shift: StructuralShift) {
    for (const part of this.#sheetParts(doc, "table")) {
      const table = child(this.#part(part) ?? el("x"), "table");
      const range = table?.attrs.ref ? parseRange(table.attrs.ref) : undefined;
      if (!table || !range) continue;
      const next = shiftRangeText(table.attrs.ref ?? "", shift);
      if (!next) continue;
      table.attrs.ref = next;
      const filter = child(table, "autoFilter");
      if (filter?.attrs.ref) filter.attrs.ref = shiftRangeText(filter.attrs.ref, shift) ?? next;
      const columns = child(table, "tableColumns");
      for (const col of elements(columns ?? el("x"))) {
        for (const name of ["calculatedColumnFormula", "totalsRowFormula"]) {
          const f = child(col, name);
          if (f && textOf(f)) f.children = [shiftFormula(textOf(f), doc.name, shift)];
        }
      }
      if (shift.axis === "col" && columns) this.#tableColumns(doc, table, columns, range, shift);
      this.#dirtyParts.add(part);
    }
  }

  #tableColumns(
    doc: SheetDoc,
    table: XmlNode,
    columns: XmlNode,
    range: CellRange,
    shift: StructuralShift,
  ) {
    const list = elements(columns);
    const filter = child(table, "autoFilter");
    const filters = elements(filter ?? el("x")).filter((f) => f.name === "filterColumn");
    if (shift.count < 0) {
      const from = Math.max(range.left, shift.at) - range.left;
      const to = Math.min(range.right, shift.at - shift.count - 1) - range.left;
      if (to < from) return;
      columns.children = list.filter((_, i) => i < from || i > to);
      if (filter) {
        filter.children = filters
          .filter((f) => {
            const id = Number(f.attrs.colId);
            return id < from || id > to;
          })
          .map((f) => {
            const id = Number(f.attrs.colId);
            if (id > to) f.attrs.colId = String(id - (to - from + 1));
            return f;
          });
      }
    } else {
      // Ekleme tablonun içindeyse (sol kenarında değil) tabloya yeni sütun girer.
      if (!(range.left < shift.at && shift.at <= range.right)) return;
      const index = shift.at - range.left;
      const used = new Set(list.map((c) => (c.attrs.name ?? "").toLowerCase()));
      let id = Math.max(0, ...list.map((c) => Number(c.attrs.id) || 0));
      const added: XmlNode[] = [];
      for (let i = 0; i < shift.count; i++) {
        let n = 1;
        let name = `${this.#d.xlsxEdit.tableColumn}${n}`;
        while (used.has(name.toLowerCase())) name = `${this.#d.xlsxEdit.tableColumn}${++n}`;
        used.add(name.toLowerCase());
        added.push(el("tableColumn", { id: String(++id), name }));
        if (table.attrs.headerRowCount !== "0") {
          this.#write(doc, range.top, shift.at + i, `'${name}`);
        }
      }
      columns.children = [...list.slice(0, index), ...added, ...list.slice(index)];
      for (const f of filters) {
        const cid = Number(f.attrs.colId);
        if (cid >= index) f.attrs.colId = String(cid + shift.count);
      }
    }
    columns.attrs.count = String(elements(columns).length);
  }

  /** Resim ve grafiklerin hücre çapaları (0 tabanlı satır/sütun). */
  #shiftDrawings(doc: SheetDoc, shift: StructuralShift) {
    const tag = shift.axis === "row" ? "xdr:row" : "xdr:col";
    for (const part of this.#sheetParts(doc, "drawing")) {
      const root = this.#part(part);
      if (!root) continue;
      let changed = false;
      const walk = (node: XmlNode) => {
        for (const c of elements(node)) {
          if ((c.name === "xdr:from" || c.name === "xdr:to") && child(c, tag)) {
            const pos = child(c, tag);
            if (!pos) continue;
            const n = Number(textOf(pos)) + 1;
            const moved = shiftIndex(n, shift) ?? shift.at;
            if (moved !== n) {
              pos.children = [String(moved - 1)];
              changed = true;
            }
          } else walk(c);
        }
      };
      walk(root);
      if (changed) this.#dirtyParts.add(part);
    }
  }

  /** Notlar (eski yorumlar), notların VML kutuları ve yazışmalı yorumlar. */
  #shiftComments(doc: SheetDoc, shift: StructuralShift) {
    const moveRef = (ref: string) => {
      const a = parseAddress(ref);
      if (!a) return ref;
      const moved = shiftIndex(shift.axis === "row" ? a.row : a.col, shift);
      if (moved === undefined) return undefined;
      return shift.axis === "row" ? addressOf(moved, a.col) : addressOf(a.row, moved);
    };
    for (const part of [
      ...this.#sheetParts(doc, "comments"),
      ...this.#sheetParts(doc, "threadedComment"),
    ]) {
      const root = this.#part(part);
      if (!root) continue;
      const walk = (node: XmlNode) => {
        node.children = node.children.filter((c) => {
          if (!isElement(c)) return true;
          if ((c.name === "comment" || c.name === "threadedComment") && c.attrs.ref) {
            const next = moveRef(c.attrs.ref);
            if (next === undefined) return false;
            c.attrs.ref = next;
            return true;
          }
          walk(c);
          return true;
        });
      };
      walk(root);
      this.#dirtyParts.add(part);
    }
    // VML'i ayrıştırıp geri yazmak Excel'in gevşek VML'ini bozabilir; yalnız not kutusunun hücre
    // konumu metin üzerinde değiştirilir, silinen hücrenin kutusu çıkarılır.
    for (const part of this.#sheetParts(doc, "vmlDrawing")) {
      const xml = this.#zip.readText(part);
      if (!xml) continue;
      const tag = shift.axis === "row" ? "x:Row" : "x:Column";
      const next = xml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (shape) => {
        const m = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(shape);
        if (!m?.[1]) return shape;
        const moved = shiftIndex(Number(m[1]) + 1, shift);
        if (moved === undefined) return "";
        return shape.replace(m[0], `<${tag}>${moved - 1}</${tag}>`);
      });
      if (next !== xml) this.#zip.set(part, next);
    }
  }

  // ─── Birleştirme ve biçim ───

  merge(edit: XlsxEdit): number {
    const { doc, range: text } = this.#target(edit);
    const range = this.#cellRange(text ?? edit.range);
    if (range.top === range.bottom && range.left === range.right) {
      this.#fail(this.#d.xlsxEdit.mergeSingle);
    }
    const merges = ensureChild(doc.ws, "mergeCells", WS_ORDER);
    for (const m of elements(merges)) {
      const r = parseRange(m.attrs.ref ?? "");
      if (
        r &&
        r.left <= range.right &&
        range.left <= r.right &&
        r.top <= range.bottom &&
        range.top <= r.bottom
      ) {
        this.#fail(this.#d.xlsxEdit.mergeOverlap, { range: m.attrs.ref ?? "" });
      }
    }
    this.#unshare(doc);
    this.#checkArrays(doc, range);
    // Excel birleştirmede yalnız sol üst hücrenin değerini tutar.
    for (const { r, c, node } of [...doc.cells()]) {
      if (r < range.top || r > range.bottom || c < range.left || c > range.right) continue;
      if (r === range.top && c === range.left) continue;
      rewrite(node, { kind: "empty" }, this.#ctx);
    }
    merges.children.push(el("mergeCell", { ref: rangeText(range) }));
    merges.attrs.count = String(elements(merges).length);
    doc.dirty = true;
    return 1;
  }

  unmerge(edit: XlsxEdit): number {
    const { doc, range: text } = this.#target(edit);
    const range = this.#cellRange(text ?? edit.range);
    const merges = child(doc.ws, "mergeCells");
    const inside = (r: CellRange) =>
      r.left <= range.right &&
      range.left <= r.right &&
      r.top <= range.bottom &&
      range.top <= r.bottom;
    const before = merges ? elements(merges).length : 0;
    if (merges) {
      merges.children = elements(merges).filter((m) => {
        const r = parseRange(m.attrs.ref ?? "");
        return !r || !inside(r);
      });
    }
    const removed = before - (merges ? elements(merges).length : 0);
    if (removed === 0) this.#fail(this.#d.xlsxEdit.notMerged, { range: rangeText(range) });
    if (merges && elements(merges).length === 0) removeChild(doc.ws, merges);
    else if (merges) merges.attrs.count = String(elements(merges).length);
    doc.dirty = true;
    return removed;
  }

  format(edit: XlsxEdit): number {
    const { doc, range: text } = this.#target(edit);
    const range = this.#cellRange(text ?? edit.range);
    const change: StyleChange = {
      ...(edit.numberFormat !== undefined ? { numFmt: edit.numberFormat } : {}),
      ...(edit.bold !== undefined ? { bold: edit.bold } : {}),
      ...(edit.italic !== undefined ? { italic: edit.italic } : {}),
      ...(edit.color !== undefined ? { color: edit.color } : {}),
      ...(edit.fill !== undefined
        ? { fill: edit.fill === "" || edit.fill === "none" ? null : edit.fill }
        : {}),
      ...(edit.align !== undefined ? { align: edit.align } : {}),
      ...(edit.valign !== undefined ? { valign: edit.valign } : {}),
      ...(edit.wrap !== undefined ? { wrap: edit.wrap } : {}),
      ...(edit.border !== undefined ? { border: edit.border } : {}),
    };
    const styled = Object.keys(change).length > 0;
    if (!styled && edit.width === undefined) this.#fail(this.#d.xlsxEdit.formatRequired);
    const n = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (styled) {
      if (n > MAX_CELLS) this.#fail(this.#d.xlsxEdit.tooManyCells, { n: MAX_CELLS });
      const derived = new Map<number, number>();
      for (let r = range.top; r <= range.bottom; r++) {
        for (let c = range.left; c <= range.right; c++) {
          const node = doc.cell(r, c, true);
          if (!node) continue;
          const base = Number(node.attrs.s ?? 0) || 0;
          let s = derived.get(base);
          if (s === undefined) {
            s = this.#styles.derive(base, change);
            derived.set(base, s);
          }
          if (s) node.attrs.s = String(s);
          else delete node.attrs.s;
        }
      }
    }
    if (edit.width !== undefined) this.#setWidth(doc, range.left, range.right, edit.width);
    doc.dirty = true;
    return n;
  }

  #setWidth(doc: SheetDoc, left: number, right: number, width: number) {
    if (!(width > 0)) this.#fail(this.#d.xlsxEdit.badWidth);
    const cols = ensureChild(doc.ws, "cols", WS_ORDER);
    const out: XmlNode[] = [];
    for (const col of elements(cols)) {
      const min = Number(col.attrs.min);
      const max = Number(col.attrs.max);
      if (max < left || min > right) {
        out.push(col);
        continue;
      }
      if (min < left)
        out.push({ ...cloneNode(col), attrs: { ...col.attrs, max: String(left - 1) } });
      const mid = cloneNode(col);
      mid.attrs.min = String(Math.max(min, left));
      mid.attrs.max = String(Math.min(max, right));
      mid.attrs.width = String(Math.min(255, width));
      mid.attrs.customWidth = "1";
      delete mid.attrs.bestFit;
      out.push(mid);
      if (max > right)
        out.push({ ...cloneNode(col), attrs: { ...col.attrs, min: String(right + 1) } });
    }
    for (let c = left; c <= right; c++) {
      if (out.some((x) => Number(x.attrs.min) <= c && c <= Number(x.attrs.max))) continue;
      out.push(
        el("col", {
          min: String(c),
          max: String(c),
          width: String(Math.min(255, width)),
          customWidth: "1",
        }),
      );
    }
    out.sort((a, b) => Number(a.attrs.min) - Number(b.attrs.min));
    cols.children = out;
  }

  // ─── Sayfalar ───

  #checkName(name: string | undefined, except?: string): string {
    const clean = name?.trim() ?? "";
    const problem = sheetNameProblem(clean);
    if (problem) this.#fail(this.#d.xlsxEdit.nameInvalid, { name: clean });
    const taken = this.#names().some(
      (n) => n.toLowerCase() === clean.toLowerCase() && n.toLowerCase() !== except?.toLowerCase(),
    );
    if (taken) this.#fail(this.#d.xlsxEdit.nameTaken, { name: clean });
    return clean;
  }

  sheetAdd(edit: XlsxEdit): number {
    const name = this.#checkName(edit.name ?? edit.sheet);
    const sheets = ensureChild(this.#wb, "sheets", WB_ORDER);
    const parts = new Set(this.#zip.names());
    let n = 1;
    while (parts.has(`xl/worksheets/sheet${n}.xml`)) n++;
    const part = `xl/worksheets/sheet${n}.xml`;
    const relRoot = child(this.#wbRels, "Relationships");
    if (!relRoot) this.#fail(this.#d.xlsx.noBody);
    const ids = new Set(elements(relRoot).map((r) => r.attrs.Id));
    let k = elements(relRoot).length + 1;
    while (ids.has(`rId${k}`)) k++;
    const rId = `rId${k}`;
    relRoot.children.push(
      el("Relationship", {
        Id: rId,
        Type: `${REL}/worksheet`,
        Target: relTarget(this.#info.workbookPart, part),
      }),
    );
    const sheetId = Math.max(0, ...this.#sheetEls().map((s) => Number(s.attrs.sheetId) || 0)) + 1;
    sheets.children.push(el("sheet", { name, sheetId: String(sheetId), "r:id": rId }));
    this.#addOverride(part, CT_WORKSHEET);
    const built = buildWorksheet(
      { name, rows: edit.values ?? [] },
      name,
      false,
      this.#ctx,
      this.#lang,
    );
    const doc = new SheetDoc(name, part, built.root);
    doc.dirty = true;
    this.#docs.set(name.toLowerCase(), doc);
    this.#relsDirty = true;
    return 1;
  }

  sheetRename(edit: XlsxEdit): number {
    const { doc } = this.#target(edit);
    const from = doc.name;
    const to = this.#checkName(edit.name, from);
    if (from === to) return 0;
    for (const s of this.#sheetEls()) if (s.attrs.name === from) s.attrs.name = to;
    this.#docs.delete(from.toLowerCase());
    doc.name = to;
    this.#docs.set(to.toLowerCase(), doc);
    this.#renameEverywhere(from, to);
    this.#mapPivots(from, (src) => {
      src.attrs.sheet = to;
      return true;
    });
    return 1;
  }

  #renameEverywhere(from: string, to: string | undefined) {
    const fn = (f: string) => renameSheetInFormula(f, from, to);
    for (const doc of this.#allDocs()) {
      this.#unshare(doc);
      let changed = false;
      for (const { node } of doc.cells()) if (mapCellFormula(node, fn)) changed = true;
      if (mapMetaFormulas(doc.ws, fn)) changed = true;
      if (changed) doc.dirty = true;
    }
    this.#mapNames(fn);
    this.#mapCharts(fn);
  }

  sheetDelete(edit: XlsxEdit): number {
    const name = (edit.sheet ?? edit.name ?? "").trim();
    if (!name) this.#fail(this.#d.xlsxEdit.nameRequired);
    const els = this.#sheetEls();
    const index = els.findIndex((s) => (s.attrs.name ?? "").toLowerCase() === name.toLowerCase());
    const sheet = els[index];
    if (!sheet)
      this.#fail(this.#d.xlsxEdit.sheetNotFound, { name, names: this.#names().join(", ") });
    const visible = els.filter((s, i) => i !== index && (s.attrs.state ?? "visible") === "visible");
    if (visible.length === 0) this.#fail(this.#d.xlsxEdit.lastSheet);
    const realName = sheet.attrs.name ?? name;
    // Tablolar sayfayla gider: başka sayfalardaki `Tablo[...]` başvuruları önce A1'e çevrilir,
    // sayfa silinince `#REF!` olur; tablo parçası pakette sahipsiz kalmaz.
    const doomed = this.#docByName(realName, false);
    if (doomed) {
      for (const { part, table } of this.#tables(doomed)) this.#removeTable(doomed, part, table);
    }
    const rel = this.#relTarget(sheet.attrs["r:id"] ?? "");
    const sheets = child(this.#wb, "sheets");
    if (sheets) removeChild(sheets, sheet);
    const relRoot = child(this.#wbRels, "Relationships");
    if (relRoot) {
      relRoot.children = relRoot.children.filter(
        (r) => !isElement(r) || r.attrs.Id !== sheet.attrs["r:id"],
      );
    }
    if (rel) {
      this.#zip.remove(rel.target);
      this.#zip.remove(relsPathOf(rel.target));
      this.#relsCache.delete(rel.target);
      this.#removeOverride(rel.target);
    }
    this.#docs.delete(realName.toLowerCase());
    this.#renameEverywhere(realName, undefined);
    // Sayfaya yerel tanımlı adlar kalkar; sonraki sayfaların sırası bir azalır.
    const names = child(this.#wb, "definedNames");
    if (names) {
      names.children = elements(names).filter((n) => {
        const local = n.attrs.localSheetId;
        if (local === undefined) return true;
        const i = Number(local);
        if (i === index) return false;
        if (i > index) n.attrs.localSheetId = String(i - 1);
        return true;
      });
      if (names.children.length === 0) removeChild(this.#wb, names);
    }
    const remaining = this.#sheetEls();
    for (const view of elements(child(this.#wb, "bookViews") ?? el("x"))) {
      for (const key of ["activeTab", "firstSheet"]) {
        const v = Number(view.attrs[key] ?? 0);
        if (v > index || v >= remaining.length) view.attrs[key] = String(Math.max(0, v - 1));
      }
      let active = Number(view.attrs.activeTab ?? 0);
      while (
        active < remaining.length &&
        (remaining[active]?.attrs.state ?? "visible") !== "visible"
      ) {
        active++;
      }
      if (active >= remaining.length) active = 0;
      view.attrs.activeTab = String(active);
      const doc = this.#docByName(remaining[active]?.attrs.name ?? "", false);
      if (doc) {
        const sv = child(child(doc.ws, "sheetViews") ?? el("x"), "sheetView");
        if (sv) {
          sv.attrs.tabSelected = "1";
          doc.dirty = true;
        }
      }
    }
    this.#relsDirty = true;
    return 1;
  }

  // ─── İçerik türleri ───

  #addOverride(part: string, type: string) {
    const types = child(this.#types, "Types");
    if (!types) return;
    const name = `/${part}`;
    if (elements(types).some((o) => o.attrs.PartName === name)) return;
    types.children.push(el("Override", { PartName: name, ContentType: type }));
    this.#typesDirty = true;
  }

  #removeOverride(part: string) {
    const types = child(this.#types, "Types");
    if (!types) return;
    const name = `/${part}`.toLowerCase();
    types.children = types.children.filter(
      (o) => !isElement(o) || (o.attrs.PartName ?? "").toLowerCase() !== name,
    );
    this.#typesDirty = true;
  }

  // ─── Tablo kaldırma ───

  #tables(doc: SheetDoc): { part: string; table: XmlNode }[] {
    const out: { part: string; table: XmlNode }[] = [];
    for (const part of this.#sheetParts(doc, "table")) {
      const table = child(this.#part(part) ?? el("x"), "table");
      if (table) out.push({ part, table });
    }
    return out;
  }

  /**
   * Tabloyu kaldırır, hücreler yerinde kalır (Excel'in "Aralığa Dönüştür"ü). Tabloya bakan
   * yapılandırılmış başvurular kitabın her yerinde A1 aralığına çevrilir; pivot kaynağı tablo adı
   * yerine aralığı alır. Tablo stilinin renkleri hücrelere işlenmez.
   */
  #removeTable(doc: SheetDoc, part: string, table: XmlNode) {
    const name = table.attrs.displayName ?? table.attrs.name ?? "";
    const range = parseRange(table.attrs.ref ?? "");
    if (!range) this.#fail(this.#d.xlsxEdit.badRange, { range: table.attrs.ref ?? "" });
    const id = table.attrs.id;
    for (const cache of this.#zip.names()) {
      if (!/^xl\/slicerCaches\/[^/]+\.xml$/i.test(cache)) continue;
      if (id && new RegExp(`tableId="${id}"`).test(this.#zip.readText(cache) ?? "")) {
        this.#fail(this.#d.xlsxEdit.tableSlicer, { name });
      }
    }
    const shape: TableShape = {
      name,
      sheet: doc.name,
      range,
      header: table.attrs.headerRowCount !== "0",
      totals: Number(table.attrs.totalsRowCount ?? 0) > 0,
      columns: elements(child(table, "tableColumns") ?? el("x")).map((c) => c.attrs.name ?? ""),
    };
    this.#unshareAll();
    for (const { doc: d, r, node } of this.#formulaCells().get(name.toLowerCase()) ?? []) {
      const at = { sheet: d.name, row: r };
      if (mapCellFormula(node, (f) => replaceTableRefs(f, shape, at))) d.dirty = true;
    }
    for (const d of this.#allDocs()) {
      if (mapMetaFormulas(d.ws, (f) => replaceTableRefs(f, shape, { sheet: d.name }))) {
        d.dirty = true;
      }
    }
    this.#mapNames((f) => replaceTableRefs(f, shape));
    // Başka tabloların hesaplı sütun ve toplam formülleri.
    for (const other of this.#zip.names()) {
      if (other === part || !/^xl\/tables\/[^/]+\.xml$/i.test(other)) continue;
      const root = this.#part(other);
      const t = root ? child(root, "table") : undefined;
      if (!t) continue;
      const sheet = this.#tableSheet(other) ?? doc.name;
      for (const col of elements(child(t, "tableColumns") ?? el("x"))) {
        for (const key of ["calculatedColumnFormula", "totalsRowFormula"]) {
          const f = child(col, key);
          const text = f ? textOf(f) : "";
          const next = text ? replaceTableRefs(text, shape, { sheet }) : text;
          if (f && next !== text) {
            f.children = [next];
            this.#dirtyParts.add(other);
          }
        }
      }
    }
    for (const pivot of this.#zip.names()) {
      if (!/^xl\/pivotCache\/pivotCacheDefinition[^/]*\.xml$/i.test(pivot)) continue;
      const root = this.#part(pivot);
      const src = root ? findFirst(root, "worksheetSource") : undefined;
      if (!src || (src.attrs.name ?? "").toLowerCase() !== name.toLowerCase()) continue;
      delete src.attrs.name;
      src.attrs.ref = rangeText(range);
      src.attrs.sheet = doc.name;
      this.#dirtyParts.add(pivot);
    }
    // Sorgu tablosu (dış veri) parçası tabloya bağlıdır; bağlantının kendisi kitapta kalır.
    for (const rel of readRels(this.#zip, part).values()) {
      if (isType(rel.type, "queryTable")) this.#dropPart(rel.target);
    }
    this.#dropPart(part);
    this.#dropSheetRel(doc, part);
    doc.dirty = true;
  }

  #formulaCells(): Map<string, { doc: SheetDoc; r: number; node: XmlNode }[]> {
    if (this.#formulaIndex) return this.#formulaIndex;
    const out = new Map<string, { doc: SheetDoc; r: number; node: XmlNode }[]>();
    const named = /([A-Za-z_\\\u00C0-\uFFFF][\w.\\\u00C0-\uFFFF]*)\[/g;
    for (const doc of this.#allDocs()) {
      for (const row of elements(doc.data)) {
        if (row.name !== "row") continue;
        const r = Number(row.attrs.r);
        for (const node of elements(row)) {
          const f = node.name === "c" ? child(node, "f") : undefined;
          const text = f ? textOf(f) : "";
          if (!text.includes("[")) continue;
          const seen = new Set<string>();
          for (const m of text.matchAll(named)) {
            const key = (m[1] ?? "").toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const list = out.get(key);
            if (list) list.push({ doc, r, node });
            else out.set(key, [{ doc, r, node }]);
          }
        }
      }
    }
    this.#formulaIndex = out;
    return out;
  }

  /** Hücre yazan ya da taşıyan her düzenlemeden önce: formül dizini eskir. */
  invalidate() {
    this.#formulaIndex = undefined;
  }

  #dropPart(part: string) {
    this.#zip.remove(part);
    this.#zip.remove(relsPathOf(part));
    this.#removeOverride(part);
    this.#parts.delete(part);
    this.#dirtyParts.delete(part);
  }

  /** Sayfanın ilişkisini ve `<tablePart>` öğesini kaldırır; ilişki dosyası hemen yazılır. */
  #dropSheetRel(doc: SheetDoc, part: string) {
    const relsPath = relsPathOf(doc.part);
    const relsRoot = this.#part(relsPath);
    const list = relsRoot ? child(relsRoot, "Relationships") : undefined;
    if (!relsRoot || !list) return;
    const base = dirname(doc.part);
    const ids = new Set<string>();
    list.children = list.children.filter((r) => {
      if (!isElement(r) || !r.attrs.Target) return true;
      const t = r.attrs.Target;
      const full = t.startsWith("/") ? t.slice(1) : normalizePath(`${base}/${t}`);
      if (full !== part) return true;
      if (r.attrs.Id) ids.add(r.attrs.Id);
      return false;
    });
    this.#zip.set(relsPath, serializeXml(relsRoot));
    this.#relsCache.delete(doc.part);
    const parts = child(doc.ws, "tableParts");
    if (parts) {
      parts.children = elements(parts).filter((p) => !ids.has(p.attrs["r:id"] ?? ""));
      const n = elements(parts).length;
      if (n === 0) removeChild(doc.ws, parts);
      else parts.attrs.count = String(n);
    }
  }

  /** Tablo parçasının bağlı olduğu sayfanın adı. */
  #tableSheet(part: string): string | undefined {
    for (const s of this.#sheetEls()) {
      const rel = this.#relTarget(s.attrs["r:id"] ?? "");
      if (!rel || !isType(rel.type, "worksheet")) continue;
      for (const r of this.#rels(rel.target).values()) {
        if (r.target === part) return s.attrs.name;
      }
    }
    return undefined;
  }

  /** `name` (tablo adı) ya da `range` içindeki hücrenin tablosunu aralığa dönüştürür. */
  tableRemove(edit: XlsxEdit): number {
    const wanted = edit.name?.trim().toLowerCase();
    const candidates: { doc: SheetDoc; part: string; table: XmlNode }[] = [];
    if (wanted) {
      for (const doc of this.#allDocs()) {
        for (const t of this.#tables(doc)) candidates.push({ doc, ...t });
      }
    } else {
      const { doc, range: text } = this.#target(edit);
      const cell = this.#cellRange(text ?? edit.range);
      for (const t of this.#tables(doc)) candidates.push({ doc, ...t });
      const hit = candidates.find(({ table }) => {
        const r = parseRange(table.attrs.ref ?? "");
        return (
          r &&
          r.top <= cell.top &&
          cell.top <= r.bottom &&
          r.left <= cell.left &&
          cell.left <= r.right
        );
      });
      if (!hit) this.#fail(this.#d.xlsxEdit.noTableAt, { range: edit.range ?? text ?? "" });
      this.#removeTable(hit.doc, hit.part, hit.table);
      return 1;
    }
    const hit = candidates.find(({ table }) =>
      [table.attrs.displayName, table.attrs.name].some((n) => n?.toLowerCase() === wanted),
    );
    if (!hit) {
      const names = candidates.map(({ table }) => table.attrs.displayName ?? table.attrs.name);
      this.#fail(this.#d.xlsxEdit.tableNotFound, {
        name: edit.name ?? "",
        names: names.join(", ") || "-",
      });
    }
    this.#removeTable(hit.doc, hit.part, hit.table);
    return 1;
  }

  // ─── Yazım ───

  finish(now?: Date): { bytes: Buffer; recalc: RecalcResult } {
    // Hesap zinciri Excel'in önbelleğidir; eskisi kalırsa Excel onarım ister.
    const relRoot = child(this.#wbRels, "Relationships");
    if (relRoot) {
      relRoot.children = relRoot.children.filter((r) => {
        if (!isElement(r) || !isType(r.attrs.Type, "calcChain")) return true;
        const target = this.#relTarget(r.attrs.Id ?? "");
        if (target) {
          this.#zip.remove(target.target);
          this.#removeOverride(target.target);
        }
        this.#relsDirty = true;
        return false;
      });
    }
    const calc = ensureChild(this.#wb, "calcPr", WB_ORDER);
    calc.attrs.fullCalcOnLoad = "1";

    const docs = this.#allDocs();
    const names = new Map<string, string>();
    for (const n of elements(child(this.#wb, "definedNames") ?? el("x"))) {
      if (
        n.attrs.localSheetId === undefined &&
        n.attrs.name &&
        !n.attrs.name.startsWith("_xlnm.")
      ) {
        names.set(n.attrs.name, textOf(n));
      }
    }
    const recalc = recalcSheets(
      docs.map((d) => ({ name: d.name, root: d.root })),
      this.#strings.list(),
      { date1904: this.#info.date1904, names, known: cachedErrors, ...(now ? { now } : {}) },
    );
    for (const doc of docs) {
      if (recalc.changed.has(doc.name)) doc.dirty = true;
      if (!doc.dirty) continue;
      doc.updateDimension();
      this.#zip.set(doc.part, serializeXml(doc.root));
    }
    for (const part of this.#dirtyParts) {
      const root = this.#parts.get(part);
      if (root) this.#zip.set(part, serializeXml(root));
    }
    if (this.#strings.changed) {
      if (!this.#sharedPart) {
        this.#sharedPart = "xl/sharedStrings.xml";
        this.#addRel("sharedStrings", this.#sharedPart);
        this.#addOverride(this.#sharedPart, CT_SHARED);
      }
      this.#zip.set(this.#sharedPart, this.#strings.toXml());
    }
    if (this.#styles.changed || !this.#stylesPart) {
      if (!this.#stylesPart) {
        this.#stylesPart = "xl/styles.xml";
        this.#addRel("styles", this.#stylesPart);
        this.#addOverride(this.#stylesPart, CT_STYLES);
      }
      this.#zip.set(this.#stylesPart, this.#styles.toXml());
    }
    if (this.#wbDirty) this.#zip.set(this.#info.workbookPart, serializeXml(this.#info.workbook));
    if (this.#relsDirty)
      this.#zip.set(relsPathOf(this.#info.workbookPart), serializeXml(this.#wbRels));
    if (this.#typesDirty) this.#zip.set("[Content_Types].xml", serializeXml(this.#types));
    return { bytes: this.#zip.toBuffer(), recalc };
  }

  #addRel(type: string, part: string) {
    const relRoot = child(this.#wbRels, "Relationships");
    if (!relRoot) return;
    const ids = new Set(elements(relRoot).map((r) => r.attrs.Id));
    let k = elements(relRoot).length + 1;
    while (ids.has(`rId${k}`)) k++;
    relRoot.children.push(
      el("Relationship", {
        Id: `rId${k}`,
        Type: `${REL}/${type}`,
        Target: relTarget(this.#info.workbookPart, part),
      }),
    );
    this.#relsDirty = true;
  }
}

function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of elements(node)) {
    if (c.name === name) return c;
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return undefined;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const piece of path.split("/")) {
    if (piece === "..") out.pop();
    else if (piece && piece !== ".") out.push(piece);
  }
  return out.join("/");
}

/** Kitap parçasına göre göreli hedef (`xl/workbook.xml` → `worksheets/sheet3.xml`). */
function relTarget(from: string, part: string): string {
  const base = dirname(from);
  return base && base !== "." && part.startsWith(`${base}/`)
    ? part.slice(base.length + 1)
    : `/${part}`;
}

/** Düzenlemeleri sırayla uygular; biri başarısız olursa hiçbiri yazılmaz. */
export function editXlsx(
  bytes: Uint8Array,
  edits: readonly XlsxEdit[],
  options: { lang?: Locale; now?: Date } = {},
): XlsxEditResult {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const editor = new Editor(bytes, lang);
  const counts: Partial<Record<XlsxEditAction, number>> = {};
  edits.forEach((edit, i) => {
    let n: number;
    if (edit.action !== "table_remove") editor.invalidate();
    try {
      switch (edit.action) {
        case "set":
          n = editor.set(edit);
          break;
        case "clear":
          n = editor.clear(edit);
          break;
        case "append":
          n = editor.append(edit);
          break;
        case "row_insert":
          n = editor.insertLines(edit, "row");
          break;
        case "row_delete":
          n = editor.deleteLines(edit, "row");
          break;
        case "col_insert":
          n = editor.insertLines(edit, "col");
          break;
        case "col_delete":
          n = editor.deleteLines(edit, "col");
          break;
        case "merge":
          n = editor.merge(edit);
          break;
        case "unmerge":
          n = editor.unmerge(edit);
          break;
        case "format":
          n = editor.format(edit);
          break;
        case "sheet_add":
          n = editor.sheetAdd(edit);
          break;
        case "sheet_delete":
          n = editor.sheetDelete(edit);
          break;
        case "sheet_rename":
          n = editor.sheetRename(edit);
          break;
        case "table_remove":
          n = editor.tableRemove(edit);
          break;
        default:
          throw new XlsxEditError(d.xlsxEdit.unknownAction);
      }
    } catch (error) {
      if (!(error instanceof XlsxEditError)) throw error;
      throw new XlsxEditError(
        d.xlsxEdit.editFailed
          .replace("{{n}}", String(i + 1))
          .replace("{{action}}", edit.action)
          .replace("{{message}}", error.message),
      );
    }
    counts[edit.action] = (counts[edit.action] ?? 0) + n;
  });
  const { bytes: out, recalc } = editor.finish(options.now);
  return { bytes: out, counts, recalc };
}

/**
 * `xlsx_edit`'in yazdığı dosya: `output` verilince o (kaynağın klasörüne göre, uzantı eklenir),
 * yoksa kaynağın kendisi.
 */
export function resolveXlsxEditTarget(
  path: string,
  output: string | undefined,
  cwd: string,
): { source: string; target: string } {
  const source = resolve(expandReadPath(path, cwd));
  if (!output?.trim()) return { source, target: source };
  const raw = output.trim();
  const abs = raw.startsWith("~")
    ? expandPath(raw)
    : isAbsolute(raw)
      ? resolve(raw)
      : resolve(dirname(source), raw);
  const ext = /\.xlsm$/i.test(source) ? ".xlsm" : ".xlsx";
  return { source, target: /\.(xlsx|xlsm)$/i.test(abs) ? abs : `${abs}${ext}` };
}
