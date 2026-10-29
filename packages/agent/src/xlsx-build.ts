import { dict, type Locale } from "@codezal/i18n";
import { el, serializeXml, type XmlNode, ZipArchive } from "./ooxml.js";
import { formatNumber } from "./xlsx.js";
import { addressOf, MAX_COL, MAX_ROW, parseRange, rangeText } from "./xlsx-formula.js";
import { StyleSheet } from "./xlsx-style.js";
import {
  type CellInput,
  MAIN_NS,
  parseInput,
  REL_NS,
  type RecalcResult,
  recalcSheets,
  SharedStrings,
  type WriteContext,
  writeCell,
} from "./xlsx-write.js";

/**
 * Sayfa belirtiminden Excel kitabı üretir (`xlsx_create`). Paket eklenmedi: kitap birkaç düz XML
 * parçasıdır (`ooxml.ts` ZIP yazar). Model yalnız hücre değerlerini verir; başlık satırı (kalın,
 * dolgu, alt çizgi, dondurma), sütun genişliği ve tarih biçimi burada kararlaştırılır. Formüller
 * yazılırken hesaplanır (`xlsx-calc.ts`) ki kitap Excel'de açılmadan da (okuma, Quick Look,
 * önizleme) değer göstersin; kitap `fullCalcOnLoad` ile açıldığında Excel yeniden hesaplar.
 */

export interface ColumnSpec {
  width?: number;
  format?: string;
}

export interface SheetSpec {
  name: string;
  rows: CellInput[][];
  /** İlk satır başlık mı; verilmezse ilk satır formülsüz metinlerden oluşuyorsa başlık sayılır. */
  header?: boolean;
  /** Sütun başına genişlik (karakter) ve sayı biçimi; sıra A, B, C… */
  columns?: ColumnSpec[];
  merge?: string[];
  /** Dondurulacak bölmenin sol üst kaydırılabilir hücresi (`B2`); başlık varsa varsayılan `A2`. */
  freeze?: string;
  /** Başlık satırına otomatik filtre. */
  filter?: boolean;
}

export interface XlsxBuildOptions {
  lang?: Locale;
  title?: string;
  now?: Date;
}

export interface XlsxBuildResult {
  bytes: Buffer;
  sheets: string[];
  rows: number;
  formulas: number;
  recalc: RecalcResult;
  warnings: string[];
}

const CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";
/** Başlık satırı görünümü: kalın, açık gri dolgu, alt çizgi. */
const HEADER_STYLE = { bold: true, fill: "F2F2F2", border: "bottom", valign: "center" } as const;

/** Yeni tarih hücresine verilen biçim (hücrenin kendi tarih biçimi yoksa). */
export function dateFormats(lang: Locale): Pick<WriteContext, "dateFormat" | "dateTimeFormat"> {
  return lang === "tr"
    ? { dateFormat: "dd.mm.yyyy", dateTimeFormat: "dd.mm.yyyy hh:mm" }
    : { dateFormat: "yyyy-mm-dd", dateTimeFormat: "yyyy-mm-dd hh:mm" };
}
const MAX_TEXT = 32_767;

/** Excel sayfa adı kuralları: 31 karakter, `[]:*?/\` yok, kesme işaretiyle başlayıp bitmez, tekil. */
export function sheetNameProblem(name: string): "empty" | "chars" | "long" | undefined {
  if (!name.trim()) return "empty";
  if (/[[\]:*?/\\]/.test(name) || /^'|'$/.test(name)) return "chars";
  if (name.length > 31) return "long";
  return undefined;
}

