import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  child,
  elements,
  findAll,
  findDeep,
  OoxmlError,
  parseXml,
  relsPathOf,
  resolvePart,
  textOf,
  type XmlNode,
  ZipArchive,
} from "./ooxml.js";

/**
 * Word (.docx) okuma: paket açılır, `word/document.xml` Markdown'a çevrilir.
 *
 * Pi'nin `read` aracı .docx'i tanımaz; ZIP baytlarını metin sanıp çöp döndürür. Bu modül `read`
 * sarmalayıcısından (`read-tool.ts`) ve görüntüleyiciden (`files:read`) çağrılır. Paket eklenmedi
 * (`ooxml.ts`). Kapsam: başlık, liste, tablo, vurgu, bağlantı, metin kutusu, üst/alt bilgi,
 * dipnot/son not; izli değişiklik ve yorumlar CriticMarkup ile (`{++eklenen++}`, `{--silinen--}`,
 * `{==metin==}{>>yazar: yorum<<}`) görünür ki model belgeyi düzenlemeden önce durumunu bilsin.
 */

export const isDocx = (path: string) => /\.(docx|docm|dotx|dotm)$/i.test(path);

class DocxError extends Error {}

/** Paket hatasını okunur iletiye çevirir. */
function openPackage(bytes: Uint8Array, d: ReturnType<typeof dict>): ZipArchive {
  try {
    return ZipArchive.open(bytes);
  } catch (error) {
    if (error instanceof OoxmlError) throw new DocxError(d.docx[error.code]);
    throw error;
  }
}

/** `<w:b/>` açık, `<w:b w:val="0|false|off"/>` kapalı. */
const toggled = (rPr: XmlNode | undefined, name: string) => {
  const el = child(rPr, name);
  if (!el) return false;
  const v = el.attrs["w:val"];
  return v === undefined || !["0", "false", "off", "none"].includes(v);
};

// ─── Belge bağlamı: stiller, numaralandırma, bağlantılar ────────────────────────────────────────

interface StyleInfo {
  name: string;
  basedOn?: string;
  outline?: number;
  numId?: string;
  ilvl?: number;
}

interface DocContext {
  styles: Map<string, StyleInfo>;
  /** numId → (ilvl → sıralı mı) */
  numbering: Map<string, Map<number, boolean>>;
  rels: Map<string, string>;
  counters: Map<string, number>;
  imageLabel: string;
  comments: Map<string, string>;
  /** Aralığı açılmış ve yorumu yazılmış yorumlar: aynı yorum iki kez basılmasın. */
  openComments: Set<string>;
  shownComments: Set<string>;
  /** Dipnot/son not kimliği → görünen numara (belgedeki sırayla). */
  notes: Map<string, string>;
  noteTexts: Map<string, string>;
  stats: { insertions: number; deletions: number };
}

function readStyles(xml: XmlNode | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  const root = xml ? child(xml, "w:styles") : undefined;
  if (!root) return styles;
  for (const s of elements(root)) {
    if (s.name !== "w:style" || s.attrs["w:type"] !== "paragraph") continue;
    const id = s.attrs["w:styleId"];
    if (!id) continue;
    const pPr = child(s, "w:pPr");
    const outline = child(pPr, "w:outlineLvl")?.attrs["w:val"];
    const numPr = child(pPr, "w:numPr");
    const numId = child(numPr, "w:numId")?.attrs["w:val"];
    const ilvl = child(numPr, "w:ilvl")?.attrs["w:val"];
    const basedOn = child(s, "w:basedOn")?.attrs["w:val"];
    styles.set(id, {
      name: child(s, "w:name")?.attrs["w:val"] ?? id,
      ...(basedOn ? { basedOn } : {}),
      ...(outline !== undefined ? { outline: Number(outline) } : {}),
      ...(numId ? { numId } : {}),
      ...(ilvl !== undefined ? { ilvl: Number(ilvl) } : {}),
    });
  }
  return styles;
}

