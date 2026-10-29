import { dirname, isAbsolute, resolve } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { columnWidths, parseInline, parseMarkdown } from "./docx-build.js";
import {
  child,
  cloneNode,
  el,
  elements,
  isElement,
  OoxmlError,
  parseXml,
  relsPathOf,
  resolvePart,
  serializeXml,
  textOf,
  type XmlNode,
  ZipArchive,
} from "./ooxml.js";
import { expandReadPath } from "./read-path.js";
import { expandPath } from "./resources.js";

/**
 * Var olan Word belgesini düzenleme: metin değiştir, paragraf ekle/sil, yorum ekle, izli
 * değişiklikleri kabul/ret et. Değişiklikler istenirse izli değişiklik (`w:ins`/`w:del`) olarak
 * yazılır; Word'de "Değişiklikleri İzle" açıkken yapılmış gibi görünür.
 *
 * Word metni run'lara böler (yazım denetimi, sürüm kimlikleri): ekranda bitişik görünen bir
 * ifade XML'de beş parçaya dağılmış olabilir. Eşleşme bu yüzden paragrafın "kabul edilmiş"
 * görünümünde (eklenenler dahil, silinenler hariç) aranır, sonra sınırlardaki run'lar ikiye
 * bölünür; biçim (rPr) her parçaya kopyalanır. Belgenin geri kalanına dokunulmaz (`ooxml.ts`).
 *
 * Tablo satırı işlemleri satırın okuma görünümündeki `| a | b |` satırında arar; yeni satır komşu
 * satırın kopyasıdır (hücre genişliği, gölge, paragraf ve run biçimi), yalnız metni değişir. Sütun
 * ve birleştirme işlemleri hücre metninde arar ve tablo ızgarasıyla (`w:tblGrid`, `gridSpan`,
 * `vMerge`) çalışır; tablonun toplam genişliği korunur. Yeni tablo belgedeki en yakın tablonun
 * görünümünü alır; belgede tablo yoksa `docx_create` tablosunun görünümüyle yazılır.
 */

export type DocxEditAction =
  | "replace"
  | "insert_after"
  | "insert_before"
  | "delete"
  | "comment"
  | "row_insert_after"
  | "row_insert_before"
  | "row_delete"
  | "col_insert_after"
  | "col_insert_before"
  | "col_delete"
  | "cell_merge"
  | "cell_split"
  | "table_insert_after"
  | "table_insert_before"
  | "table_delete"
  | "accept_all"
  | "reject_all";

export interface DocxEdit {
  action: DocxEditAction;
  find?: string;
  text?: string;
  all?: boolean;
  /** `cell_merge`: birleştirilecek aralığın karşı köşesindeki hücre. */
  to?: string;
}

export interface DocxEditOptions {
  track: boolean;
  author: string;
  /** ISO 8601, saniye hassasiyetinde (`2026-09-28T10:00:00Z`). */
  date: string;
  lang?: Locale;
}

export interface DocxEditResult {
  bytes: Buffer;
  /** Eylem başına uygulanan sayı (eşleşme ya da kabul/ret edilen değişiklik). */
  counts: Partial<Record<DocxEditAction, number>>;
}

export class DocxEditError extends Error {}

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_COMMENTS = `${NS_R}/comments`;
const CT_COMMENTS = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

/** Word'ün şemada beklediği sıra: rPr ve pPr alt öğeleri yanlış sırada olursa belge "bozuk" açılır. */
const RPR_ORDER = [
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:rStyle",
  "w:rFonts",
  "w:b",
  "w:bCs",
  "w:i",
  "w:iCs",
  "w:caps",
  "w:smallCaps",
  "w:strike",
  "w:dstrike",
];

/** Öğeyi sıra listesine göre doğru yere koyar; listede olmayan öğelerin önüne geçer. */
function putInOrder(parent: XmlNode, node: XmlNode, order: readonly string[]) {
  parent.children = parent.children.filter((c) => !isElement(c) || c.name !== node.name);
  const rank = order.indexOf(node.name);
  const at = parent.children.findIndex((c) => {
    if (!isElement(c)) return false;
    const r = order.indexOf(c.name);
    return r === -1 || r > rank;
  });
  if (at === -1) parent.children.push(node);
  else parent.children.splice(at, 0, node);
}

function replaceChild(parent: XmlNode, old: XmlNode, ...nodes: XmlNode[]) {
  const at = parent.children.indexOf(old);
  if (at >= 0) parent.children.splice(at, 1, ...nodes);
}

function insertAfter(parent: XmlNode, anchor: XmlNode, ...nodes: XmlNode[]) {
  const at = parent.children.indexOf(anchor);
  parent.children.splice(at < 0 ? parent.children.length : at + 1, 0, ...nodes);
}

function removeChild(parent: XmlNode, node: XmlNode) {
  parent.children = parent.children.filter((c) => c !== node);
}

// ─── Paketteki parçalar ────────────────────────────────────────────────────────────────────────

interface Part {
  name: string;
  root: XmlNode;
  dirty: boolean;
}

class DocxPackage {
  readonly zip: ZipArchive;
  readonly parts: Part[] = [];
  readonly #loaded = new Map<string, Part>();

  constructor(bytes: Uint8Array) {
    this.zip = ZipArchive.open(bytes);
    const document = this.load("word/document.xml");
    if (!document) throw new OoxmlError("noBody");
    this.parts.push(document);
    for (const type of ["header", "footer", "footnotes", "endnotes"]) {
      for (const target of this.relTargets(type)) {
        const part = this.load(target);
        if (part) this.parts.push(part);
      }
    }
  }

  load(name: string): Part | undefined {
    const cached = this.#loaded.get(name);
    if (cached) return cached;
    const text = this.zip.readText(name);
    if (text === undefined) return undefined;
    const part = { name, root: parseXml(text), dirty: false };
    this.#loaded.set(name, part);
    return part;
  }

  create(name: string, root: XmlNode): Part {
    const part = { name, root, dirty: true };
    this.#loaded.set(name, part);
    return part;
  }

  rels(): Part | undefined {
    return this.load(relsPathOf("word/document.xml"));
  }

  relTargets(type: string): string[] {
    const rels = this.rels();
    const root = rels ? child(rels.root, "Relationships") : undefined;
    return (root ? elements(root) : [])
      .filter((r) => r.attrs.Type?.endsWith(`/${type}`) && r.attrs.TargetMode !== "External")
      .map((r) => resolvePart("word/document.xml", r.attrs.Target ?? ""));
  }

  toBuffer(): Buffer {
    for (const part of this.#loaded.values()) {
      if (part.dirty) this.zip.set(part.name, serializeXml(part.root));
    }
    return this.zip.toBuffer();
  }
}

// ─── Paragraf metni ve eşleşme ─────────────────────────────────────────────────────────────────

interface Unit {
  run: XmlNode;
  parent: XmlNode;
  text: string;
  /** Başka birinin izli eklemesinin içinde: izli silmede sarılmaz, doğrudan kaldırılır. */
  inserted: boolean;
}

/** Görünmeyen ya da bölünemeyen içerik: eşleşme bunun üstünden atlayamaz. */
const OPAQUE = "￼";

function contentText(node: XmlNode): string | undefined {
  switch (node.name) {
    case "w:t":
      return textOf(node);
    case "w:tab":
    case "w:ptab":
      return "\t";
    case "w:br":
    case "w:cr":
      return "\n";
    case "w:noBreakHyphen":
      return "-";
    case "w:softHyphen":
    case "w:lastRenderedPageBreak":
      return undefined;
    default:
      return OPAQUE;
  }
}

/**
 * Birden çok içerik taşıyan run'ı (t + tab + t) her biri tek içerikli run'lara böler; biçim
 * her birine kopyalanır. Anlam değişmez, bölme ve sarma tek öğe üzerinde yapılabilir.
 */
function normalizeRun(parent: XmlNode, run: XmlNode): XmlNode[] {
  const rPr = child(run, "w:rPr");
  const contents = elements(run).filter((c) => c.name !== "w:rPr");
  if (contents.length <= 1) return [run];
  const runs = contents.map((c) =>
    el("w:r", { ...run.attrs }, [...(rPr ? [cloneNode(rPr)] : []), c]),
  );
  replaceChild(parent, run, ...runs);
  return runs;
}

const CONTAINERS = new Set([
  "w:hyperlink",
  "w:smartTag",
  "w:sdt",
  "w:sdtContent",
  "w:customXml",
  "w:fldSimple",
  "w:dir",
  "w:bdo",
]);

function collectUnits(container: XmlNode, inserted: boolean, out: Unit[]) {
  for (const c of [...elements(container)]) {
    if (c.name === "w:r") {
      for (const run of normalizeRun(container, c)) {
        const content = elements(run).find((x) => x.name !== "w:rPr");
        const text = content ? contentText(content) : undefined;
        if (text !== undefined) out.push({ run, parent: container, text, inserted });
      }
    } else if (c.name === "w:ins" || c.name === "w:moveTo") {
      collectUnits(c, true, out);
    } else if (CONTAINERS.has(c.name)) {
      collectUnits(c, inserted, out);
    }
    // w:del/w:moveFrom (kabul görünümünde yok), w:pPr, yer imleri, yorum aralıkları atlanır.
  }
}

function unitsOf(p: XmlNode): Unit[] {
  const out: Unit[] = [];
  collectUnits(p, false, out);
  return out;
}

const paragraphText = (units: Unit[]) => units.map((u) => u.text).join("");