export function cleanSheetName(
  raw: string,
  index: number,
  used: Set<string>,
  lang: Locale,
): string {
  const d = dict(lang);
  let name = raw
    .replace(/[[\]:*?/\\]/g, "-")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 31);
  if (!name) name = d.xlsx.defaultSheet.replace("{{n}}", String(index + 1));
  let unique = name;
  for (let n = 2; used.has(unique.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    unique = `${name.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(unique.toLowerCase());
  return unique;
}

/** Hücrenin genişlik tahmini için görünen uzunluğu (en uzun satırı). */
function shownLength(input: CellInput, format: string | undefined): number {
  if (input === null) return 0;
  if (typeof input === "number") return formatNumber(input, format).length;
  if (typeof input === "boolean") return 5;
  if (input.startsWith("=")) return 10;
  return Math.max(...input.split("\n").map((l) => l.length));
}

/**
 * Tek sayfanın XML ağacı. Hücreler `ctx`'in paylaşılan metin ve stil tablosuna yazılır; düzenleme
 * (`xlsx_edit` sayfa ekleme) aynı işlevi kitabın kendi tablolarıyla çağırır.
 */
export function buildWorksheet(
  spec: SheetSpec,
  name: string,
  selected: boolean,
  ctx: WriteContext,
  lang: Locale = "tr",
): { root: XmlNode; rows: number; formulas: number; warnings: string[] } {
  const d = dict(lang);
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const styles = ctx.styles;
  const warnings: string[] = [];
  let formulas = 0;
  const headerStyle = styles.derive(0, HEADER_STYLE);
  const rows = spec.rows.slice(0, MAX_ROW);
  if (rows.length < spec.rows.length) warnings.push(fill(d.xlsx.tooManyRows, { sheet: name }));
  const width = Math.min(MAX_COL, Math.max(0, ...rows.map((r) => r.length)));
  const first = rows[0] ?? [];
  const header =
    spec.header ??
    (rows.length > 1 &&
      first.some((v) => v !== null && v !== "") &&
      first.every((v) => v === null || (typeof v === "string" && !v.startsWith("="))));
  const columnFormat = (col: number) => spec.columns?.[col - 1]?.format?.trim() || undefined;
  const colStyle = new Map<number, number>();
  const styleFor = (col: number) => {
    const format = columnFormat(col);
    if (!format) return 0;
    let s = colStyle.get(col);
    if (s === undefined) {
      s = styles.derive(0, { numFmt: format });
      colStyle.set(col, s);
    }
    return s;
  };

  const data = el("sheetData");
  const lengths: number[] = [];
  rows.forEach((values, r) => {
    const rowNo = r + 1;
    const row = el("row", { r: String(rowNo) });
    values.slice(0, MAX_COL).forEach((raw, i) => {
      const col = i + 1;
      let input = raw;
      if (typeof input === "string" && input.length > MAX_TEXT) {
        input = input.slice(0, MAX_TEXT);
        warnings.push(fill(d.xlsx.textTruncated, { ref: `${name}!${addressOf(rowNo, col)}` }));
      }
      const parsed = parseInput(input);
      if (parsed.kind === "empty") return;
      const isHeader = header && r === 0;
      const c = el("c", { r: addressOf(rowNo, col) });
      let s = isHeader ? headerStyle : styleFor(col);
      if (parsed.kind === "string" && parsed.value.includes("\n")) {
        s = styles.derive(s, { wrap: true, valign: "top" });
      }
      if (s) c.attrs.s = String(s);
      writeCell(c, parsed, ctx);
      if (parsed.kind === "formula") formulas++;
      row.children.push(c);
      const len = shownLength(input, columnFormat(col)) + (isHeader ? 2 : 0);
      lengths[col] = Math.max(lengths[col] ?? 0, len);
    });
    if (row.children.length > 0) data.children.push(row);
  });

  const ws = el("worksheet", { xmlns: MAIN_NS, "xmlns:r": REL_NS });
  const bottom = Math.max(1, rows.length);
  const right = Math.max(1, width);
  ws.children.push(el("dimension", { ref: rangeText({ top: 1, left: 1, bottom, right }) }));
  const view = el("sheetView", { workbookViewId: "0", ...(selected ? { tabSelected: "1" } : {}) });
  const freeze = spec.freeze ? parseRange(spec.freeze) : header ? parseRange("A2") : undefined;
  if (spec.freeze && !freeze) warnings.push(fill(d.xlsx.badRange, { range: spec.freeze }));
  if (freeze && (freeze.top > 1 || freeze.left > 1)) {
    const top = addressOf(freeze.top, freeze.left);
    const pane =
      freeze.top > 1 && freeze.left > 1
        ? "bottomRight"
        : freeze.top > 1
          ? "bottomLeft"
          : "topRight";
    view.children.push(
      el("pane", {
        ...(freeze.left > 1 ? { xSplit: String(freeze.left - 1) } : {}),
        ...(freeze.top > 1 ? { ySplit: String(freeze.top - 1) } : {}),
        topLeftCell: top,
        activePane: pane,
        state: "frozen",
      }),
      el("selection", { pane, activeCell: top, sqref: top }),
    );
  }
  ws.children.push(el("sheetViews", {}, [view]), el("sheetFormatPr", { defaultRowHeight: "15" }));
  const cols = el("cols");
  for (let col = 1; col <= right; col++) {
    const given = spec.columns?.[col - 1]?.width;
    const auto = Math.min(60, Math.max(8, Math.ceil((lengths[col] ?? 0) * 1.1) + 2));
    const w = given !== undefined && given > 0 ? Math.min(255, given) : auto;
    cols.children.push(
      el("col", { min: String(col), max: String(col), width: String(w), customWidth: "1" }),
    );
  }
  if (width > 0) ws.children.push(cols);
  ws.children.push(data);
  if (spec.filter && header && width > 0) {
    ws.children.push(el("autoFilter", { ref: rangeText({ top: 1, left: 1, bottom, right }) }));
  }
  const merges: string[] = [];
  const taken: { top: number; left: number; bottom: number; right: number }[] = [];
  for (const text of spec.merge ?? []) {
    const range = parseRange(text);
    if (!range || (range.top === range.bottom && range.left === range.right)) {
      warnings.push(fill(d.xlsx.badRange, { range: text }));
      continue;
    }
    const overlaps = taken.some(
      (t) =>
        t.left <= range.right &&
        range.left <= t.right &&
        t.top <= range.bottom &&
        range.top <= t.bottom,
    );
    if (overlaps) {
      warnings.push(fill(d.xlsx.mergeOverlap, { range: text }));
      continue;
    }
    taken.push(range);
    merges.push(rangeText(range));
  }
  if (merges.length > 0) {
    ws.children.push(
      el(
        "mergeCells",
        { count: String(merges.length) },
        merges.map((ref) => el("mergeCell", { ref })),
      ),
    );
  }
  ws.children.push(
    el("pageMargins", {
      left: "0.7",
      right: "0.7",
      top: "0.75",
      bottom: "0.75",
      header: "0.3",
      footer: "0.3",
    }),
  );
  return {
    root: { name: "#root", attrs: {}, children: [ws] },
    rows: rows.length,
    formulas,
    warnings,
  };
}

export function buildXlsx(
  specs: readonly SheetSpec[],
  options: XlsxBuildOptions = {},
): XlsxBuildResult {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  if (specs.length === 0) throw new Error(d.xlsx.noSheets);
  const warnings: string[] = [];
  const styles = new StyleSheet();
  const strings = new SharedStrings();
  const ctx: WriteContext = { strings, styles, date1904: false, ...dateFormats(lang) };
  const used = new Set<string>();
  const sheets: { name: string; root: XmlNode }[] = [];
  let totalRows = 0;
  let formulas = 0;
  specs.forEach((spec, index) => {
    const name = cleanSheetName(spec.name, index, used, lang);
    if (name !== spec.name) {
      warnings.push(d.xlsx.renamedSheet.replace("{{from}}", spec.name).replace("{{to}}", name));
    }
    const built = buildWorksheet(spec, name, index === 0, ctx, lang);
    sheets.push({ name, root: built.root });
    totalRows += built.rows;
    formulas += built.formulas;
    warnings.push(...built.warnings);
  });

  const recalc = recalcSheets(sheets, strings.list(), {
    date1904: false,
    ...(options.now ? { now: options.now } : {}),
  });

  const zip = ZipArchive.create();
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const now = (options.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const sheetParts = sheets.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`);
  zip.set(
    "[Content_Types].xml",
    `${decl}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>${sheetParts
      .map((p) => `<Override PartName="/${p}" ContentType="${CT}.worksheet+xml"/>`)
      .join(
        "",
      )}<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  zip.set(
    "_rels/.rels",
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  const title = options.title?.trim() || sheets[0]?.name || "";
  zip.set(
    "docProps/core.xml",
    `${decl}${serializeXml(
      el(
        "cp:coreProperties",
        {
          "xmlns:cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
          "xmlns:dc": "http://purl.org/dc/elements/1.1/",
          "xmlns:dcterms": "http://purl.org/dc/terms/",
          "xmlns:dcmitype": "http://purl.org/dc/dcmitype/",
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        },
        [
          el("dc:title", {}, [title]),
          el("dc:creator", {}, ["Codezal"]),
          el("dcterms:created", { "xsi:type": "dcterms:W3CDTF" }, [now]),
          el("dcterms:modified", { "xsi:type": "dcterms:W3CDTF" }, [now]),
        ],
      ),
    )}`,
  );
  zip.set(
    "docProps/app.xml",
    `${decl}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Codezal</Application></Properties>`,
  );
  const n = sheets.length;
  zip.set(
    "xl/_rels/workbook.xml.rels",
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetParts
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  const workbook = el("workbook", { xmlns: MAIN_NS, "xmlns:r": REL_NS }, [
    el("workbookPr"),
    el("bookViews", {}, [
      el("workbookView", {
        xWindow: "0",
        yWindow: "0",
        windowWidth: "28800",
        windowHeight: "16000",
        activeTab: "0",
      }),
    ]),
    el(
      "sheets",
      {},
      sheets.map((s, i) =>
        el("sheet", { name: s.name, sheetId: String(i + 1), "r:id": `rId${i + 1}` }),
      ),
    ),
    // Hesaplayıcının bilmediği işlevler önbelleksiz kalır; Excel açılışta hepsini hesaplar.
    el("calcPr", { calcId: "191029", fullCalcOnLoad: "1" }),
  ]);
  zip.set("xl/workbook.xml", `${decl}${serializeXml(workbook)}`);
  sheets.forEach((s, i) => {
    zip.set(`xl/worksheets/sheet${i + 1}.xml`, `${decl}${serializeXml(s.root)}`);
  });
  zip.set("xl/styles.xml", styles.toXml());
  zip.set("xl/sharedStrings.xml", strings.toXml());

  return {
    bytes: zip.toBuffer(),
    sheets: sheets.map((s) => s.name),
    rows: totalRows,
    formulas,
    recalc,
    warnings,
  };
}

/** Uyarı satırları: hata veren formüller (en çok 10). */
export function formulaWarnings(recalc: RecalcResult, lang: Locale = "tr"): string[] {
  const d = dict(lang);
  const shown = recalc.errors
    .slice(0, 10)
    .map((e) =>
      d.xlsx.formulaError
        .replace("{{ref}}", `${e.sheet}!${e.ref}`)
        .replace("{{error}}", e.error)
        .replace("{{formula}}", e.formula),
    );
  if (recalc.errors.length > shown.length) {
    shown.push(d.xlsx.moreErrors.replace("{{n}}", String(recalc.errors.length - shown.length)));
  }
  return shown;
}