function readNumbering(xml: XmlNode | undefined): Map<string, Map<number, boolean>> {
  const result = new Map<string, Map<number, boolean>>();
  const root = xml ? child(xml, "w:numbering") : undefined;
  if (!root) return result;
  const abstract = new Map<string, Map<number, boolean>>();
  for (const a of elements(root)) {
    if (a.name !== "w:abstractNum") continue;
    const levels = new Map<number, boolean>();
    for (const lvl of elements(a)) {
      if (lvl.name !== "w:lvl") continue;
      const fmt = child(lvl, "w:numFmt")?.attrs["w:val"] ?? "bullet";
      levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), fmt !== "bullet" && fmt !== "none");
    }
    abstract.set(a.attrs["w:abstractNumId"] ?? "", levels);
  }
  for (const n of elements(root)) {
    if (n.name !== "w:num") continue;
    const ref = child(n, "w:abstractNumId")?.attrs["w:val"];
    const levels = ref !== undefined ? abstract.get(ref) : undefined;
    if (levels && n.attrs["w:numId"]) result.set(n.attrs["w:numId"], levels);
  }
  return result;
}

function readRels(xml: XmlNode | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  const root = xml ? child(xml, "Relationships") : undefined;
  for (const r of root ? elements(root) : []) {
    if (r.attrs.Id && r.attrs.Target) rels.set(r.attrs.Id, r.attrs.Target);
  }
  return rels;
}

/** Stil zincirinde (basedOn) ilk bulunan değer; döngüye karşı derinlik sınırlı. */
function styleLookup<T>(
  ctx: DocContext,
  id: string | undefined,
  pick: (s: StyleInfo) => T | undefined,
) {
  let current = id;
  for (let depth = 0; current && depth < 10; depth++) {
    const style = ctx.styles.get(current);
    if (!style) return undefined;
    const value = pick(style);
    if (value !== undefined) return value;
    current = style.basedOn;
  }
  return undefined;
}

/**
 * Başlık düzeyi (1–6). Yerleşik başlık stillerinin adı XML'de dil ne olursa olsun "heading N"
 * olarak durur (Türkçe Word'de kimlik "Balk1" olsa da); özel stiller `outlineLvl` taşır.
 */
function headingLevel(ctx: DocContext, pPr: XmlNode | undefined): number | undefined {
  const direct = child(pPr, "w:outlineLvl")?.attrs["w:val"];
  if (direct !== undefined && Number(direct) < 6) return Number(direct) + 1;
  const styleId = child(pPr, "w:pStyle")?.attrs["w:val"];
  return styleLookup(ctx, styleId, (s) => {
    const named = /^heading\s*(\d)$/i.exec(s.name);
    if (named) return Math.min(6, Number(named[1]));
    if (/^title$/i.test(s.name)) return 1;
    if (s.outline !== undefined && s.outline < 6) return s.outline + 1;
    return undefined;
  });
}

// ─── Paragraf metni ────────────────────────────────────────────────────────────────────────────

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  link?: string;
  /** İşaret (CriticMarkup, dipnot): biçim sarmalanmaz. */
  raw?: boolean;
}

const rawSegment = (text: string): Segment => ({
  text,
  bold: false,
  italic: false,
  strike: false,
  raw: true,
});

function commentMarker(ctx: DocContext, id: string): string {
  if (ctx.shownComments.has(id)) return "";
  ctx.shownComments.add(id);
  const text = ctx.comments.get(id);
  return text ? `{>>${text}<<}` : "";
}

function noteMarker(ctx: DocContext, key: string): string {
  let n = ctx.notes.get(key);
  if (!n) {
    n = String(ctx.notes.size + 1);
    ctx.notes.set(key, n);
  }
  return `[^${n}]`;
}