/** Tüm paragraflar, belge sırasıyla; metin kutusunun Fallback kopyası atlanır (iki kez sayılmasın). */
function paragraphsOf(root: XmlNode, out: { p: XmlNode; parent: XmlNode }[] = [], parent = root) {
  for (const c of elements(root)) {
    if (c.name === "mc:Fallback") continue;
    if (c.name === "w:p") out.push({ p: c, parent });
    paragraphsOf(c, out, c);
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Aranan metnin deseni: boşluklar sekme ve bölünmez boşlukla, düz tırnaklar kıvrık tırnaklarla
 * eşleşir. Model belgeyi Markdown olarak okuduğu için bu farkları göremez.
 */
function findPattern(find: string): RegExp {
  const body = find
    .split(/(\s+|['"‘’“”])/)
    .filter((piece) => piece !== "")
    .map((piece) => {
      if (/^\s+$/.test(piece)) return "[\\s\\u00a0]+";
      if (/^['‘’]$/.test(piece)) return "['‘’]";
      if (/^["“”]$/.test(piece)) return '["“”]';
      return escapeRegExp(piece);
    })
    .join("");
  return new RegExp(body, "g");
}

/** Okuma görünümündeki Markdown/CriticMarkup işaretleri aranan metne kopyalanmışsa atılır. */
function stripMarkup(find: string): string {
  return find
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, "")
    .replace(/\{\+\+|\+\+\}|\{--|--\}|\{==|==\}/g, "")
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|\s)[*_]|[*_](\s|$)/g, "$1$2");
}

interface Match {
  part: Part;
  p: XmlNode;
  parent: XmlNode;
  start: number;
  end: number;
  preview: string;
  /** Eşleşme paragrafın tüm metnini kaplıyor (baş/son boşluk hariç). */
  whole: boolean;
}

function findMatches(find: string, parts: Part[]): Match[] {
  const run = (pattern: RegExp) => {
    const matches: Match[] = [];
    for (const part of parts) {
      for (const { p, parent } of paragraphsOf(part.root)) {
        const text = paragraphText(unitsOf(p));
        const visible = text.replace(new RegExp(OPAQUE, "g"), "").trim();
        for (const m of text.matchAll(pattern)) {
          if (m[0].length === 0 || m[0].includes(OPAQUE)) continue;
          matches.push({
            part,
            p,
            parent,
            start: m.index,
            end: m.index + m[0].length,
            preview: visible.slice(0, 80),
            whole: text.trim() === m[0].trim(),
          });
        }
      }
    }
    return matches;
  };
  const exact = run(findPattern(find));
  if (exact.length > 0) return exact;
  const stripped = stripMarkup(find).trim();
  if (!stripped || stripped === find) return exact;
  // İşaretli satır (`## Ödeme`, `- madde`) okuma görünümünden bütün olarak kopyalanmıştır:
  // paragrafın tamamı olan eşleşme, aynı sözcüğü içeren gövde cümlelerinin önüne geçer.
  const loose = run(findPattern(stripped));
  const whole = loose.filter((m) => m.whole);
  return whole.length > 0 ? whole : loose;
}

// ─── Tablo satırları ───────────────────────────────────────────────────────────────────────────

interface RowMatch {
  part: Part;
  tr: XmlNode;
  /** Satırın doğrudan kabı (genelde w:tbl). */
  parent: XmlNode;
  preview: string;
  whole: boolean;
}

const ROW_WRAPPERS = new Set(["w:sdt", "w:sdtContent", "w:customXml"]);

/** Satırın hücreleri; içerik denetimi (sdt) sarmalayıcılarının içi de sayılır. */
function cellsOf(tr: XmlNode, out: XmlNode[] = []): XmlNode[] {
  for (const c of elements(tr)) {
    if (c.name === "w:tc") out.push(c);
    else if (ROW_WRAPPERS.has(c.name)) cellsOf(c, out);
  }
  return out;
}

const spanOf = (tc: XmlNode) =>
  Math.max(1, Number(child(child(tc, "w:tcPr"), "w:gridSpan")?.attrs["w:val"] ?? 1) || 1);

const gridWidth = (tr: XmlNode) => cellsOf(tr).reduce((sum, tc) => sum + spanOf(tc), 0);

/** Satır kabındaki satırlar (sdt sarmalı satırlar dahil değil; onlara dokunulmaz). */
const rowsOf = (container: XmlNode) => elements(container).filter((c) => c.name === "w:tr");

/**
 * Satırın okuma görünümü: `docx.ts` tablosuyla aynı biçim (birleşik hücre boş sütunla, kısa satır
 * tablonun en geniş satırına kadar doldurulur; paragraflar `<br>`, `|` kaçışlı) ki model okuduğu
 * satırı olduğu gibi verebilsin.
 */
function rowText(tr: XmlNode, width: number): string {
  const cells: string[] = [];
  for (const tc of cellsOf(tr)) {
    cells.push(cellText(tc));
    for (let i = 1; i < spanOf(tc); i++) cells.push("");
  }
  while (cells.length < width) cells.push("");
  return `| ${cells.join(" | ")} |`;
}

/** Hücrenin okuma görünümü (`docx.ts` ile aynı: paragraflar `<br>`, `|` kaçışlı). */
function cellText(tc: XmlNode): string {
  return paragraphsOf(tc)
    .map(({ p }) => paragraphText(unitsOf(p)).replace(new RegExp(OPAQUE, "g"), "").trim())
    .filter(Boolean)
    .join("<br>")
    .replace(/\|/g, "\\|");
}

// ─── Tablo ızgarası: sütunlar ve birleştirme ──────────────────────────────────────────────────

/** Hücre özelliklerinin şema sırası (CT_TcPr). */
const TCPR_ORDER = [
  "w:cnfStyle",
  "w:tcW",
  "w:gridSpan",
  "w:hMerge",
  "w:vMerge",
  "w:tcBorders",
  "w:shd",
  "w:noWrap",
  "w:tcMar",
  "w:textDirection",
  "w:tcFitText",
  "w:vAlign",
  "w:hideMark",
  "w:headers",
  "w:cellIns",
  "w:cellDel",
  "w:cellMerge",
  "w:tcPrChange",
];

interface GridCell {
  tc: XmlNode;
  /** Izgaradaki ilk sütun (satırın `gridBefore` boşluğu dahil). */
  start: number;
  span: number;
}

function gridCells(tr: XmlNode): GridCell[] {
  let col = Number(child(child(tr, "w:trPr"), "w:gridBefore")?.attrs["w:val"] ?? 0) || 0;
  return cellsOf(tr).map((tc) => {
    const cell = { tc, start: col, span: spanOf(tc) };
    col += cell.span;
    return cell;
  });
}

/** Satır özelliklerinin şema sırası (CT_TrPr). */
const TRPR_ORDER = [
  "w:cnfStyle",
  "w:divId",
  "w:gridBefore",
  "w:gridAfter",
  "w:wBefore",
  "w:wAfter",
  "w:cantSplit",
  "w:trHeight",
  "w:tblHeader",
  "w:tblCellSpacing",
  "w:jc",
  "w:hidden",
  "w:ins",
  "w:del",
  "w:trPrChange",
];

/** Satırın başındaki/sonundaki boş ızgara aralığı (`gridBefore`/`gridAfter`). */
const rowGap = (tr: XmlNode, name: "w:gridBefore" | "w:gridAfter") =>
  Number(child(child(tr, "w:trPr"), name)?.attrs["w:val"] ?? 0) || 0;

function setRowGap(tr: XmlNode, name: "w:gridBefore" | "w:gridAfter", value: number) {
  const trPr = ensureTrPr(tr);
  if (value <= 0) trPr.children = trPr.children.filter((c) => !isElement(c) || c.name !== name);
  else putInOrder(trPr, el(name, { "w:val": String(value) }), TRPR_ORDER);
}

/** Satırın hücreli aralığı: [ilk hücre, son hücre sonu). */
function rowSpan(tr: XmlNode, cells: GridCell[]): { from: number; to: number } {
  const from = rowGap(tr, "w:gridBefore");
  const last = cells.at(-1);
  return { from, to: last ? last.start + last.span : from };
}

const covering = (cells: GridCell[], col: number) =>
  cells.find((c) => c.start <= col && col < c.start + c.span);

function ensureTcPr(tc: XmlNode): XmlNode {
  const existing = child(tc, "w:tcPr");
  if (existing) return existing;
  const tcPr = el("w:tcPr");
  tc.children.unshift(tcPr);
  return tcPr;
}

function setSpan(tc: XmlNode, span: number) {
  const tcPr = ensureTcPr(tc);
  if (span <= 1) {
    tcPr.children = tcPr.children.filter((c) => !isElement(c) || c.name !== "w:gridSpan");
  } else {
    putInOrder(tcPr, el("w:gridSpan", { "w:val": String(span) }), TCPR_ORDER);
  }
}

/**
 * Yatay çizgiler satır boyunca uzar: sütun kalıbından gelen hücrenin üst/alt kenarlığı aynı
 * satırdaki hücreninkiyle değişir (kalıp başka satırdan geldiği için çizgisi farklı olabilir).
 */
function rowBorders(cell: XmlNode, sameRow: XmlNode) {
  const HORIZONTAL = ["w:top", "w:bottom"];
  const source = elements(child(child(sameRow, "w:tcPr"), "w:tcBorders") ?? el("w:x")).filter((c) =>
    HORIZONTAL.includes(c.name),
  );
  const tcPr = ensureTcPr(cell);
  let borders = child(tcPr, "w:tcBorders");
  if (!borders && source.length === 0) return;
  if (!borders) {
    borders = el("w:tcBorders");
    putInOrder(tcPr, borders, TCPR_ORDER);
  }
  // Şema sırası: top, start/left, bottom, end/right, insideH, insideV, tl2br, tr2bl.
  const ORDER = [
    "w:top",
    "w:start",
    "w:left",
    "w:bottom",
    "w:end",
    "w:right",
    "w:insideH",
    "w:insideV",
  ];
  borders.children = borders.children.filter((c) => !isElement(c) || !HORIZONTAL.includes(c.name));
  for (const b of source) putInOrder(borders, cloneNode(b), ORDER);
  if (borders.children.length === 0) removeChild(tcPr, borders);
}

/** Hücrenin paragraflarına örnek hücrenin (ilk paragrafının) yatay hizalamasını verir. */
function alignLike(cell: XmlNode, example: XmlNode) {
  const jc = child(child(paragraphsOf(example)[0]?.p, "w:pPr"), "w:jc");
  for (const { p } of paragraphsOf(cell)) {
    let pPr = child(p, "w:pPr");
    if (!pPr && !jc) continue;
    if (!pPr) {
      pPr = el("w:pPr");
      p.children.unshift(pPr);
    }
    if (jc) putInOrder(pPr, cloneNode(jc), PPR_ORDER);
    else pPr.children = pPr.children.filter((c) => !isElement(c) || c.name !== "w:jc");
  }
}

/** Dikey birleşmenin devam hücresi mi (`vMerge` değersiz ya da "continue"). */
function continuesMerge(tc: XmlNode): boolean {
  const merge = child(child(tc, "w:tcPr"), "w:vMerge");
  return merge !== undefined && merge.attrs["w:val"] !== "restart";
}

const gridWidths = (tbl: XmlNode) =>
  elements(child(tbl, "w:tblGrid") ?? el("w:tblGrid"))
    .filter((c) => c.name === "w:gridCol")
    .map((c) => Number(c.attrs["w:w"] ?? 0) || 0);

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Genişlikleri toplam korunacak biçimde ölçekler (yuvarlama farkı son sütuna). */
function scaleTo(widths: number[], total: number): number[] {
  const current = sum(widths);
  if (total <= 0 || current <= 0 || widths.some((w) => w <= 0)) return widths;
  const scaled = widths.map((w) => Math.max(1, Math.round((w * total) / current)));
  const last = scaled.length - 1;
  scaled[last] = (scaled[last] ?? 0) + total - sum(scaled);
  return scaled;
}

/** Izgarayı yeniden yazar ve DXA hücre genişliklerini (tcW) kapsadıkları sütunlara eşitler. */
function applyWidths(tbl: XmlNode, widths: readonly number[]) {
  const grid = child(tbl, "w:tblGrid");
  if (!grid) return;
  grid.children = widths.map((w) => el("w:gridCol", { "w:w": String(w) }));
  if (widths.every((w) => w <= 0)) return;
  for (const tr of rowsOf(tbl)) {
    for (const cell of gridCells(tr)) {
      const tcW = child(child(cell.tc, "w:tcPr"), "w:tcW");
      const type = tcW?.attrs["w:type"] ?? "dxa";
      if (!tcW || type !== "dxa") continue;
      tcW.attrs["w:w"] = String(sum(widths.slice(cell.start, cell.start + cell.span)));
      tcW.attrs["w:type"] = "dxa";
    }
  }
}

/** Düğümün altındaki yorum göndermelerinin kimlikleri. */
function collectCommentRefs(node: XmlNode, out: Set<string>) {
  for (const c of elements(node)) {
    const id = c.attrs["w:id"];
    if (c.name === "w:commentReference" && id) out.add(id);
    collectCommentRefs(c, out);
  }
}

function collectCommentStarts(node: XmlNode, out: Set<XmlNode>) {
  for (const c of elements(node)) {
    if (c.name === "w:commentRangeStart") out.add(c);
    collectCommentStarts(c, out);
  }
}

function findCommentStart(
  node: XmlNode,
  id: string,
): { node: XmlNode; parent: XmlNode } | undefined {
  for (const c of elements(node)) {
    if (c.name === "w:commentRangeStart" && c.attrs["w:id"] === id)
      return { node: c, parent: node };
    const found = findCommentStart(c, id);
    if (found) return found;
  }
  return undefined;
}

function parentOf(node: XmlNode, target: XmlNode): XmlNode | undefined {
  if (node.children.includes(target)) return node;
  for (const c of elements(node)) {
    const found = parentOf(c, target);
    if (found) return found;
  }
  return undefined;
}

function removeDeep(node: XmlNode, target: XmlNode): boolean {
  const at = node.children.indexOf(target);
  if (at >= 0) {
    node.children.splice(at, 1);
    return true;
  }
  return elements(node).some((c) => removeDeep(c, target));
}

/**
 * Hücreleri kaldırır; bütün satırlarda yalnız kaldırılan hücrelerin kapladığı sütunlar ızgaradan
 * da düşer ve kalan sütunlar tablonun genişliğini koruyacak biçimde genişler. Hücresi kalmayan
 * satır da kalkar (Word hücresiz satır kabul etmez).
 */
function removeCells(tbl: XmlNode, doomed: ReadonlySet<XmlNode>) {
  const widths = gridWidths(tbl);
  const rows = rowsOf(tbl).map((tr) => ({ tr, cells: gridCells(tr) }));
  const removable = new Set<number>();
  for (let col = 0; col < widths.length; col++) {
    const hits = rows.map((r) => covering(r.cells, col)).filter((c) => c !== undefined);
    if (hits.length > 0 && hits.every((c) => doomed.has(c.tc))) removable.add(col);
  }
  for (const { tr, cells } of rows) {
    // Düşen sütun bu satırın boş baş/son aralığındaysa aralık da daralır.
    const { from, to } = rowSpan(tr, cells);
    const after = rowGap(tr, "w:gridAfter");
    const inBefore = [...removable].filter((c) => c < from).length;
    const inAfter = [...removable].filter((c) => c >= to && c < to + after).length;
    for (const cell of cells) if (doomed.has(cell.tc)) removeDeep(tr, cell.tc);
    if (inBefore > 0) setRowGap(tr, "w:gridBefore", from - inBefore);
    if (inAfter > 0) setRowGap(tr, "w:gridAfter", after - inAfter);
    if (cellsOf(tr).length === 0) removeChild(tbl, tr);
  }
  if (removable.size > 0) {
    const kept = widths.filter((_, i) => !removable.has(i));
    applyWidths(tbl, scaleTo(kept, sum(widths)));
  }
}

interface CellMatch {
  part: Part;
  tr: XmlNode;
  /** Satırın kabı; sütun ve birleştirme işlemleri yalnız doğrudan `w:tbl` altında çalışır. */
  parent: XmlNode;
  row: number;
  cell: GridCell;
  preview: string;
  whole: boolean;
}

function findCells(find: string, parts: Part[]): CellMatch[] {
  const run = (pattern: RegExp) => {
    const matches: CellMatch[] = [];
    for (const part of parts) {
      const rows: { tr: XmlNode; parent: XmlNode }[] = [];
      collectRows(part.root, part, rows);
      for (const { tr, parent } of rows) {
        for (const cell of gridCells(tr)) {
          const text = cellText(cell.tc);
          const hit = [...text.matchAll(pattern)].find((m) => m[0].length > 0);
          if (!hit) continue;
          matches.push({
            part,
            tr,
            parent,
            row: rowsOf(parent).indexOf(tr),
            cell,
            preview: text.slice(0, 80),
            whole: text.trim() === hit[0].trim(),
          });
        }
      }
    }
    // İç içe tabloda dış hücre de eşleşir; en içteki hücre kastedilmiştir.
    return matches.filter((m) => !matches.some((x) => x !== m && contains(m.cell.tc, x.cell.tc)));
  };
  const prefer = (matches: CellMatch[]) => {
    const whole = matches.filter((m) => m.whole);
    return whole.length > 0 ? whole : matches;
  };
  const trimmed = find.trim().replace(/^\|\s*|\s*\|$/g, "");
  const exact = run(findPattern(trimmed));
  if (exact.length > 0) return prefer(exact);
  const stripped = stripMarkup(trimmed).trim();
  return stripped && stripped !== trimmed ? prefer(run(findPattern(stripped))) : exact;
}

/** Sütun değerleri yukarıdan aşağı: `| a | b |` ya da satır başına bir değer. */
function parseColumn(text: string): string[] {
  if (/(?<!\\)\|/.test(text)) return parseRows(text).flat();
  return text.split("\n").map((line) => line.trim());
}

/** Blok boş mu: metinsiz, görselsiz paragraf. Birleştirmede boş bloklar taşınmaz. */
function emptyBlock(node: XmlNode): boolean {
  return node.name === "w:p" && paragraphText(unitsOf(node)).trim() === "";
}

function collectRows(node: XmlNode, part: Part, out: { tr: XmlNode; parent: XmlNode }[]) {
  for (const c of elements(node)) {
    if (c.name === "mc:Fallback") continue;
    if (c.name === "w:tr") out.push({ tr: c, parent: node });
    collectRows(c, part, out);
  }
}

function contains(node: XmlNode, target: XmlNode): boolean {
  return elements(node).some((c) => c === target || contains(c, target));
}

function findRows(find: string, parts: Part[]): RowMatch[] {
  const run = (pattern: RegExp) => {
    const matches: RowMatch[] = [];
    for (const part of parts) {
      const rows: { tr: XmlNode; parent: XmlNode }[] = [];
      collectRows(part.root, part, rows);
      const widths = new Map<XmlNode, number>();
      for (const { parent } of rows) {
        if (!widths.has(parent)) {
          widths.set(parent, Math.max(0, ...rowsOf(parent).map((r) => gridWidth(r))));
        }
      }
      for (const { tr, parent } of rows) {
        const text = rowText(tr, widths.get(parent) ?? 0);
        const hit = [...text.matchAll(pattern)].find((m) => m[0].length > 0);
        if (!hit) continue;
        const inner = text.replace(/^\|\s*|\s*\|$/g, "");
        const whole = [text, inner].some((t) => t.trim() === hit[0].trim());
        matches.push({ part, tr, parent, preview: text.slice(0, 80), whole });
      }
    }
    // İç içe tabloda dış satır da eşleşir; en içteki satır kastedilmiştir.
    return matches.filter((m) => !matches.some((x) => x !== m && contains(m.tr, x.tr)));
  };
  const prefer = (matches: RowMatch[]) => {
    const whole = matches.filter((m) => m.whole);
    return whole.length > 0 ? whole : matches;
  };
  const exact = run(findPattern(find.trim()));
  if (exact.length > 0) return prefer(exact);
  const stripped = stripMarkup(find).trim();
  return stripped && stripped !== find.trim() ? prefer(run(findPattern(stripped))) : exact;
}

/** `| a | b |` satırlarını hücre değerlerine böler; ayraç satırı (`|---|`) atlanır. */
function parseRows(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line))
    .map((line) => {
      let body = line;
      if (body.startsWith("|")) body = body.slice(1);
      if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
      return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    });
}

/**
 * Yeni satırın kalıbı: çapa satırı; ama başlık satırının altına eklenen satır başlık biçimini
 * (kalın, gölge, "başlık satırı" tekrarı) almasın diye varsa ikinci satır örnek alınır.
 */
function rowTemplate(m: RowMatch, before: boolean): XmlNode {
  const rows = rowsOf(m.parent);
  const header = rows[0] === m.tr || isHeaderRow(m.tr);
  if (before || !header) return m.tr;
  return rows.find((r) => r !== m.tr && !isHeaderRow(r)) ?? m.tr;
}

/** `w:tblHeader` açık mı: Word gövde satırlarına da `w:val="false"` ile yazabilir. */
function isHeaderRow(tr: XmlNode): boolean {
  const flag = child(child(tr, "w:trPr"), "w:tblHeader");
  return flag !== undefined && !["false", "0", "off"].includes(flag.attrs["w:val"] ?? "true");
}

/** Satırın `w:trPr`'si; yoksa `w:tblPrEx`'ten sonra, hücrelerden önce açılır. */
function ensureTrPr(tr: XmlNode): XmlNode {
  const existing = child(tr, "w:trPr");
  if (existing) return existing;
  const trPr = el("w:trPr");
  const ex = tr.children.findIndex((c) => isElement(c) && c.name === "w:tblPrEx");
  tr.children.splice(ex + 1, 0, trPr);
  return trPr;
}

/** Satır izli işareti: şemada trPr'nin sonunda, `w:trPrChange`'ten önce durur. */
function markRow(tr: XmlNode, mark: XmlNode) {
  const trPr = ensureTrPr(tr);
  const at = trPr.children.findIndex((c) => isElement(c) && c.name === "w:trPrChange");
  if (at >= 0) trPr.children.splice(at, 0, mark);
  else trPr.children.push(mark);
}

/**
 * Silinecek satırda dikey birleşme başlıyorsa (`vMerge="restart"`) başlangıç alttaki satıra geçer;
 * yoksa alttaki devam hücreleri başsız kalır ve Word birleşmeyi bozuk çizer.
 */
function promoteMerges(container: XmlNode, tr: XmlNode) {
  const rows = rowsOf(container);
  const next = rows[rows.indexOf(tr) + 1];
  if (!next) return;
  const starts = new Map<number, XmlNode>();
  let col = 0;
  for (const tc of cellsOf(next)) {
    starts.set(col, tc);
    col += spanOf(tc);
  }
  col = 0;
  for (const tc of cellsOf(tr)) {
    const merge = child(child(tc, "w:tcPr"), "w:vMerge");
    const below = child(child(starts.get(col), "w:tcPr"), "w:vMerge");
    if (merge?.attrs["w:val"] === "restart" && below && below.attrs["w:val"] !== "restart") {
      below.attrs["w:val"] = "restart";
    }
    col += spanOf(tc);
  }
}

/** `offset` bir run'ın içine düşüyorsa run'ı orada ikiye böler (yalnız w:t bölünebilir). */
function splitAt(p: XmlNode, offset: number) {
  let pos = 0;
  for (const u of unitsOf(p)) {
    const end = pos + u.text.length;
    if (offset > pos && offset < end) {
      const k = offset - pos;
      const make = (text: string) => {
        const copy = cloneNode(u.run);
        const t = elements(copy).find((x) => x.name === "w:t");
        if (t) {
          t.children = [text];
          t.attrs["xml:space"] = "preserve";
        }
        return copy;
      };
      replaceChild(u.parent, u.run, make(u.text.slice(0, k)), make(u.text.slice(k)));
      return;
    }
    pos = end;
  }
}

/** Eşleşme aralığını tam kaplayan birimler; sınırlar önce bölünür. */
function isolate(p: XmlNode, start: number, end: number): Unit[] {
  splitAt(p, start);
  splitAt(p, end);
  let pos = 0;
  const out: Unit[] = [];
  for (const u of unitsOf(p)) {
    const s = pos;
    pos += u.text.length;
    if (s >= start && pos <= end && u.text.length > 0) out.push(u);
  }
  return out;
}

// ─── Run ve paragraf üretimi ───────────────────────────────────────────────────────────────────

/** Metni run içeriğine çevirir: sekme ve satır sonu ayrı öğedir (`\n` w:t içinde yazılmaz). */
function textContent(text: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === "\t") out.push(el("w:tab"));
    else if (piece === "\n") out.push(el("w:br"));
    else if (piece) out.push(el("w:t", { "xml:space": "preserve" }, [piece]));
  }
  return out;
}