function collectRun(run: XmlNode, ctx: DocContext, out: Segment[], link?: string, deleted = false) {
  const rPr = child(run, "w:rPr");
  const base = {
    bold: toggled(rPr, "w:b"),
    italic: toggled(rPr, "w:i"),
    strike: toggled(rPr, "w:strike") || toggled(rPr, "w:dstrike"),
    ...(link ? { link } : {}),
  };
  const push = (text: string) => out.push({ text, ...base });
  const visit = (node: XmlNode) => {
    for (const c of elements(node)) {
      switch (c.name) {
        case "w:t":
          push(textOf(c));
          break;
        case "w:delText":
          if (deleted) push(textOf(c));
          break;
        case "w:footnoteReference":
        case "w:endnoteReference": {
          const kind = c.name === "w:footnoteReference" ? "f" : "e";
          out.push(rawSegment(noteMarker(ctx, `${kind}${c.attrs["w:id"] ?? ""}`)));
          break;
        }
        case "w:commentReference":
          out.push(rawSegment(commentMarker(ctx, c.attrs["w:id"] ?? "")));
          break;
        case "w:tab":
        case "w:ptab":
          push("\t");
          break;
        case "w:br":
          // Sayfa sonu metinde anlam taşımaz; satır sonu korunur.
          if (c.attrs["w:type"] !== "page") push("\n");
          break;
        case "w:cr":
          push("\n");
          break;
        case "w:noBreakHyphen":
          push("-");
          break;
        case "w:drawing":
        case "w:pict":
        case "w:object": {
          // Metin kutusu da bir çizimdir; şablonlarda teklif no ve tarih çoğu kez buradadır.
          const boxes = findAll(c, "w:txbxContent");
          if (boxes.length > 0) {
            for (const box of boxes) {
              for (const para of findAll(box, "w:p")) {
                const inner: Segment[] = [];
                collectInline(para, ctx, inner);
                const text = renderSegments(inner).trim();
                if (text) push(`\n${text}`);
              }
            }
            break;
          }
          const doc = findDeep(c, "wp:docPr");
          const label = doc?.attrs.descr || doc?.attrs.title || doc?.attrs.name;
          push(label ? `[${ctx.imageLabel}: ${label}]` : `[${ctx.imageLabel}]`);
          break;
        }
        case "mc:AlternateContent": {
          // Aynı içerik Choice ve Fallback'te iki kez durur; yalnız ilk seçenek okunur.
          const choice = child(c, "mc:Choice") ?? child(c, "mc:Fallback");
          if (choice) visit(choice);
          break;
        }
      }
    }
  };
  visit(run);
}

function collectInline(
  node: XmlNode,
  ctx: DocContext,
  out: Segment[],
  link?: string,
  deleted = false,
) {
  for (const c of elements(node)) {
    switch (c.name) {
      case "w:r":
        collectRun(c, ctx, out, link, deleted);
        break;
      case "w:ins":
      case "w:moveTo":
      case "w:del":
      case "w:moveFrom": {
        const removal = c.name === "w:del" || c.name === "w:moveFrom";
        const inner: Segment[] = [];
        collectInline(c, ctx, inner, link, deleted || removal);
        if (!inner.some((x) => x.text)) break;
        if (removal) ctx.stats.deletions++;
        else ctx.stats.insertions++;
        out.push(
          rawSegment(removal ? "{--" : "{++"),
          ...inner,
          rawSegment(removal ? "--}" : "++}"),
        );
        break;
      }
      case "w:commentRangeStart": {
        const id = c.attrs["w:id"] ?? "";
        if (ctx.comments.has(id)) {
          ctx.openComments.add(id);
          out.push(rawSegment("{=="));
        }
        break;
      }
      case "w:commentRangeEnd": {
        const id = c.attrs["w:id"] ?? "";
        if (ctx.openComments.delete(id)) out.push(rawSegment(`==}${commentMarker(ctx, id)}`));
        break;
      }
      case "w:hyperlink": {
        const id = c.attrs["r:id"];
        const target = id
          ? ctx.rels.get(id)
          : c.attrs["w:anchor"]
            ? `#${c.attrs["w:anchor"]}`
            : undefined;
        collectInline(c, ctx, out, target ?? link, deleted);
        break;
      }
      case "w:pPr":
        break;
      default:
        // w:smartTag, w:fldSimple, w:sdt/w:sdtContent, w:customXml
        collectInline(c, ctx, out, link, deleted);
    }
  }
}

function renderSegments(segments: Segment[]): string {
  const merged: Segment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      !last.raw &&
      !s.raw &&
      last.bold === s.bold &&
      last.italic === s.italic &&
      last.strike === s.strike &&
      last.link === s.link
    ) {
      last.text += s.text;
    } else {
      merged.push({ ...s });
    }
  }
  return merged
    .map((s) => {
      if (s.raw) return s.text;
      // İşaretler boşluğun içine alınırsa Markdown vurguyu tanımaz: "** kalın**".
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
      const lead = match?.[1] ?? "";
      let core = match?.[2] ?? s.text;
      const trail = match?.[3] ?? "";
      if (!core) return s.text;
      if (s.strike) core = `~~${core}~~`;
      if (s.italic) core = `*${core}*`;
      if (s.bold) core = `**${core}**`;
      if (s.link) core = `[${core}](${s.link})`;
      return `${lead}${core}${trail}`;
    })
    .join("");
}

// ─── Bloklar ───────────────────────────────────────────────────────────────────────────────────

type Block = { kind: "text"; text: string } | { kind: "list"; text: string };

function paragraphBlock(p: XmlNode, ctx: DocContext): Block | undefined {
  const pPr = child(p, "w:pPr");
  const segments: Segment[] = [];
  collectInline(p, ctx, segments);
  const text = renderSegments(segments).trim();
  if (!text) return undefined;

  const level = headingLevel(ctx, pPr);
  if (level)
    return { kind: "text", text: `${"#".repeat(level)} ${text.replace(/\s*\n\s*/g, " ")}` };

  const numPr = child(pPr, "w:numPr");
  const styleId = child(pPr, "w:pStyle")?.attrs["w:val"];
  const numId =
    child(numPr, "w:numId")?.attrs["w:val"] ?? styleLookup(ctx, styleId, (s) => s.numId);
  const ilvlRaw = child(numPr, "w:ilvl")?.attrs["w:val"];
  const ilvl =
    ilvlRaw !== undefined ? Number(ilvlRaw) : (styleLookup(ctx, styleId, (s) => s.ilvl) ?? 0);
  if (numId && numId !== "0") {
    const ordered = ctx.numbering.get(numId)?.get(ilvl) ?? false;
    // Alt düzey sayaçları üst düzey ilerleyince sıfırlanır (Word'ün davranışı).
    for (const key of ctx.counters.keys()) {
      const [id, lvl] = key.split(":");
      if (id === numId && Number(lvl) > ilvl) ctx.counters.delete(key);
    }
    const key = `${numId}:${ilvl}`;
    const n = (ctx.counters.get(key) ?? 0) + 1;
    ctx.counters.set(key, n);
    const marker = ordered ? `${n}.` : "-";
    const indent = "  ".repeat(Math.max(0, ilvl));
    return { kind: "list", text: `${indent}${marker} ${text.replace(/\n/g, `\n${indent}  `)}` };
  }
  return { kind: "text", text };
}

function cellText(cell: XmlNode, ctx: DocContext): string {
  const parts: string[] = [];
  const visit = (node: XmlNode) => {
    for (const c of elements(node)) {
      if (c.name === "w:p") {
        const segments: Segment[] = [];
        collectInline(c, ctx, segments);
        const text = renderSegments(segments).trim();
        if (text) parts.push(text);
      } else if (c.name !== "w:tcPr") {
        // İç içe tablo ve içerik denetimleri düz metne iner.
        visit(c);
      }
    }
  };
  visit(cell);
  return parts.join("<br>").replace(/\n/g, "<br>").replace(/\|/g, "\\|");
}