function makeRun(rPr: XmlNode | undefined, text: string, deleted = false): XmlNode {
  const content = textContent(text).map((c) =>
    deleted && c.name === "w:t" ? { ...c, name: "w:delText" } : c,
  );
  return el("w:r", {}, [...(rPr ? [cloneNode(rPr)] : []), ...content]);
}

/** Run biçiminden izli değişiklik kayıtlarını atar: yeni metin eski düzeltmeyi taşımasın. */
function cleanRPr(rPr: XmlNode | undefined): XmlNode | undefined {
  if (!rPr) return undefined;
  const copy = cloneNode(rPr);
  copy.children = copy.children.filter(
    (c) => !isElement(c) || !["w:rPrChange", "w:ins", "w:del"].includes(c.name),
  );
  return copy;
}

/** Satır içi Markdown (kalın/italik/üstü çizili) → temel biçim üstüne eklenmiş run'lar. */
function formattedRuns(text: string, base: XmlNode | undefined): XmlNode[] {
  return parseInline(text).map((seg) => {
    if (seg.lineBreak) return el("w:r", {}, [el("w:br")]);
    let rPr = base ? cloneNode(base) : undefined;
    const set = (name: string) => {
      rPr ??= el("w:rPr");
      putInOrder(rPr, el(name), RPR_ORDER);
    };
    if (seg.bold) set("w:b");
    if (seg.italic) set("w:i");
    if (seg.strike) set("w:strike");
    return makeRun(rPr, seg.text);
  });
}

// ─── Düzenleme ─────────────────────────────────────────────────────────────────────────────────

interface MergeRange {
  part: Part;
  tbl: XmlNode;
  start: number;
  end: number;
  rowNodes: XmlNode[];
  /** Satır başına aralıktaki hücreler (soldan sağa). */
  rows: GridCell[][];
}

/**
 * Birleştirme aralığı: iki hücrenin kapsadığı dikdörtgen. Aralık bir hücreyi ortasından bölüyorsa
 * ya da dışarıdan gelen dikey birleşmeye değiyorsa `undefined` (Word bozuk tablo çizer).
 */
function mergeRange(a: CellMatch, b: CellMatch): MergeRange | undefined {
  const tbl = a.parent;
  const start = Math.min(a.cell.start, b.cell.start);
  const end = Math.max(a.cell.start + a.cell.span, b.cell.start + b.cell.span);
  const all = rowsOf(tbl);
  const rowNodes = all.slice(Math.min(a.row, b.row), Math.max(a.row, b.row) + 1);
  const rows: GridCell[][] = [];
  for (const tr of rowNodes) {
    const cells = gridCells(tr);
    if (cells.some((c) => c.start < start && start < c.start + c.span)) return undefined;
    if (cells.some((c) => c.start < end && end < c.start + c.span)) return undefined;
    const inside = cells.filter((c) => c.start >= start && c.start + c.span <= end);
    if (sum(inside.map((c) => c.span)) !== end - start) return undefined;
    rows.push(inside);
  }
  if (rows[0]?.some((c) => continuesMerge(c.tc))) return undefined;
  const below = all[all.indexOf(rowNodes.at(-1) ?? tbl) + 1];
  if (
    below &&
    gridCells(below).some((c) => c.start >= start && c.start < end && continuesMerge(c.tc))
  )
    return undefined;
  return { part: a.part, tbl, start, end, rowNodes, rows };
}

// ─── Tablo ekleme ve silme ─────────────────────────────────────────────────────────────────────

/** Tablo özelliklerinin şema sırası (CT_TblPr). */
const TBLPR_ORDER = [
  "w:tblStyle",
  "w:tblpPr",
  "w:tblOverlap",
  "w:bidiVisual",
  "w:tblStyleRowBandSize",
  "w:tblStyleColBandSize",
  "w:tblW",
  "w:jc",
  "w:tblCellSpacing",
  "w:tblInd",
  "w:tblBorders",
  "w:shd",
  "w:tblLayout",
  "w:tblCellMar",
  "w:tblLook",
  "w:tblCaption",
  "w:tblDescription",
  "w:tblPrChange",
];

/** Paragraf özelliklerinin şema sırası (CT_PPr); hizalama (`w:jc`) doğru yere girsin diye. */
const PPR_ORDER = [
  "w:pStyle",
  "w:keepNext",
  "w:keepLines",
  "w:pageBreakBefore",
  "w:framePr",
  "w:widowControl",
  "w:numPr",
  "w:suppressLineNumbers",
  "w:pBdr",
  "w:shd",
  "w:tabs",
  "w:suppressAutoHyphens",
  "w:kinsoku",
  "w:wordWrap",
  "w:overflowPunct",
  "w:topLinePunct",
  "w:autoSpaceDE",
  "w:autoSpaceDN",
  "w:bidi",
  "w:adjustRightInd",
  "w:snapToGrid",
  "w:spacing",
  "w:ind",
  "w:contextualSpacing",
  "w:mirrorIndents",
  "w:suppressOverlap",
  "w:jc",
  "w:textDirection",
  "w:textAlignment",
  "w:textboxTightWrap",
  "w:outlineLvl",
  "w:divId",
  "w:cnfStyle",
  "w:rPr",
  "w:sectPr",
  "w:pPrChange",
];

const BLOCKS = new Set(["w:p", "w:tbl", "w:sdt", "w:customXml"]);

const blocksOf = (list: XmlNode["children"]) =>
  list.filter((c): c is XmlNode => isElement(c) && BLOCKS.has(c.name));

/** A4, 2 cm kenar boşluğunda yazı alanı (`docx_create` ile aynı). */
const DEFAULT_TEXT_WIDTH = 9638;

type ColumnAlign = "left" | "center" | "right" | undefined;

interface TableSpec {
  header: string[];
  align: ColumnAlign[];
  rows: string[][];
}

interface TableAnchor {
  part: Part;
  /** Yeni tablonun yanına gireceği blok: paragraf ya da (hücre metni verildiyse) tablo. */
  node: XmlNode;
  container: XmlNode;
  preview: string;
}

/** `text`'teki Markdown tablosu; ayraç satırı yoksa ilk satır başlık sayılır. */
function parseTable(text: string): TableSpec | undefined {
  const block = parseMarkdown(text).find((b) => b.kind === "table");
  if (block?.kind === "table")
    return { header: block.header, align: block.align, rows: block.rows };
  const [header, ...rows] = parseRows(text);
  return header ? { header, align: [], rows } : undefined;
}

/** Hedefi içeren en içteki tablo ve o tablonun kabı. */
function enclosingTable(
  root: XmlNode,
  target: XmlNode,
): { tbl: XmlNode; container: XmlNode } | undefined {
  const path: XmlNode[] = [];
  const walk = (node: XmlNode): boolean => {
    path.push(node);
    for (const c of elements(node)) if (c === target || walk(c)) return true;
    path.pop();
    return false;
  };
  if (!walk(root)) return undefined;
  for (let i = path.length - 1; i > 0; i--) {
    const tbl = path[i];
    const container = path[i - 1];
    if (tbl?.name === "w:tbl" && container) return { tbl, container };
  }
  return undefined;
}

const hasNestedTable = (node: XmlNode): boolean =>
  elements(node).some((c) => c.name === "w:tbl" || hasNestedTable(c));

/**
 * Tabloyu kabından kaldırır. İki tablo yan yana kalırsa (Word onları tek tablo gibi birleştirir)
 * ya da kapta hiç blok kalmazsa araya boş paragraf girer.
 */
function removeTable(container: XmlNode, tbl: XmlNode) {
  const at = container.children.indexOf(tbl);
  if (at < 0) return;
  container.children.splice(at, 1);
  const prev = blocksOf(container.children.slice(0, at)).at(-1);
  const next = blocksOf(container.children.slice(at))[0];
  if ((!prev && !next) || (prev?.name === "w:tbl" && next?.name === "w:tbl")) {
    container.children.splice(at, 0, el("w:p"));
  }
}

/** Satırı kalmamış tablo (izli silinen tablonun kabulü, izli eklenenin reddi) kaldırılır. */
function dropEmptyTables(container: XmlNode) {
  for (const tbl of elements(container).filter((c) => c.name === "w:tbl")) {
    if (!elements(tbl).some((c) => c.name === "w:tr" || ROW_WRAPPERS.has(c.name))) {
      removeTable(container, tbl);
    }
  }
}

/** Yeni tablonun genişliği: hücre içindeyse hücrenin, değilse belgenin son bölümünün yazı alanı. */
function availableWidth(documentRoot: XmlNode | undefined, container: XmlNode): number {
  if (container.name === "w:tc") {
    const tcW = child(child(container, "w:tcPr"), "w:tcW");
    const width = Number(tcW?.attrs["w:w"] ?? 0);
    // Hücre iç boşluğu (varsayılan 108 twip her yanda) düşülür.
    if (tcW?.attrs["w:type"] === "dxa" && width > 936) return width - 216;
  }
  const body = child(child(documentRoot, "w:document"), "w:body");
  const sectPr = child(body, "w:sectPr");
  const margin = child(sectPr, "w:pgMar");
  const text =
    Number(child(sectPr, "w:pgSz")?.attrs["w:w"] ?? 0) -
    Number(margin?.attrs["w:left"] ?? margin?.attrs["w:start"] ?? 0) -
    Number(margin?.attrs["w:right"] ?? margin?.attrs["w:end"] ?? 0);
  return Number.isFinite(text) && text > 720 ? text : DEFAULT_TEXT_WIDTH;
}