function tableBlock(tbl: XmlNode, ctx: DocContext): Block | undefined {
  const rows: string[][] = [];
  for (const tr of elements(tbl)) {
    if (tr.name !== "w:tr") continue;
    const row: string[] = [];
    for (const tc of elements(tr)) {
      if (tc.name !== "w:tc") continue;
      row.push(cellText(tc, ctx));
      const span = Number(child(child(tc, "w:tcPr"), "w:gridSpan")?.attrs["w:val"] ?? 1);
      for (let i = 1; i < span; i++) row.push("");
    }
    if (row.length > 0) rows.push(row);
  }
  if (rows.length === 0) return undefined;
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  const text = [
    line(head ?? []),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
  return { kind: "text", text };
}

function bodyBlocks(node: XmlNode, ctx: DocContext, out: Block[]) {
  for (const c of elements(node)) {
    if (c.name === "w:p") {
      const block = paragraphBlock(c, ctx);
      if (block) out.push(block);
    } else if (c.name === "w:tbl") {
      const block = tableBlock(c, ctx);
      if (block) out.push(block);
    } else if (c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") {
      bodyBlocks(c, ctx, out);
    }
  }
}

function joinBlocks(blocks: Block[]): string {
  let markdown = "";
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (prev) markdown += prev.kind === "list" && b.kind === "list" ? "\n" : "\n\n";
    markdown += b.text;
  });
  return markdown;
}

/** Yorum, dipnot gibi kısa parçaların düz metni (tek satır). */
function inlineText(node: XmlNode, ctx: DocContext): string {
  return findAll(node, "w:p")
    .map((p) => {
      const segments: Segment[] = [];
      collectInline(p, ctx, segments);
      return renderSegments(segments).trim();
    })
    .filter(Boolean)
    .join(" ");
}

export interface DocxConversion {
  markdown: string;
  insertions: number;
  deletions: number;
  comments: number;
}

/**
 * .docx baytlarını Markdown'a çevirir. Liste öğeleri tek satır sonuyla, diğer bloklar boş
 * satırla ayrılır; üst bilgi başa, alt bilgi ve not metinleri sona eklenir. Paket bozuksa ya da
 * Word belgesi değilse okunur bir hata fırlatır.
 */
export function convertDocx(bytes: Uint8Array, lang: Locale = "tr"): DocxConversion {
  const d = dict(lang);
  const zip = openPackage(bytes, d);
  const load = (name: string) => {
    const text = zip.readText(name);
    return text === undefined ? undefined : parseXml(text);
  };
  const document = load("word/document.xml");
  const body = document ? findDeep(document, "w:body") : undefined;
  if (!body) throw new DocxError(d.docx.noBody);
  const relsRoot = load(relsPathOf("word/document.xml"));
  const relations = relsRoot ? elements(child(relsRoot, "Relationships") ?? relsRoot) : [];
  const partsOf = (type: string) =>
    relations
      .filter((r) => r.attrs.Type?.endsWith(`/${type}`) && r.attrs.TargetMode !== "External")
      .map((r) => resolvePart("word/document.xml", r.attrs.Target ?? ""));

  const ctx: DocContext = {
    styles: readStyles(load("word/styles.xml")),
    numbering: readNumbering(load("word/numbering.xml")),
    rels: readRels(relsRoot),
    counters: new Map(),
    imageLabel: d.docx.image,
    comments: new Map(),
    openComments: new Set(),
    shownComments: new Set(),
    notes: new Map(),
    noteTexts: new Map(),
    stats: { insertions: 0, deletions: 0 },
  };
  for (const part of partsOf("comments")) {
    const root = load(part);
    for (const c of root ? findAll(root, "w:comment") : []) {
      const text = inlineText(c, ctx);
      const author = c.attrs["w:author"];
      if (c.attrs["w:id"] !== undefined && text) {
        ctx.comments.set(c.attrs["w:id"], author ? `${author}: ${text}` : text);
      }
    }
  }
  for (const [type, tag, prefix] of [
    ["footnotes", "w:footnote", "f"],
    ["endnotes", "w:endnote", "e"],
  ] as const) {
    for (const part of partsOf(type)) {
      const root = load(part);
      for (const note of root ? findAll(root, tag) : []) {
        // Ayraç notları (`separator`, `continuationSeparator`) içerik değildir.
        if (note.attrs["w:type"] && note.attrs["w:type"] !== "normal") continue;
        ctx.noteTexts.set(`${prefix}${note.attrs["w:id"] ?? ""}`, inlineText(note, ctx));
      }
    }
  }

  // Üst/alt bilgi: bölüm başına ilk/çift/varsayılan sürümler çoğu kez aynıdır; metin bir kez yazılır.
  const band = (type: "header" | "footer") => {
    const seen = new Set<string>();
    for (const part of partsOf(type)) {
      const root = load(part);
      const blocks: Block[] = [];
      if (root) bodyBlocks(child(root, type === "header" ? "w:hdr" : "w:ftr") ?? root, ctx, blocks);
      const text = blocks.map((b) => b.text.replace(/\n+/g, " ")).join(" · ");
      if (text) seen.add(text);
    }
    return [...seen].join(" · ");
  };
  const header = band("header");
  const blocks: Block[] = [];
  bodyBlocks(body, ctx, blocks);
  const footer = band("footer");

  const parts: string[] = [];
  if (header) parts.push(`**${d.docx.headerBand}:** ${header}`);
  const main = joinBlocks(blocks);
  if (main) parts.push(main);
  if (footer) parts.push(`**${d.docx.footerBand}:** ${footer}`);
  const notes = [...ctx.notes].map(([key, n]) => `[^${n}]: ${ctx.noteTexts.get(key) ?? ""}`);
  if (notes.length > 0) parts.push(notes.join("\n"));
  return {
    markdown: parts.join("\n\n"),
    insertions: ctx.stats.insertions,
    deletions: ctx.stats.deletions,
    comments: ctx.comments.size,
  };
}

export function docxToMarkdown(bytes: Uint8Array, lang: Locale = "tr"): string {
  return convertDocx(bytes, lang).markdown;
}

export interface DocxReadOptions {
  lang?: Locale;
  /** 1 tabanlı başlangıç satırı (çevrilmiş Markdown'da). */
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
}

/**
 * `read` sonucu: başlık satırı + Markdown. `offset`/`limit` çevrilmiş satırlara uygulanır, Pi'nin
 * metin dosyası sınırlarıyla kesilir ve devam için sonraki offset söylenir.
 */
export async function readDocxContent(
  path: string,
  options: DocxReadOptions,
): Promise<TextContent[]> {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const converted = convertDocx(await readFile(path), lang);
  const { markdown } = converted;
  const lines = markdown.split("\n");
  const total = lines.length;
  let header = fill(d.docx.header, { name: basename(path), lines: total });
  if (converted.insertions + converted.deletions > 0) {
    header += `\n${fill(d.docx.revisions, { ins: converted.insertions, del: converted.deletions })}`;
  }
  if (converted.comments > 0) header += `\n${fill(d.docx.comments, { n: converted.comments })}`;
  if (!markdown.trim()) return [{ type: "text", text: `${header}\n\n${d.docx.empty}` }];

  const start = Math.max(1, Math.floor(options.offset ?? 1));
  if (start > total) throw new DocxError(fill(d.docx.offsetOutOfRange, { asked: start, total }));
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
  if (last < total) text += `\n\n${fill(d.docx.more, { shown: last, total, next: last + 1 })}`;
  return [{ type: "text", text }];
}