/** Belgede örnek alınacak tablo yoksa `docx_create` tablosunun görünümü (ince gri çizgi, gri başlık). */
function defaultTableTemplate(): XmlNode {
  const line = (name: string) =>
    el(name, { "w:val": "single", "w:sz": "4", "w:space": "0", "w:color": "BFBFBF" });
  const margin = (name: string, w: number) => el(name, { "w:w": String(w), "w:type": "dxa" });
  const cell = (header: boolean) =>
    el("w:tc", {}, [
      el("w:tcPr", {}, [
        el("w:tcW", { "w:w": "0", "w:type": "dxa" }),
        ...(header
          ? [el("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": "F2F2F2" })]
          : []),
        el("w:tcMar", {}, [
          margin("w:top", 60),
          margin("w:left", 100),
          margin("w:bottom", 60),
          margin("w:right", 100),
        ]),
      ]),
      el("w:p", {}, [
        el("w:pPr", {}, [el("w:spacing", { "w:before": "0", "w:after": "0" })]),
        el("w:r", {}, [...(header ? [el("w:rPr", {}, [el("w:b")])] : []), el("w:t", {}, ["-"])]),
      ]),
    ]);
  return el("w:tbl", {}, [
    el("w:tblPr", {}, [
      el("w:tblW", { "w:w": "0", "w:type": "dxa" }),
      el(
        "w:tblBorders",
        {},
        ["w:top", "w:left", "w:bottom", "w:right", "w:insideH", "w:insideV"].map(line),
      ),
    ]),
    el("w:tblGrid"),
    el("w:tr", {}, [el("w:trPr", {}, [el("w:tblHeader")]), cell(true)]),
    el("w:tr", {}, [cell(false)]),
  ]);
}

class Editor {
  readonly pkg: DocxPackage;
  readonly options: DocxEditOptions;
  #nextId: number;
  /** Yorum eşlerinin paragraf ve kalıcı kimlikleri için sayaç (bkz. `#copyComments`). */
  #hexId = 0x1c0d0001;
  readonly #headingStyles = new Map<number, string>();

  constructor(pkg: DocxPackage, options: DocxEditOptions) {
    this.pkg = pkg;
    this.options = options;
    // Kimlikler (izli değişiklik, yorum) belgede tekil olmalı; var olanların en büyüğünden başlar.
    let max = 0;
    const scan = (node: XmlNode) => {
      const id = Number(node.attrs["w:id"]);
      if (Number.isInteger(id) && id > max) max = id;
      for (const c of elements(node)) scan(c);
    };
    for (const part of [...pkg.parts, pkg.load(this.commentsPartName() ?? "")]) {
      if (part) scan(part.root);
    }
    this.#nextId = max + 1;
    const styles = pkg.load("word/styles.xml");
    for (const s of styles ? elements(child(styles.root, "w:styles") ?? styles.root) : []) {
      const named = /^heading\s*(\d)$/i.exec(child(s, "w:name")?.attrs["w:val"] ?? "");
      if (s.name === "w:style" && named && s.attrs["w:styleId"]) {
        this.#headingStyles.set(Number(named[1]), s.attrs["w:styleId"]);
      }
    }
  }

  #revision(
    name: "w:ins" | "w:del" | "w:cellIns" | "w:cellDel",
    children: XmlNode[] = [],
  ): XmlNode {
    return el(
      name,
      {
        "w:id": String(this.#nextId++),
        "w:author": this.options.author,
        "w:date": this.options.date,
      },
      children,
    );
  }

  /** Birimi izli silmeye çevirir; başkasının izli eklemesi ise doğrudan kaldırır. */
  #trackDelete(u: Unit) {
    if (u.inserted) {
      removeChild(u.parent, u.run);
      return;
    }
    for (const c of elements(u.run)) {
      if (c.name === "w:t") c.name = "w:delText";
      else if (c.name === "w:instrText") c.name = "w:delInstrText";
    }
    replaceChild(u.parent, u.run, this.#revision("w:del", [u.run]));
  }

  replace(m: Match, text: string) {
    const units = isolate(m.p, m.start, m.end);
    const first = units[0];
    const last = units[units.length - 1];
    if (!first || !last) return;
    const rPr = cleanRPr(child(first.run, "w:rPr"));
    if (text) {
      // Yeni metindeki satır içi Markdown (kalın/italik) eklemedeki gibi biçime çevrilir.
      const runs = formattedRuns(text, rPr);
      // Başkasının izli eklemesinin içine iç içe w:ins konmaz; metin o eklemenin parçası olur.
      const wrapped = this.options.track && !last.inserted ? [this.#revision("w:ins", runs)] : runs;
      insertAfter(last.parent, last.run, ...wrapped);
    }
    for (const u of units) {
      if (this.options.track) this.#trackDelete(u);
      else removeChild(u.parent, u.run);
    }
    m.part.dirty = true;
  }

  comment(m: Match, text: string) {
    const units = isolate(m.p, m.start, m.end);
    const first = units[0];
    const last = units[units.length - 1];
    if (!first || !last) return;
    const id = String(this.#nextId++);
    const at = first.parent.children.indexOf(first.run);
    first.parent.children.splice(at, 0, el("w:commentRangeStart", { "w:id": id }));
    insertAfter(
      last.parent,
      last.run,
      el("w:commentRangeEnd", { "w:id": id }),
      el("w:r", {}, [el("w:commentReference", { "w:id": id })]),
    );
    const initials = this.options.author
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 3);
    this.#commentsRoot().children.push(
      el(
        "w:comment",
        {
          "w:id": id,
          "w:author": this.options.author,
          "w:date": this.options.date,
          "w:initials": initials || "C",
        },
        [
          el("w:p", {}, [
            el("w:r", {}, [el("w:annotationRef")]),
            ...text
              .split("\n")
              .flatMap((line, i) => [
                ...(i > 0 ? [el("w:r", {}, [el("w:br")])] : []),
                makeRun(undefined, line),
              ]),
          ]),
        ],
      ),
    );
    m.part.dirty = true;
  }

  commentsPartName(): string | undefined {
    return this.pkg.relTargets("comments")[0];
  }

  /** Yorum parçası yoksa oluşturulur: parça + ilişki + içerik türü. */
  #commentsRoot(): XmlNode {
    const existing = this.commentsPartName();
    const part = existing ? this.pkg.load(existing) : undefined;
    if (part) {
      part.dirty = true;
      return child(part.root, "w:comments") ?? part.root;
    }
    const name = "word/comments.xml";
    const comments = el("w:comments", { "xmlns:w": NS_W, "xmlns:r": NS_R });
    this.pkg.create(name, {
      name: "#root",
      attrs: {},
      children: [{ raw: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' }, comments],
    });
    const rels = this.pkg.rels();
    const relRoot = rels ? child(rels.root, "Relationships") : undefined;
    if (!rels || !relRoot) throw new OoxmlError("notZip");
    const ids = elements(relRoot).map((r) => Number(/^rId(\d+)$/.exec(r.attrs.Id ?? "")?.[1] ?? 0));
    relRoot.children.push(
      el("Relationship", {
        Id: `rId${Math.max(0, ...ids) + 1}`,
        Type: REL_COMMENTS,
        Target: "comments.xml",
      }),
    );
    rels.dirty = true;
    const types = this.pkg.load("[Content_Types].xml");
    const typesRoot = types ? child(types.root, "Types") : undefined;
    if (types && typesRoot) {
      typesRoot.children.push(el("Override", { PartName: `/${name}`, ContentType: CT_COMMENTS }));
      types.dirty = true;
    }
    return comments;
  }

  /**
   * Yorumların eşini çıkarır (yeni kimlik; yanıt zinciri, çözüldü bilgisi ve kalıcı kimlik
   * kayıtlarıyla); eski → yeni kimlik haritası döner.
   */
  #copyComments(ids: ReadonlySet<string>): Map<string, string> {
    const map = new Map<string, string>();
    const { comments, ext, cid, cex } = this.#commentParts();
    if (!comments || ids.size === 0) return map;
    const { part, root } = comments;
    const used = new Set<string>();
    const scan = (node: XmlNode) => {
      for (const [k, v] of Object.entries(node.attrs)) {
        if (/:(paraId|durableId)$/.test(k)) used.add(v.toUpperCase());
      }
      for (const c of elements(node)) scan(c);
    };
    for (const p of [...this.pkg.parts, part, ext?.part, cid?.part, cex?.part]) {
      if (p) scan(p.root);
    }
    // Word bu kimlikleri 0x80000000'dan küçük onaltılık bekler.
    const fresh = () => {
      while (used.has(this.#hexId.toString(16).toUpperCase().padStart(8, "0"))) this.#hexId++;
      const id = (this.#hexId++).toString(16).toUpperCase().padStart(8, "0");
      used.add(id);
      return id;
    };
    const paras = new Map<string, string>();
    for (const c of elements(root)) {
      const id = c.attrs["w:id"];
      if (c.name !== "w:comment" || !id || !ids.has(id)) continue;
      const copy = cloneNode(c);
      const twin = String(this.#nextId++);
      copy.attrs["w:id"] = twin;
      map.set(id, twin);
      for (const { p } of paragraphsOf(copy)) {
        const old = p.attrs["w14:paraId"];
        if (!old) continue;
        const next = fresh();
        paras.set(old.toUpperCase(), next);
        p.attrs["w14:paraId"] = next;
      }
      root.children.push(copy);
    }
    part.dirty = true;
    const durables = new Map<string, string>();
    const clone = (
      holder: { part: Part; root: XmlNode } | undefined,
      edit: (copy: XmlNode) => boolean,
    ) => {
      for (const c of holder ? elements(holder.root) : []) {
        const copy = cloneNode(c);
        if (!holder || !edit(copy)) continue;
        holder.root.children.push(copy);
        holder.part.dirty = true;
      }
    };
    const mapped = (value: string | undefined, from: Map<string, string>) =>
      value === undefined ? undefined : from.get(value.toUpperCase());
    clone(ext, (copy) => {
      const para = mapped(copy.attrs["w15:paraId"], paras);
      if (!para) return false;
      copy.attrs["w15:paraId"] = para;
      const parent = mapped(copy.attrs["w15:paraIdParent"], paras);
      if (parent) copy.attrs["w15:paraIdParent"] = parent;
      return true;
    });
    clone(cid, (copy) => {
      const para = mapped(copy.attrs["w16cid:paraId"], paras);
      const durable = copy.attrs["w16cid:durableId"];
      if (!para || !durable) return false;
      const next = fresh();
      durables.set(durable.toUpperCase(), next);
      copy.attrs["w16cid:paraId"] = para;
      copy.attrs["w16cid:durableId"] = next;
      return true;
    });
    clone(cex, (copy) => {
      const durable = mapped(copy.attrs["w16cex:durableId"], durables);
      if (!durable) return false;
      copy.attrs["w16cex:durableId"] = durable;
      return true;
    });
    return map;
  }

  /** Yorum parçası ve Word'ün yanıt/çözüldü (`commentsExtended`), kalıcı kimlik parçaları. */
  #commentParts() {
    const load = (type: string, rootName: string) => {
      const target = this.pkg.relTargets(type)[0];
      const part = target ? this.pkg.load(target) : undefined;
      const root = part ? child(part.root, rootName) : undefined;
      return part && root ? { part, root } : undefined;
    };
    return {
      comments: load("comments", "w:comments"),
      ext: load("commentsExtended", "w15:commentsEx"),
      cid: load("commentsIds", "w16cid:commentsIds"),
      cex: load("commentsExtensible", "w16cex:commentsExtensible"),
    };
  }

  /**
   * Göndermesi belgeden düşen yorumları ve kayıtlarını siler. Word de silinen metindeki yorumu
   * kabulle birlikte siler; okuyucu yorum sayısını parçadan aldığı için sahipsiz kalmamalı.
   */
  #dropComments(ids: ReadonlySet<string>) {
    const { comments, ext, cid, cex } = this.#commentParts();
    if (!comments || ids.size === 0) return;
    const paras = new Set<string>();
    comments.root.children = comments.root.children.filter((c) => {
      if (!isElement(c) || c.name !== "w:comment" || !ids.has(c.attrs["w:id"] ?? "")) return true;
      for (const { p } of paragraphsOf(c)) {
        const para = p.attrs["w14:paraId"];
        if (para) paras.add(para.toUpperCase());
      }
      return false;
    });
    comments.part.dirty = true;
    const durables = new Set<string>();
    const prune = (
      holder: { part: Part; root: XmlNode } | undefined,
      gone: (c: XmlNode) => boolean,
    ) => {
      if (!holder) return;
      holder.root.children = holder.root.children.filter((c) => !isElement(c) || !gone(c));
      holder.part.dirty = true;
    };
    const has = (set: Set<string>, value: string | undefined) =>
      value !== undefined && set.has(value.toUpperCase());
    prune(ext, (c) => has(paras, c.attrs["w15:paraId"]));
    prune(cid, (c) => {
      if (!has(paras, c.attrs["w16cid:paraId"])) return false;
      durables.add((c.attrs["w16cid:durableId"] ?? "").toUpperCase());
      return true;
    });
    prune(cex, (c) => has(durables, c.attrs["w16cex:durableId"]));
    // Göndermesiz kalan aralık işaretleri de atılır.
    const strip = (node: XmlNode) => {
      node.children = node.children.filter(
        (c) =>
          !isElement(c) ||
          !(
            (c.name === "w:commentRangeStart" || c.name === "w:commentRangeEnd") &&
            ids.has(c.attrs["w:id"] ?? "")
          ),
      );
      for (const c of elements(node)) strip(c);
    };
    for (const part of this.pkg.parts) strip(part.root);
  }

  #isHeading(p: XmlNode): boolean {
    const styleId = child(child(p, "w:pPr"), "w:pStyle")?.attrs["w:val"];
    return styleId !== undefined && [...this.#headingStyles.values()].includes(styleId);
  }

  /** Yeni paragraflar komşunun biçimini alır; başlığın yanına eklenen düz metin başlık olmaz. */
  insert(m: Match, text: string, before: boolean) {
    const anchor = m.p;
    const anchorIsHeading = this.#isHeading(anchor);
    const anchorPPr = child(anchor, "w:pPr");
    const listItem = child(anchorPPr, "w:numPr") !== undefined;
    const firstRun = unitsOf(anchor).find((u) => u.text.trim())?.run;
    const baseRPr = anchorIsHeading ? undefined : cleanRPr(child(firstRun, "w:rPr"));

    const paragraphs = text.split("\n").map((raw) => {
      let line = raw;
      let pPr: XmlNode | undefined;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const headingStyle = heading ? this.#headingStyles.get(heading[1]?.length ?? 1) : undefined;
      if (heading && headingStyle) {
        line = heading[2] ?? "";
        pPr = el("w:pPr", {}, [el("w:pStyle", { "w:val": headingStyle })]);
      } else if (anchorPPr && !anchorIsHeading) {
        pPr = cloneNode(anchorPPr);
        pPr.children = pPr.children.filter(
          (c) => !isElement(c) || !["w:sectPr", "w:pPrChange", "w:rPr"].includes(c.name),
        );
        if (listItem) line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
      }
      const runs = formattedRuns(line, heading && headingStyle ? undefined : baseRPr);
      const p = el("w:p", {}, []);
      if (this.options.track) {
        pPr ??= el("w:pPr");
        // Paragraf işaretinin rPr'si pPr'nin sonundadır (sectPr ve pPrChange yukarıda süzüldü).
        pPr.children.push(el("w:rPr", {}, [this.#revision("w:ins")]));
        p.children = [pPr, ...runs.map((r) => this.#revision("w:ins", [r]))];
      } else {
        p.children = [...(pPr ? [pPr] : []), ...runs];
      }
      return p;
    });
    const at = m.parent.children.indexOf(anchor);
    m.parent.children.splice(before ? at : at + 1, 0, ...paragraphs);
    m.part.dirty = true;
  }

  delete(m: Match) {
    const p = m.p;
    const pPr = child(p, "w:pPr");
    const blocks = elements(m.parent).filter((c) => c.name === "w:p" || c.name === "w:tbl");
    // Bölüm sonu taşıyan, kabındaki son ya da tek paragraf silinmez: Word boş hücre/kutu ve
    // tabloyla biten gövde kabul etmez. Yalnız içeriği boşaltılır (izli modda içerik silinir).
    const keepShell =
      child(pPr, "w:sectPr") !== undefined || blocks.length <= 1 || blocks.at(-1) === p;
    if (this.options.track) {
      for (const u of unitsOf(p)) this.#trackDelete(u);
      if (!keepShell) {
        const props = pPr ?? el("w:pPr");
        if (!pPr) p.children.unshift(props);
        let rPr = child(props, "w:rPr");
        if (!rPr) {
          rPr = el("w:rPr");
          // Şemada pPr'nin rPr'si sectPr ve pPrChange'ten önce gelir.
          const tail = props.children.findIndex(
            (c) => isElement(c) && (c.name === "w:sectPr" || c.name === "w:pPrChange"),
          );
          if (tail >= 0) props.children.splice(tail, 0, rPr);
          else props.children.push(rPr);
        }
        putInOrder(rPr, this.#revision("w:del"), RPR_ORDER);
      }
    } else if (keepShell) {
      p.children = pPr ? [pPr] : [];
    } else {
      removeChild(m.parent, p);
    }
    m.part.dirty = true;
  }

  /** Kalıp satırın kopyası; hücre metinleri `values`'tan (sütun sırasıyla, birleşik hücre bir kez). */
  #newRow(template: XmlNode, values: readonly string[]): XmlNode {
    const row = cloneNode(template);
    const trPr = child(row, "w:trPr");
    if (trPr) {
      trPr.children = trPr.children.filter(
        (c) => !isElement(c) || !["w:tblHeader", "w:ins", "w:del", "w:trPrChange"].includes(c.name),
      );
    }
    let col = 0;
    for (const tc of cellsOf(row)) {
      const span = spanOf(tc);
      const value = values
        .slice(col, col + span)
        .filter((v) => v !== "")
        .join(" ");
      col += span;
      const tcPr = child(tc, "w:tcPr");
      if (tcPr) {
        // Yeni satır üstteki dikey birleşmeye katılmaz; hücre düzeyi izli kayıtlar da taşınmaz.
        tcPr.children = tcPr.children.filter(
          (c) =>
            !isElement(c) ||
            !["w:vMerge", "w:tcPrChange", "w:cellIns", "w:cellDel", "w:cellMerge"].includes(c.name),
        );
      }
      tc.children = [...(tcPr ? [tcPr] : []), ...this.#cellParagraphs(tc, value)];
    }
    if (this.options.track) markRow(row, this.#revision("w:ins"));
    return row;
  }

  /**
   * Hücreye yazılacak paragraflar: biçim hücrenin ilk paragrafından (pPr) ve ilk metin run'ından
   * (rPr) alınır; `<br>` yeni paragraftır. İzli modda paragraf işareti ve run'lar `w:ins` taşır.
   */
  #cellParagraphs(tc: XmlNode, value: string): XmlNode[] {
    const first = paragraphsOf(tc)[0]?.p;
    const pPr = first ? child(first, "w:pPr") : undefined;
    const baseRPr = first
      ? cleanRPr(child(unitsOf(first).find((u) => u.text.trim())?.run, "w:rPr"))
      : undefined;
    return value.split(/<br\s*\/?>/i).map((line) => {
      let props = pPr ? cloneNode(pPr) : undefined;
      if (props) {
        props.children = props.children.filter(
          (c) => !isElement(c) || !["w:pPrChange", "w:sectPr"].includes(c.name),
        );
        const markRPr = child(props, "w:rPr");
        if (markRPr) {
          markRPr.children = markRPr.children.filter(
            (c) => !isElement(c) || !["w:ins", "w:del", "w:rPrChange"].includes(c.name),
          );
        }
      }
      const runs = line.trim() ? formattedRuns(line.trim(), baseRPr) : [];
      // Boş paragrafa sonradan yazılan metin paragraf işaretinin biçimini alır (Word); işaretsizse
      // kalıbın yazı biçimi oraya konur ki hücre stilin varsayılan yazısına düşmesin.
      if (runs.length === 0 && baseRPr && !child(props, "w:rPr")) {
        props ??= el("w:pPr");
        props.children.push(cloneNode(baseRPr));
      }
      if (!this.options.track) return el("w:p", {}, [...(props ? [props] : []), ...runs]);
      props ??= el("w:pPr");
      let markRPr = child(props, "w:rPr");
      if (!markRPr) {
        markRPr = el("w:rPr");
        props.children.push(markRPr);
      }
      putInOrder(markRPr, this.#revision("w:ins"), RPR_ORDER);
      return el("w:p", {}, [props, ...(runs.length ? [this.#revision("w:ins", runs)] : [])]);
    });
  }

  /**
   * Kalıp hücrenin kopyası: genişlik, gölge, kenarlık ve metin biçimi kalır, birleşme kalkar.
   * `markCell` hücreyi izli eklenmiş (`w:cellIns`) işaretler; tablo ve ayırma işlemlerinde kapalı.
   */
  #newCell(template: XmlNode, value: string, markCell = this.options.track): XmlNode {
    const tc = cloneNode(template);
    const tcPr = child(tc, "w:tcPr");
    if (tcPr) {
      tcPr.children = tcPr.children.filter(
        (c) =>
          !isElement(c) ||
          ![
            "w:gridSpan",
            "w:hMerge",
            "w:vMerge",
            "w:tcPrChange",
            "w:cellIns",
            "w:cellDel",
            "w:cellMerge",
          ].includes(c.name),
      );
    }
    tc.children = [...(tcPr ? [tcPr] : []), ...this.#cellParagraphs(tc, value)];
    if (markCell) putInOrder(ensureTcPr(tc), this.#revision("w:cellIns"), TCPR_ORDER);
    return tc;
  }

  /** Sütun ekler: her satıra kalıp sütundaki hücrenin kopyası; araya düşen birleşik hücre genişler. */
  colInsert(m: CellMatch, values: readonly string[], before: boolean) {
    const tbl = m.parent;
    const at = before ? m.cell.start : m.cell.start + m.cell.span;
    const source = before ? m.cell.start : m.cell.start + m.cell.span - 1;
    const widths = gridWidths(tbl);
    rowsOf(tbl).forEach((tr, i) => {
      const cells = gridCells(tr);
      const { from, to } = rowSpan(tr, cells);
      // Satırın boş baş/son aralığına düşen ekleme hücre değil aralık genişletir.
      if (at < from) {
        setRowGap(tr, "w:gridBefore", from + 1);
        return;
      }
      if (at > to) {
        const after = rowGap(tr, "w:gridAfter");
        if (after > 0) setRowGap(tr, "w:gridAfter", after + 1);
        return;
      }
      const straddle = cells.find((c) => c.start < at && at < c.start + c.span);
      if (straddle) {
        setSpan(straddle.tc, straddle.span + 1);
        return;
      }
      const template = covering(cells, source) ?? cells.at(-1);
      if (!template) return;
      const cell = this.#newCell(template.tc, values[i] ?? "");
      const next = cells.find((c) => c.start >= at);
      const anchor = next?.tc ?? cells.at(-1)?.tc;
      const holder = anchor ? (parentOf(tr, anchor) ?? tr) : tr;
      if (next) holder.children.splice(holder.children.indexOf(next.tc), 0, cell);
      else if (anchor) insertAfter(holder, anchor, cell);
      else tr.children.push(cell);
    });
    if (widths.length > 0) {
      const next = [...widths];
      next.splice(at, 0, widths[source] ?? 0);
      applyWidths(tbl, scaleTo(next, sum(widths)));
    }
    m.part.dirty = true;
  }

  /** Sütunu siler; birleşik hücre bir sütun daralır. İzli modda hücreler `w:cellDel` taşır. */
  colDelete(m: CellMatch) {
    const tbl = m.parent;
    const col = m.cell.start;
    if (this.options.track) {
      // İzli silme yalnız işaretler; kabul `removeCells` ile sütunu ızgaradan düşürür.
      for (const tr of rowsOf(tbl)) {
        const cell = covering(gridCells(tr), col);
        if (!cell) continue;
        for (const { p } of paragraphsOf(cell.tc)) {
          for (const u of unitsOf(p)) this.#trackDelete(u);
        }
        putInOrder(ensureTcPr(cell.tc), this.#revision("w:cellDel"), TCPR_ORDER);
      }
      m.part.dirty = true;
      return;
    }
    const widths = gridWidths(tbl);
    for (const tr of rowsOf(tbl)) {
      const cells = gridCells(tr);
      const { from, to } = rowSpan(tr, cells);
      const after = rowGap(tr, "w:gridAfter");
      if (col < from) setRowGap(tr, "w:gridBefore", from - 1);
      else if (col >= to) {
        if (after > 0) setRowGap(tr, "w:gridAfter", after - 1);
      } else {
        const cell = covering(cells, col);
        if (cell && cell.span > 1) setSpan(cell.tc, cell.span - 1);
        else if (cell) removeDeep(tr, cell.tc);
      }
      if (cellsOf(tr).length === 0) removeChild(tbl, tr);
    }
    // Birleşik hücreler daralsa da sütun ızgaradan her durumda düşer.
    if (widths.length > col) {
      const kept = widths.filter((_, i) => i !== col);
      applyWidths(tbl, scaleTo(kept, sum(widths)));
    }
    m.part.dirty = true;
  }

  /**
   * `a` ile `b` köşeli dikdörtgeni tek hücreye birleştirir: satır içinde `gridSpan`, satırlar
   * arasında `vMerge`. Boş olmayan içerik sol üst hücrede toplanır (Word'ün davranışı); `text`
   * verilirse içerik onunla değişir. Aralık doğrulaması çağıranda yapılır (`mergeRange`).
   */
  cellMerge(range: MergeRange, text: string) {
    if (this.options.track) this.#trackedMerge(range, text);
    else this.#plainMerge(range, text);
  }

  #plainMerge(range: MergeRange, text: string) {
    const collected: XmlNode[] = [];
    let top: XmlNode | undefined;
    const contentOf = (tc: XmlNode) =>
      elements(tc).filter((c) => c.name !== "w:tcPr" && !emptyBlock(c));
    range.rows.forEach((cells, i) => {
      const [first, ...rest] = cells;
      if (!first) return;
      // Okuma sırası: satır satır, soldan sağa; sol üst hücrenin içeriği aşağıda başa konur.
      if (i > 0) collected.push(...contentOf(first.tc));
      for (const cell of rest) {
        collected.push(...contentOf(cell.tc));
        removeDeep(range.rowNodes[i] ?? first.tc, cell.tc);
      }
      setSpan(first.tc, range.end - range.start);
      const tcPr = ensureTcPr(first.tc);
      tcPr.children = tcPr.children.filter((c) => !isElement(c) || c.name !== "w:vMerge");
      if (range.rows.length > 1) {
        putInOrder(tcPr, el("w:vMerge", i === 0 ? { "w:val": "restart" } : {}), TCPR_ORDER);
      }
      if (i === 0) {
        top = first.tc;
        return;
      }
      // Alt hücrenin içeriği üste taşındı; hücrede biçimi korunan boş bir paragraf kalır.
      const pPr = child(paragraphsOf(first.tc)[0]?.p, "w:pPr");
      first.tc.children = [tcPr, el("w:p", {}, pPr ? [cloneNode(pPr)] : [])];
    });
    if (!top) return;
    const topPr = child(top, "w:tcPr");
    const own = elements(top).filter((c) => c.name !== "w:tcPr");
    let content: XmlNode[];
    if (text.trim()) content = this.#cellParagraphs(top, text.trim());
    else {
      const kept = own.filter((c) => !emptyBlock(c));
      content = [...kept, ...collected];
      if (content.length === 0) content = own.slice(0, 1);
    }
    // Hücre paragrafla bitmeli (tabloyla biten hücreyi Word bozuk sayar).
    if (content.at(-1)?.name !== "w:p") content.push(el("w:p"));
    top.children = [...(topPr ? [topPr] : []), ...content];
    applyWidths(range.tbl, gridWidths(range.tbl));
    range.part.dirty = true;
  }

  /** Paragraf işaretine izli kayıt (pPr > rPr > ins/del) ekler. */
  #markParagraph(p: XmlNode, name: "w:ins" | "w:del") {
    let pPr = child(p, "w:pPr");
    if (!pPr) {
      pPr = el("w:pPr");
      p.children.unshift(pPr);
    }
    let rPr = child(pPr, "w:rPr");
    if (!rPr) {
      rPr = el("w:rPr");
      const tail = pPr.children.findIndex(
        (c) => isElement(c) && (c.name === "w:sectPr" || c.name === "w:pPrChange"),
      );
      if (tail >= 0) pPr.children.splice(tail, 0, rPr);
      else pPr.children.push(rPr);
    }
    putInOrder(rPr, this.#revision(name), RPR_ORDER);
  }

  /**
   * Satırları izli değiştirir: `change` satırları yerinde değiştirir, eski hâlleri izli silinmiş
   * kopya olarak öne girer, değişmiş hâlleri izli eklenmiş sayılır. Word birleştirme ve ayırmayı
   * kendisi izli yazmaz; hücre düzeyi kayıtlar (`tcPrChange` + `cellDel`) Word'ün kabul/retinde
   * ızgarayı bozuyor. Satır kaydı Word'de sağlam: kabul yeni hâli, ret özgün hâli bırakır.
   * `rows` tablo içinde art arda olmalı.
   *
   * Yer imi adı belgede tekildir; satırda kalsa ya kabulde (kopyadaysa) ya retde (yeni satırdaysa)
   * kaybolur, iki yerde olursa Word ilkini atar (Word'de denendi). Bu yüzden satırlardaki yer imi
   * başı/sonu tablo düzeyine, değişen satırların önüne/arkasına taşınır: iki durumda da kalır,
   * ama artık hücredeki metni değil değişen satırları kapsar (kullanıcı kararı).
   *
   * Göndermesi satırlarda olan yorumun bir eşi yeni kimlikle çıkarılır ve silinen kopya ona
   * bağlanır: kabulde eş, retde asıl kopyayla birlikte düşer, öbürü kendi metnine bağlı kalır
   * (Word'de denendi). Word'ün varsayılan görünümü silinen satırı gizlediği için balon sayfada bir
   * kez, hücre metninin yanında görünür; Gözden Geçirme bölmesi ikisini de listeler. Yer imi gibi
   * taşımak (aralık tablo düzeyinde, gönderme tablonun altında) yorumu tek tutuyordu ama balon
   * izli görünümde hiç görünmüyor, sonrasında da tablonun altına bağlanıyordu (kullanıcı hücre
   * metnini istedi). Göndermesi dışarıda olan yorumun satırlardaki aralık işaretleri yer imi gibi
   * taşınır.
   */
  #replaceRows(part: Part, tbl: XmlNode, rows: readonly XmlNode[], change: () => void) {
    const first = rows[0];
    const holder = first ? parentOf(tbl, first) : undefined;
    if (!first || !holder) return;
    const refs = new Set<string>();
    for (const tr of rows) collectCommentRefs(tr, refs);
    const twins = this.#copyComments(refs);
    // Eşi olmayan (göndermesi satırların dışında) yorumun aralık işaretleri yer imi gibi tablo
    // düzeyine çıkar. Word tablodan taşan aralığı zaten satırın tamamına genişletir; kapsam
    // değişmez (Word'de denendi: kabulde de retde de özgün kapsam).
    const starts: XmlNode[] = [];
    const ends: XmlNode[] = [];
    const lift = (node: XmlNode) => {
      node.children = node.children.filter((c) => {
        if (!isElement(c)) return true;
        const loose = !twins.has(c.attrs["w:id"] ?? "");
        if (c.name === "w:bookmarkStart" || (c.name === "w:commentRangeStart" && loose)) {
          starts.push(c);
        } else if (c.name === "w:bookmarkEnd" || (c.name === "w:commentRangeEnd" && loose)) {
          ends.push(c);
        } else {
          lift(c);
          return true;
        }
        return false;
      });
    };
    for (const tr of rows) lift(tr);
    // Paragraf kimlikleri belgede tekil olmalı; asılları (kabulde kalan) yeni satırlarda durur.
    // Gönderme run düzeyinde ele alınır (run'ın içine inildiğinde yeniden eşlenmesin).
    const COMMENT = ["w:commentRangeStart", "w:commentRangeEnd"];
    const strip = (node: XmlNode) => {
      delete node.attrs["w14:paraId"];
      delete node.attrs["w14:textId"];
      node.children = node.children.filter((c) => {
        if (!isElement(c)) return true;
        const mark = COMMENT.includes(c.name)
          ? c
          : c.name === "w:r"
            ? child(c, "w:commentReference")
            : undefined;
        if (!mark) return true;
        const twin = twins.get(mark.attrs["w:id"] ?? "");
        if (twin) mark.attrs["w:id"] = twin;
        return twin !== undefined;
      });
      for (const c of elements(node)) strip(c);
    };
    // Aralığı satırlardan önce başlayan yorumun eşi de aynı yerden başlar.
    const inRows = new Set<XmlNode>();
    for (const tr of rows) collectCommentStarts(tr, inRows);
    for (const [old, twin] of twins) {
      const start = findCommentStart(part.root, old);
      if (!start || inRows.has(start.node)) continue;
      insertAfter(start.parent, start.node, el("w:commentRangeStart", { "w:id": twin }));
    }
    // Kopyalar değişiklikten önce alınır, sonra eklenir: değişiklik (ör. ayırmanın sütun kalıbı
    // araması) onları tablonun satırı sanmasın.
    const olds = rows.map((tr) => {
      const copy = cloneNode(tr);
      strip(copy);
      for (const { p } of paragraphsOf(copy)) {
        for (const u of unitsOf(p)) this.#trackDelete(u);
      }
      markRow(copy, this.#revision("w:del"));
      return copy;
    });
    change();
    holder.children.splice(holder.children.indexOf(first), 0, ...starts, ...olds);
    const last = rows.at(-1);
    if (last) insertAfter(holder, last, ...ends);
    const wrap = (node: XmlNode) => {
      node.children = node.children.map((c) => {
        if (!isElement(c) || ["w:ins", "w:del", "w:pPr", "w:tcPr", "w:trPr"].includes(c.name)) {
          return c;
        }
        if (c.name === "w:r") return this.#revision("w:ins", [c]);
        wrap(c);
        return c;
      });
    };
    for (const tr of rows) {
      wrap(tr);
      for (const { p } of paragraphsOf(tr)) this.#markParagraph(p, "w:ins");
      markRow(tr, this.#revision("w:ins"));
    }
  }

  /** İzli birleştirme: aralığın satırları birleşik hâlleriyle izli değiştirilir. */
  #trackedMerge(range: MergeRange, text: string) {
    this.#replaceRows(range.part, range.tbl, range.rowNodes, () => this.#plainMerge(range, text));
  }

  /**
   * Birleşik hücreyi ızgara hücrelerine ayırır: yataydaki `gridSpan` ayrı hücrelere, dikeydeki
   * `vMerge` bağımsız hücrelere döner. İçerik sol üst hücrede kalır; `values` verilirse ayrılan
   * hücreler satır satır onunla dolar (boş değer hücrenin içeriğine dokunmaz). Açılan hücre
   * sütununun biçimini (gölge, kenarlık, hizalama, yazı) aynı sütundaki en yakın hücreden alır;
   * birleştirme o biçimi silmiştir. İzli modda satırlar ayrılmış hâlleriyle izli değiştirilir
   * (birleştirmedeki gibi, `#replaceRows`).
   */
  cellSplit(part: Part, tbl: XmlNode, cells: readonly XmlNode[], values: readonly string[][]) {
    if (!this.options.track) {
      this.#plainSplit(part, tbl, cells, values);
      return;
    }
    const rows = rowsOf(tbl).filter((tr) => cells.some((tc) => contains(tr, tc)));
    this.#replaceRows(part, tbl, rows, () => this.#plainSplit(part, tbl, cells, values));
  }

  #plainSplit(part: Part, tbl: XmlNode, cells: readonly XmlNode[], values: readonly string[][]) {
    const rows = rowsOf(tbl);
    const rowOf = (tc: XmlNode) => rows.find((tr) => tr.children.includes(tc) || contains(tr, tc));
    const merged = new Set(cells.map(rowOf));
    const header = (tr: XmlNode) => rows[0] === tr || isHeaderRow(tr);
    // Sütun kalıbı: birleşmenin dışındaki, aynı türden (başlık/gövde) en yakın satırda o sütunu
    // tek başına kaplayan hücre; dolu olan boş olana tercih edilir. Başlık biçimi gövdeye geçmez;
    // aynı türden satır yoksa karşı türün hücresinden yalnız hizalama alınır (tutar sütunu
    // başlıkta da gövdede de sağa yaslıdır).
    const nearest = (tr: XmlNode, col: number, sameKind: boolean): XmlNode | undefined => {
      const at = rows.indexOf(tr);
      const hits = rows
        .filter((r) => !merged.has(r) && (header(r) === header(tr)) === sameKind)
        .sort((a, b) => Math.abs(rows.indexOf(a) - at) - Math.abs(rows.indexOf(b) - at))
        .map((r) => gridCells(r).find((c) => c.start === col && c.span === 1))
        .filter((c) => c !== undefined);
      return (hits.find((c) => cellText(c.tc) !== "") ?? hits[0])?.tc;
    };
    // Kalıplar ayırmadan önce seçilir; ayrılan satırlar zaten kalıp adayı değildir.
    const plans = cells.map((tc) => {
      const tr = rowOf(tc);
      const start = tr ? (gridCells(tr).find((c) => c.tc === tc)?.start ?? 0) : 0;
      const models = Array.from({ length: spanOf(tc) }, (_, k) =>
        tr
          ? { model: nearest(tr, start + k, true), align: nearest(tr, start + k, false) }
          : { model: undefined, align: undefined },
      );
      return { tc, models };
    });
    plans.forEach(({ tc, models }, i) => {
      const span = spanOf(tc);
      const tcPr = ensureTcPr(tc);
      tcPr.children = tcPr.children.filter(
        (c) => !isElement(c) || !["w:gridSpan", "w:hMerge", "w:vMerge"].includes(c.name),
      );
      // Yüzde genişlik ızgarayla düzeltilmez (applyWidths yalnız DXA yazar); parçalara bölünür.
      const tcW = child(tcPr, "w:tcW");
      if (tcW?.attrs["w:type"] === "pct" && span > 1) {
        tcW.attrs["w:w"] = String(Math.round(Number(tcW.attrs["w:w"] ?? 0) / span));
      }
      const row = values[i] ?? [];
      const own = row[0]?.trim() ?? "";
      if (own) {
        // Boşaltılmış devam hücresinde yazı biçimi kalmamıştır; sütun kalıbından alınır.
        const source = cellText(tc) === "" ? (models[0]?.model ?? tc) : tc;
        tc.children = [tcPr, ...this.#cellParagraphs(source, own)];
      }
      const created = Array.from({ length: span - 1 }, (_, k) => {
        const { model, align } = models[k + 1] ?? {};
        const cell = this.#newCell(model ?? tc, row[k + 1]?.trim() ?? "", false);
        if (model) rowBorders(cell, tc);
        else if (align) alignLike(cell, align);
        return cell;
      });
      const holder = parentOf(tbl, tc);
      if (holder && created.length > 0) insertAfter(holder, tc, ...created);
    });
    applyWidths(tbl, gridWidths(tbl));
    part.dirty = true;
  }

  /**
   * Yeni tablonun kalıbı: belgedeki, çapadan önceki en yakın gövde tablosu (yoksa ilk tablo).
   * Tek satırlı ya da iç içe tablolu olanlar düzen tablosu olabilir; atlanır.
   */
  #tableTemplate(anchor: XmlNode): XmlNode {
    const body = child(child(this.pkg.parts[0]?.root, "w:document"), "w:body");
    const blocks = body ? elements(body) : [];
    const candidates = blocks.filter(
      (b) =>
        b.name === "w:tbl" &&
        rowsOf(b).length >= 2 &&
        rowsOf(b).every((tr) => cellsOf(tr).length > 0) &&
        !hasNestedTable(b),
    );
    const top = blocks.findIndex((b) => b === anchor || contains(b, anchor));
    const near = top < 0 ? undefined : candidates.filter((t) => blocks.indexOf(t) <= top).at(-1);
    return near ?? candidates[0] ?? defaultTableTemplate();
  }

  /** Markdown tablosundan yeni `w:tbl`: kalıbın tablo özellikleri, başlık ve gövde satırı biçimi. */
  #newTable(template: XmlNode, table: TableSpec, total: number): XmlNode {
    const columns = Math.max(1, table.header.length, ...table.rows.map((r) => r.length));
    const widths = columnWidths(table.header, table.rows, columns, total);
    const rows = rowsOf(template);
    const head = rows[0];
    const body = rows.find((r) => r !== head && !isHeaderRow(r)) ?? rows.at(-1);
    const tblPr = cloneNode(child(template, "w:tblPr") ?? el("w:tblPr"));
    // Konum (yüzen tablo), açıklama ve düzeltme kaydı örnek tabloya aittir.
    tblPr.children = tblPr.children.filter(
      (c) =>
        !isElement(c) ||
        !["w:tblpPr", "w:tblOverlap", "w:tblCaption", "w:tblDescription", "w:tblPrChange"].includes(
          c.name,
        ),
    );
    const tblW = child(tblPr, "w:tblW");
    if (!tblW || (tblW.attrs["w:type"] ?? "dxa") === "dxa") {
      putInOrder(tblPr, el("w:tblW", { "w:w": String(total), "w:type": "dxa" }), TBLPR_ORDER);
    }
    const makeRow = (source: XmlNode | undefined, values: readonly string[], header: boolean) => {
      const tr = source ? cloneNode(source) : el("w:tr");
      tr.children = tr.children.filter(
        (c) => isElement(c) && (c.name === "w:tblPrEx" || c.name === "w:trPr"),
      );
      const trPr = child(tr, "w:trPr");
      if (trPr) {
        const drop = ["w:gridBefore", "w:gridAfter", "w:wBefore", "w:wAfter", "w:ins", "w:del"];
        if (!header) drop.push("w:tblHeader");
        trPr.children = trPr.children.filter(
          (c) => !isElement(c) || (!drop.includes(c.name) && c.name !== "w:trPrChange"),
        );
      }
      const cells = source ? cellsOf(source) : [];
      // Sütuna özgü hizalama (ör. sağa yaslı tutar sütunu) yeni tablonun ilgisiz sütununa geçmesin;
      // yalnız satırın bütün hücrelerinde aynıysa tablonun genel biçimi sayılır.
      const jcOf = (tc: XmlNode) =>
        child(child(paragraphsOf(tc)[0]?.p, "w:pPr"), "w:jc")?.attrs["w:val"] ?? "";
      const uniform = cells.every((tc) => jcOf(tc) === jcOf(cells[0] ?? tc));
      for (let c = 0; c < columns; c++) {
        const model = cells[Math.min(c, cells.length - 1)];
        const value = values[c]?.trim() ?? "";
        const tc = model
          ? this.#newCell(model, value, false)
          : el("w:tc", {}, this.#cellParagraphs(el("w:tc"), value));
        putInOrder(ensureTcPr(tc), el("w:tcW", { "w:w": "0", "w:type": "dxa" }), TCPR_ORDER);
        const align = table.align[c];
        if (!uniform) {
          for (const { p } of paragraphsOf(tc)) {
            const pPr = child(p, "w:pPr");
            if (pPr) pPr.children = pPr.children.filter((x) => !isElement(x) || x.name !== "w:jc");
          }
        }
        if (align) {
          for (const { p } of paragraphsOf(tc)) {
            let pPr = child(p, "w:pPr");
            if (!pPr) {
              pPr = el("w:pPr");
              p.children.unshift(pPr);
            }
            putInOrder(pPr, el("w:jc", { "w:val": align }), PPR_ORDER);
          }
        }
        tr.children.push(tc);
      }
      if (this.options.track) markRow(tr, this.#revision("w:ins"));
      return tr;
    };
    const tbl = el("w:tbl", {}, [
      tblPr,
      el("w:tblGrid"),
      makeRow(head, table.header, true),
      ...table.rows.map((r) => makeRow(body, r, false)),
    ]);
    applyWidths(tbl, widths);
    return tbl;
  }

  /**
   * Tabloyu çapanın (paragraf ya da tablo) arkasına/önüne ekler. `docx_create` gibi arkasına boş
   * paragraf girer (sonraki blok zaten boş paragrafsa girmez); önünde tablo varsa araya da girer.
   */
  tableInsert(anchor: TableAnchor, table: TableSpec, before: boolean) {
    const { container, node } = anchor;
    const total = availableWidth(this.pkg.parts[0]?.root, container);
    const tbl = this.#newTable(this.#tableTemplate(node), table, total);
    const at = container.children.indexOf(node);
    const pos = before ? at : at + 1;
    const prev = blocksOf(container.children.slice(0, pos)).at(-1);
    const next = blocksOf(container.children.slice(pos))[0];
    // `docx_create`'teki gibi aralıksız boş paragraf: tabloyu alttaki metinden ayırır.
    const spacer = () => {
      const pPr = el("w:pPr", {}, [el("w:spacing", { "w:before": "0", "w:after": "0" })]);
      if (this.options.track) pPr.children.push(el("w:rPr", {}, [this.#revision("w:ins")]));
      return el("w:p", {}, [pPr]);
    };
    // Ardışık iki tablo Word'de birleşir; gövde ve hücre de tabloyla bitemez.
    container.children.splice(
      pos,
      0,
      ...(prev?.name === "w:tbl" ? [spacer()] : []),
      tbl,
      ...(next && emptyBlock(next) ? [] : [spacer()]),
    );
    anchor.part.dirty = true;
  }

  /** Tabloyu kaldırır; izli modda bütün satırlar izli silinir (kabulde tablo tümüyle kalkar). */
  tableDelete(part: Part, tbl: XmlNode, container: XmlNode) {
    if (this.options.track) {
      for (const tr of rowsOf(tbl)) {
        for (const { p } of paragraphsOf(tr)) {
          for (const u of unitsOf(p)) this.#trackDelete(u);
        }
        markRow(tr, this.#revision("w:del"));
      }
    } else {
      removeTable(container, tbl);
    }
    part.dirty = true;
  }

  rowInsert(m: RowMatch, rows: readonly string[][], before: boolean) {
    const template = rowTemplate(m, before);
    const created = rows.map((values) => this.#newRow(template, values));
    const at = m.parent.children.indexOf(m.tr);
    m.parent.children.splice(before ? at : at + 1, 0, ...created);
    m.part.dirty = true;
  }

  rowDelete(m: RowMatch) {
    if (this.options.track) {
      // Word'ün izli satır silmesi: satır işareti + hücrelerdeki metin izli silme.
      for (const { p } of paragraphsOf(m.tr)) {
        for (const u of unitsOf(p)) this.#trackDelete(u);
      }
      markRow(m.tr, this.#revision("w:del"));
    } else {
      promoteMerges(m.parent, m.tr);
      removeChild(m.parent, m.tr);
    }
    m.part.dirty = true;
  }

  /** Tüm izli değişiklikleri kabul ya da ret eder; işlenen değişiklik sayısını döner. */
  resolveAll(accept: boolean): number {
    let count = 0;
    const refs = () => {
      const out = new Set<string>();
      for (const part of this.pkg.parts) collectCommentRefs(part.root, out);
      return out;
    };
    const before = refs();
    for (const part of this.pkg.parts) {
      const was = count;
      count += resolveRevisions(part.root, accept);
      if (count > was) part.dirty = true;
    }
    const after = refs();
    this.#dropComments(new Set([...before].filter((id) => !after.has(id))));
    return count;
  }
}

const PROPERTY_CHANGES: Record<string, string> = {
  "w:rPrChange": "w:rPr",
  "w:pPrChange": "w:pPr",
  "w:tblPrChange": "w:tblPr",
  "w:trPrChange": "w:trPr",
  "w:tcPrChange": "w:tcPr",
};

/**
 * Kabul: silinen içerik ve düzeltme kayıtları atılır, eklenenler açılır. Ret: eklenenler atılır,
 * silinenler geri gelir, biçim değişiklikleri eski hâline döner. Silinmiş (kabulde) ya da
 * eklenmiş (retde) paragraf işareti paragrafı sonrakiyle birleştirir; Word'ün davranışı budur.
 * Bölüm ve tablo ızgarası değişiklikleri (`sectPrChange`, `tblGridChange`) retde eski hâle
 * döndürülmez, yalnız kaydı atılır.
 */
function resolveRevisions(node: XmlNode, accept: boolean): number {
  let count = 0;
  const drop = accept ? ["w:del", "w:moveFrom"] : ["w:ins", "w:moveTo"];
  const unwrap = accept ? ["w:ins", "w:moveTo"] : ["w:del", "w:moveFrom"];
  const next: XmlNode["children"] = [];
  for (const c of node.children) {
    if (!isElement(c)) {
      next.push(c);
      continue;
    }
    // Paragraf işareti kaydı (pPr > rPr > ins/del) aşağıda paragraf düzeyinde ele alınır.
    // Satır işareti (trPr > ins/del) da `dropMarkedRows`'ta satır düzeyinde ele alınır.
    const markHolder = node.name === "w:rPr" || node.name === "w:trPr";
    if (!markHolder && drop.includes(c.name)) {
      count++;
      continue;
    }
    if (!markHolder && unwrap.includes(c.name)) {
      count++;
      count += resolveRevisions(c, accept);
      for (const inner of c.children) {
        if (isElement(inner) && !accept) renameDeleted(inner);
        next.push(inner);
      }
      continue;
    }
    if (/^w:(move(From|To)Range(Start|End))$/.test(c.name)) continue;
    const restores = PROPERTY_CHANGES[c.name];
    if (
      restores ||
      c.name === "w:sectPrChange" ||
      c.name === "w:tblGridChange" ||
      c.name === "w:numberingChange"
    ) {
      count++;
      if (!accept && restores && node.name === restores) {
        const old = child(c, restores);
        // Eski özellikler yalnız biçimi taşır; paragraf işaretinin rPr'si ve bölüm sonu korunur.
        const keep = node.children.filter(
          (x) =>
            isElement(x) &&
            ((node.name === "w:pPr" && (x.name === "w:rPr" || x.name === "w:sectPr")) ||
              (node.name === "w:trPr" && (x.name === "w:ins" || x.name === "w:del"))),
        );
        node.children = [...(old?.children ?? []), ...keep];
        return count;
      }
      continue;
    }
    count += resolveRevisions(c, accept);
    next.push(c);
  }
  node.children = next;
  count += mergeMarkedParagraphs(node, accept);
  count += dropMarkedRows(node, accept);
  count += dropMarkedCells(node, accept);
  dropEmptyTables(node);
  return count;
}

function renameDeleted(node: XmlNode) {
  if (node.name === "w:delText") node.name = "w:t";
  else if (node.name === "w:delInstrText") node.name = "w:instrText";
  for (const c of elements(node)) renameDeleted(c);
}

/** pPr > rPr içindeki izli işaret (w:del kabulde, w:ins retde) paragrafı sonrakiyle birleştirir. */
function mergeMarkedParagraphs(container: XmlNode, accept: boolean): number {
  let count = 0;
  const mark = accept ? "w:del" : "w:ins";
  const other = accept ? "w:ins" : "w:del";
  for (let i = 0; i < container.children.length; i++) {
    const p = container.children[i];
    if (!p || !isElement(p) || p.name !== "w:p") continue;
    const rPr = child(child(p, "w:pPr"), "w:rPr");
    if (!rPr) continue;
    // Karşı işaret yalnız kayıttır; atılır.
    const hadOther = rPr.children.some(
      (c) => isElement(c) && (c.name === other || c.name === `w:move${accept ? "To" : "From"}`),
    );
    rPr.children = rPr.children.filter(
      (c) => !isElement(c) || (c.name !== other && !c.name.startsWith("w:move")),
    );
    if (hadOther) count++;
    if (!rPr.children.some((c) => isElement(c) && c.name === mark)) continue;
    rPr.children = rPr.children.filter((c) => !isElement(c) || c.name !== mark);
    count++;
    const content = p.children.filter((c) => !isElement(c) || c.name !== "w:pPr");
    const following = container.children
      .slice(i + 1)
      .find((c): c is XmlNode => isElement(c) && (c.name === "w:p" || c.name === "w:tbl"));
    if (following?.name !== "w:p") continue;
    const at = following.children.findIndex((c) => !isElement(c) || c.name !== "w:pPr");
    following.children.splice(at < 0 ? following.children.length : at, 0, ...content);
    container.children.splice(i, 1);
    i--;
  }
  return count;
}

/** trPr içindeki izli satır işareti: silinen satır kabulde, eklenen satır retde kaldırılır. */
/** tcPr içindeki izli hücre işareti: silinen hücre kabulde, eklenen hücre retde kaldırılır. */
function dropMarkedCells(tbl: XmlNode, accept: boolean): number {
  if (tbl.name !== "w:tbl") return 0;
  let count = 0;
  const doomedMark = accept ? "w:cellDel" : "w:cellIns";
  const doomed = new Set<XmlNode>();
  for (const tr of rowsOf(tbl)) {
    for (const { tc } of gridCells(tr)) {
      const tcPr = child(tc, "w:tcPr");
      if (!tcPr) continue;
      const marks = elements(tcPr).filter((c) => c.name === "w:cellIns" || c.name === "w:cellDel");
      if (marks.length === 0) continue;
      count += marks.length;
      if (child(tcPr, doomedMark)) doomed.add(tc);
      tcPr.children = tcPr.children.filter((c) => !isElement(c) || !marks.includes(c));
    }
  }
  if (doomed.size > 0) removeCells(tbl, doomed);
  return count;
}

function dropMarkedRows(tbl: XmlNode, accept: boolean): number {
  if (tbl.name !== "w:tbl") return 0;
  let count = 0;
  const mark = accept ? "w:del" : "w:ins";
  const rowsBefore = tbl.children.length;
  tbl.children = tbl.children.filter((row) => {
    if (!isElement(row) || row.name !== "w:tr") return true;
    const trPr = child(row, "w:trPr");
    if (!trPr) return true;
    const marked = child(trPr, mark) !== undefined;
    const before = trPr.children.length;
    trPr.children = trPr.children.filter(
      (c) => !isElement(c) || (c.name !== "w:ins" && c.name !== "w:del"),
    );
    if (trPr.children.length !== before) count++;
    return !marked;
  });
  if (tbl.children.length !== rowsBefore) repairMerges(tbl);
  return count;
}

/**
 * Satırlar kalktıktan sonra başsız kalan dikey birleşme devamı (üstündeki hücre birleşmeye
 * katılmıyor) başlangıç olur. Konuma dayanır, Word'ün `vMerge` yorumu gibi: izli birleştirmenin
 * kabul/retinde eski ve yeni satırlar arasından geçen dış birleşmeler de böyle doğru kalır.
 */
function repairMerges(tbl: XmlNode) {
  let above: GridCell[] = [];
  for (const tr of rowsOf(tbl)) {
    const cells = gridCells(tr);
    for (const cell of cells) {
      const merge = child(child(cell.tc, "w:tcPr"), "w:vMerge");
      if (!merge || merge.attrs["w:val"] === "restart") continue;
      const up = above.find((c) => c.start === cell.start);
      if (!up || !child(child(up.tc, "w:tcPr"), "w:vMerge")) merge.attrs["w:val"] = "restart";
    }
    above = cells;
  }
}

// ─── Giriş noktası ─────────────────────────────────────────────────────────────────────────────

const NEEDS_FIND: readonly DocxEditAction[] = [
  "replace",
  "insert_after",
  "insert_before",
  "delete",
  "comment",
  "row_insert_after",
  "row_insert_before",
  "row_delete",
  "col_insert_after",
  "col_insert_before",
  "col_delete",
  "cell_merge",
  "cell_split",
  "table_insert_after",
  "table_insert_before",
  "table_delete",
];

/**
 * Düzenlemeleri sırayla uygular; her biri bir öncekinin sonucunda arar. Biri başarısız olursa
 * hiçbir şey yazılmaz (çağıran `bytes`'ı ancak başarıda alır).
 */
export function editDocx(
  bytes: Uint8Array,
  edits: readonly DocxEdit[],
  options: DocxEditOptions,
): DocxEditResult {
  const d = dict(options.lang ?? "tr");
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  let pkg: DocxPackage;
  try {
    pkg = new DocxPackage(bytes);
  } catch (error) {
    if (error instanceof OoxmlError) throw new DocxEditError(d.docx[error.code]);
    throw error;
  }
  const editor = new Editor(pkg, options);
  const counts: Partial<Record<DocxEditAction, number>> = {};
  const add = (action: DocxEditAction, n: number) => {
    counts[action] = (counts[action] ?? 0) + n;
  };

  edits.forEach((edit, index) => {
    const fail = (message: string) =>
      new DocxEditError(
        fill(d.docxEdit.editFailed, { n: index + 1, action: edit.action, message }),
      );
    if (edit.action === "accept_all" || edit.action === "reject_all") {
      add(edit.action, editor.resolveAll(edit.action === "accept_all"));
      return;
    }
    if (!NEEDS_FIND.includes(edit.action)) throw fail(d.docxEdit.unknownAction);
    const find = edit.find ?? "";
    if (!find.trim()) throw fail(d.docxEdit.findRequired);
    const text = edit.text ?? "";
    if (edit.action === "replace" && text.includes("\n")) throw fail(d.docxEdit.replaceNewline);
    if ((edit.action === "comment" || edit.action.startsWith("insert")) && !text.trim()) {
      throw fail(d.docxEdit.textRequired);
    }
    if (edit.action.startsWith("row_")) {
      add(edit.action, applyRowEdit(editor, pkg, edit, fail));
      return;
    }
    if (edit.action.startsWith("table_")) {
      add(edit.action, applyTableEdit(editor, pkg, edit, fail));
      return;
    }
    if (edit.action.startsWith("col_") || edit.action.startsWith("cell_")) {
      add(edit.action, applyCellEdit(editor, pkg, edit, fail));
      return;
    }
    const parts = edit.action === "comment" ? pkg.parts.slice(0, 1) : pkg.parts;
    const matches = findMatches(find, parts);
    if (matches.length === 0) throw fail(d.docxEdit.notFound);
    // Paragraf işlemleri paragraf başına bir kez: aynı paragraftaki iki eşleşme iki kez silmesin.
    const targets =
      edit.action === "delete" || edit.action.startsWith("insert")
        ? matches.filter((m, i) => matches.findIndex((x) => x.p === m.p) === i)
        : matches;
    if (targets.length > 1 && !edit.all) {
      const where = targets
        .slice(0, 3)
        .map((m) => `"${m.preview}"`)
        .join("; ");
      throw fail(fill(d.docxEdit.ambiguous, { count: targets.length, where }));
    }
    // Sondan başa: aynı paragraftaki önceki eşleşmelerin konumu kaymasın.
    for (const m of [...targets].reverse()) {
      if (edit.action === "replace") editor.replace(m, text);
      else if (edit.action === "comment") editor.comment(m, text);
      else if (edit.action === "delete") editor.delete(m);
      else editor.insert(m, text, edit.action === "insert_before");
    }
    add(edit.action, targets.length);
  });
  return { bytes: pkg.toBuffer(), counts };
}

/** Satır ekleme/silme; uygulanan satır (çapa) sayısını döner. */
function applyRowEdit(
  editor: Editor,
  pkg: DocxPackage,
  edit: DocxEdit,
  fail: (message: string) => DocxEditError,
): number {
  const d = dict(editor.options.lang ?? "tr");
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const insert = edit.action !== "row_delete";
  const rows = insert ? parseRows(edit.text ?? "") : [];
  if (insert && rows.length === 0) throw fail(d.docxEdit.textRequired);
  const matches = findRows(edit.find ?? "", pkg.parts);
  if (matches.length === 0) throw fail(d.docxEdit.rowNotFound);
  if (matches.length > 1 && !edit.all) {
    const where = matches
      .slice(0, 3)
      .map((m) => `"${m.preview}"`)
      .join("; ");
    throw fail(fill(d.docxEdit.ambiguous, { count: matches.length, where }));
  }
  const before = edit.action === "row_insert_before";
  // Hepsi önce doğrulanır: yarıda kalan düzenleme olmasın.
  for (const m of matches) {
    // Tablonun bütün satırları silinemez: Word satırsız tablo kabul etmez.
    const doomed = matches.filter((x) => x.parent === m.parent).length;
    if (!insert && rowsOf(m.parent).length <= doomed) throw fail(d.docxEdit.onlyRow);
    const width = gridWidth(rowTemplate(m, before));
    // Okuma görünümü kısa satırları tablo genişliğine boş hücreyle doldurur; sondaki boşlar sayılmaz.
    const used = (r: string[]) => r.length - [...r].reverse().findIndex((c) => c !== "");
    const widest = Math.max(0, ...rows.map((r) => (r.some((c) => c !== "") ? used(r) : 0)));
    if (widest > width) throw fail(fill(d.docxEdit.tooManyCells, { given: widest, width }));
  }
  for (const m of matches) {
    if (insert) editor.rowInsert(m, rows, before);
    else editor.rowDelete(m);
  }
  return matches.length;
}

/** Sütun ekleme/silme ve hücre birleştirme; uygulanan sütun ya da birleştirme sayısını döner. */
function applyCellEdit(
  editor: Editor,
  pkg: DocxPackage,
  edit: DocxEdit,
  fail: (message: string) => DocxEditError,
): number {
  const d = dict(editor.options.lang ?? "tr");
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const track = editor.options.track;
  const pick = (find: string, label: "find" | "to"): CellMatch[] => {
    const matches = findCells(find, pkg.parts);
    if (matches.length === 0) throw fail(fill(d.docxEdit.cellNotFound, { field: label }));
    if (matches.some((m) => m.parent.name !== "w:tbl")) throw fail(d.docxEdit.tableUnsupported);
    return matches;
  };
  // İzli birleştirme/ayırma satırları kopyalayıp izli siler: bekleyen düzeltme kopyada
  // kaybolur, iç içe tablonun satırları işaretlenmez. Bu yüzden satırın tamamı denetlenir.
  const trackedRows = (rows: readonly XmlNode[]) => {
    if (!track) return;
    const REVISIONS = ["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:cellIns", "w:cellDel"];
    const has = (node: XmlNode, test: (n: XmlNode) => boolean): boolean =>
      elements(node).some((c) => test(c) || has(c, test));
    const pending = (n: XmlNode) => REVISIONS.includes(n.name) || n.name.endsWith("PrChange");
    if (rows.some((tr) => has(tr, pending))) throw fail(d.docxEdit.mergeRevisions);
    if (rows.some((tr) => has(tr, (n) => n.name === "w:tbl"))) throw fail(d.docxEdit.mergeNested);
  };
  const ambiguous = (matches: CellMatch[]) =>
    fail(
      fill(d.docxEdit.ambiguous, {
        count: matches.length,
        where: matches
          .slice(0, 3)
          .map((m) => `"${m.preview}"`)
          .join("; "),
      }),
    );

  if (edit.action === "cell_merge") {
    if (!edit.to?.trim()) throw fail(d.docxEdit.toRequired);
    const from = pick(edit.find ?? "", "find");
    const to = pick(edit.to, "to");
    const [a] = from;
    const [b] = to;
    if (from.length > 1 || !a) throw ambiguous(from);
    if (to.length > 1 || !b) throw ambiguous(to);
    if (a.parent !== b.parent) throw fail(d.docxEdit.mergeTables);
    if (a.cell.tc === b.cell.tc) throw fail(d.docxEdit.mergeSingle);
    const range = mergeRange(a, b);
    if (!range) throw fail(d.docxEdit.mergeSplits);
    trackedRows(range.rowNodes);
    editor.cellMerge(range, edit.text ?? "");
    return 1;
  }

  if (edit.action === "cell_split") {
    const found = pick(edit.find ?? "", "find");
    const [m] = found;
    if (found.length > 1 || !m) throw ambiguous(found);
    const rows = rowsOf(m.parent);
    const cellAt = (r: number) => {
      const tr = rows[r];
      return tr ? gridCells(tr).find((c) => c.start === m.cell.start) : undefined;
    };
    const continues = (r: number) => {
      const cell = cellAt(r);
      return cell !== undefined && continuesMerge(cell.tc);
    };
    // Devam hücresi bulunduysa birleşmenin başladığı satıra çıkılır.
    let top = m.row;
    while (top > 0 && continues(top)) top--;
    const head = cellAt(top);
    if (!head) throw fail(d.docxEdit.splitNotMerged);
    const cells = [head.tc];
    if (child(child(head.tc, "w:tcPr"), "w:vMerge")) {
      for (let r = top + 1; continues(r); r++) {
        const cell = cellAt(r);
        if (cell) cells.push(cell.tc);
      }
    }
    if (cells.length === 1 && head.span === 1) throw fail(d.docxEdit.splitNotMerged);
    const values = edit.text?.trim() ? parseRows(edit.text) : [];
    const cols = Math.max(...cells.map(spanOf));
    const used = (r: string[]) => r.length - [...r].reverse().findIndex((c) => c !== "");
    const wide = values.some((r) => r.some((c) => c !== "") && used(r) > cols);
    if (values.length > cells.length || wide) {
      throw fail(fill(d.docxEdit.splitValues, { rows: cells.length, cols }));
    }
    trackedRows(rows.filter((tr) => cells.some((tc) => contains(tr, tc))));
    editor.cellSplit(m.part, m.parent, cells, values);
    return 1;
  }

  const insert = edit.action !== "col_delete";
  const before = edit.action === "col_insert_before";
  const values = insert ? parseColumn(edit.text ?? "") : [];
  if (insert && !values.some((v) => v !== "")) throw fail(d.docxEdit.textRequired);
  // Aynı sütundaki birden çok hücre (ör. başlık ve gövdede aynı sözcük) tek sütun sayılır.
  const all = pick(edit.find ?? "", "find");
  const key = (m: CellMatch) =>
    insert ? (before ? m.cell.start : m.cell.start + m.cell.span) : m.cell.start;
  const columns = all.filter(
    (m, i) => all.findIndex((x) => x.parent === m.parent && key(x) === key(m)) === i,
  );
  if (columns.length > 1 && !edit.all) throw ambiguous(columns);
  for (const m of columns) {
    const rows = rowsOf(m.parent);
    if (insert) {
      const used = values.length - [...values].reverse().findIndex((v) => v !== "");
      if (used > rows.length) {
        throw fail(fill(d.docxEdit.tooManyValues, { given: used, rows: rows.length }));
      }
      const at = key(m);
      // Birleşik hücrenin genişlemesi izlenemez (ret onu daraltamaz); boş aralıklar kabul/retde
      // `removeCells` ile birlikte daralır.
      const straddles = (tr: XmlNode) =>
        gridCells(tr).some((c) => c.start < at && at < c.start + c.span);
      if (track && rows.some(straddles)) throw fail(d.docxEdit.trackedSpan);
    } else {
      if (m.cell.span > 1) throw fail(d.docxEdit.columnSpan);
      if (gridWidths(m.parent).length <= 1 || rows.every((tr) => gridCells(tr).length <= 1))
        throw fail(d.docxEdit.onlyColumn);
      // İzli silmede sütundan birleşik hücre geçmemeli: daralması izlenemez.
      const straddles = (tr: XmlNode) => (covering(gridCells(tr), m.cell.start)?.span ?? 1) > 1;
      if (track && rows.some(straddles)) throw fail(d.docxEdit.trackedSpan);
    }
  }
  // Aynı tablodaki birden çok sütun sağdan sola işlenir ki sütun konumları kaymasın.
  for (const m of [...columns].sort((x, y) => key(y) - key(x))) {
    if (insert) editor.colInsert(m, values, before);
    else editor.colDelete(m);
  }
  return columns.length;
}

/** Tablo ekleme/silme; eklenen ya da silinen tablo sayısını döner. */
function applyTableEdit(
  editor: Editor,
  pkg: DocxPackage,
  edit: DocxEdit,
  fail: (message: string) => DocxEditError,
): number {
  const d = dict(editor.options.lang ?? "tr");
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const find = edit.find ?? "";
  const ambiguous = (previews: string[]) =>
    fail(
      fill(d.docxEdit.ambiguous, {
        count: previews.length,
        where: previews
          .slice(0, 3)
          .map((p) => `"${p}"`)
          .join("; "),
      }),
    );
  // Satır metni (`| a | b |`) paragrafta bulunmaz; hücre ve satır aramasına düşülür.
  const inTables = (): TableAnchor[] => {
    const cells = findCells(find, pkg.parts).map((m) => ({
      part: m.part,
      tr: m.tr,
      preview: m.preview,
    }));
    const hits = cells.length > 0 ? cells : findRows(find, pkg.parts);
    return hits.flatMap((h) => {
      const found = enclosingTable(h.part.root, h.tr);
      return found
        ? [{ part: h.part, node: found.tbl, container: found.container, preview: h.preview }]
        : [];
    });
  };
  const unique = (anchors: TableAnchor[]) =>
    anchors.filter((a, i) => anchors.findIndex((x) => x.node === a.node) === i);

  if (edit.action === "table_delete") {
    const tables = unique(inTables());
    if (tables.length === 0) throw fail(d.docxEdit.tableNotFound);
    if (tables.length > 1 && !edit.all) throw ambiguous(tables.map((t) => t.preview));
    // İzli silme yalnız doğrudan satırları işaretler; içerik denetimine sarılı satır kabulde kalırdı.
    const wrapped = (t: TableAnchor) => elements(t.node).some((c) => ROW_WRAPPERS.has(c.name));
    if (editor.options.track && tables.some(wrapped)) throw fail(d.docxEdit.tableUnsupported);
    for (const t of tables) editor.tableDelete(t.part, t.node, t.container);
    return tables.length;
  }

  const table = parseTable(edit.text ?? "");
  if (!table || ![table.header, ...table.rows].some((r) => r.some((c) => c.trim()))) {
    throw fail(d.docxEdit.textRequired);
  }
  // Satır/hücre aramasındaki gibi paragrafın tamamı olan eşleşme (ör. hücredeki "Kondenser"),
  // aynı sözcüğü içeren uzun paragrafların önüne geçer.
  const matches = findMatches(find, pkg.parts);
  const whole = matches.filter((m) => m.whole);
  const paragraphs = (whole.length > 0 ? whole : matches).map((m): TableAnchor => {
    // Tablo içindeki metin tablonun kendisini gösterir: yeni tablo onun altına/üstüne girer.
    const found = enclosingTable(m.part.root, m.p);
    return found
      ? { part: m.part, node: found.tbl, container: found.container, preview: m.preview }
      : { part: m.part, node: m.p, container: m.parent, preview: m.preview };
  });
  const anchors = unique(paragraphs.length > 0 ? paragraphs : inTables());
  if (anchors.length === 0) throw fail(d.docxEdit.notFound);
  if (anchors.length > 1 && !edit.all) throw ambiguous(anchors.map((a) => a.preview));
  for (const a of anchors) editor.tableInsert(a, table, edit.action === "table_insert_before");
  return anchors.length;
}

/**
 * Yazılacak yol: `output` yoksa kaynağın kendisi. Göreli `output` kaynağın klasörüne göre
 * çözülür (aynı klasörde "Teklif - düzeltilmiş.docx"); uzantı yoksa `.docx` eklenir.
 */
export function resolveDocxEditTarget(
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
  return { source, target: /\.(docx|docm)$/i.test(abs) ? abs : `${abs}.docx` };
}
