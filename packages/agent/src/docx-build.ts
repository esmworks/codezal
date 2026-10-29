import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { expandPath } from "./resources.js";

/**
 * Markdown → Word. Model kütüphaneyi bilmez; Markdown yazar, Word'ün tuzakları burada bir kez
 * çözülür: sayfa ölçüsü açıkça verilir, madde işareti elle yazılmaz (numaralandırma tanımı),
 * tablo hem tablo hem hücre genişliğini DXA ile taşır (yüzde Google Docs'ta bozulur), gölge
 * `CLEAR` (SOLID siyah basar), satır sonu `\n` değil ayrı run/paragraf, görsel en-boy oranı
 * dosya başlığından okunur.
 *
 * Desteklenen Markdown: başlık (#–######), paragraf, kalın/italik/üstü çizili/satır içi kod,
 * bağlantı, madde ve numaralı liste (iç içe), GFM tablo (hizalamayla), alıntı, kod bloğu, yatay
 * çizgi, tek satırlık görsel `![alt](yol)`, `<br>` ve tek başına `<pagebreak>` satırı.
 */

// ─── Ölçüler (twip: 1/1440 inç; 1 px = 15 twip, 96 dpi) ──────────────────────────────────────────

const PAGE = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
} as const;
const MARGIN = 1134; // 2 cm
const TWIP_PER_PX = 15;
const BODY_FONT = "Calibri";
const CODE_FONT = "Courier New";
const RULE_COLOR = "BFBFBF";
const BULLETS = ["•", "◦", "▪"] as const;
const NUMBER_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];

export type DocxPageSize = keyof typeof PAGE;

// ─── Markdown blokları ─────────────────────────────────────────────────────────────────────────

type Align = "left" | "center" | "right" | undefined;

interface ListItem {
  level: number;
  ordered: boolean;
  text: string;
}

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: ListItem[] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "image"; alt: string; src: string }
  | { kind: "rule" }
  | { kind: "pagebreak" };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s{0,3}(```+|~~~+)/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const PAGEBREAK = /^\s*(?:<pagebreak\s*\/?>|\\pagebreak|\\newpage)\s*$/i;
const IMAGE = /^\s*!\[([^\]]*)\]\(\s*<?([^)>]+?)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentWidth = (s: string) => s.replace(/\t/g, "    ").length;

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Paragraf satırları: sonunda iki boşluk ya da `\` olan satır sert satır sonudur. */
function joinParagraph(lines: string[]): string {
  return lines
    .map((line, i) => {
      if (i === lines.length - 1) return line.trim();
      if (/(?: {2,}|\\)$/.test(line)) return `${line.replace(/(?: {2,}|\\)$/, "").trim()}<br>`;
      return `${line.trim()} `;
    })
    .join("");
}

export function parseMarkdown(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  const startsBlock = (line: string, next: string | undefined) =>
    HEADING.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    PAGEBREAK.test(line) ||
    IMAGE.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-"));

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // kapanış çiti (yoksa belge sonu)
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (PAGEBREAK.test(line)) {
      blocks.push({ kind: "pagebreak" });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const image = IMAGE.exec(line);
    if (image) {
      blocks.push({ kind: "image", alt: image[1] ?? "", src: (image[2] ?? "").trim() });
      i++;
      continue;
    }
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      const header = splitRow(line);
      const align: Align[] = splitRow(next).map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
            ? "right"
            : c.startsWith(":")
              ? "left"
              : undefined,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      // Girinti yığını: 2 ya da 4 boşlukla iç içe yazılan listeler aynı düzeylere iner.
      const indents: number[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const item = LIST_ITEM.exec(current);
        if (item) {
          const width = indentWidth(item[1] ?? "");
          while (indents.length > 0 && width < (indents[indents.length - 1] ?? 0)) indents.pop();
          if (indents.length === 0 || width > (indents[indents.length - 1] ?? 0))
            indents.push(width);
          items.push({
            level: Math.min(8, indents.length - 1),
            ordered: /\d/.test(item[2] ?? ""),
            text: item[3] ?? "",
          });
          i++;
          continue;
        }
        if (!current.trim()) {
          // Boş satırdan sonra liste sürüyorsa (gevşek liste) aynı blokta kalınır.
          let j = i + 1;
          while (j < lines.length && !(lines[j] ?? "").trim()) j++;
          if (j < lines.length && LIST_ITEM.test(lines[j] ?? "")) {
            i = j;
            continue;
          }
          break;
        }
        const last = items[items.length - 1];
        if (last && /^\s+/.test(current) && !startsBlock(current.trim(), undefined)) {
          last.text += ` ${current.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? "");
        if (!q) break;
        quoted.push(q[1] ?? "");
        i++;
      }
      blocks.push({ kind: "quote", text: joinParagraph(quoted) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (!current.trim() || (para.length > 0 && startsBlock(current, lines[i + 1]))) break;
      para.push(current);
      i++;
    }
    blocks.push({ kind: "paragraph", text: joinParagraph(para) });
  }
  return blocks;
}

// ─── Satır içi ─────────────────────────────────────────────────────────────────────────────────

interface Fmt {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

export interface InlineRun extends Fmt {
  text: string;
  lineBreak?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

export function parseInline(src: string, fmt: Fmt = {}): InlineRun[] {
  const out: InlineRun[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, ...fmt });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const escaped = /^\\([\\`*_~[\]()#+\-.!|<>])/.exec(rest);
    if (escaped) {
      buf += escaped[1];
      i += escaped[0].length;
      continue;
    }
    const lineBreak = /^<br\s*\/?>/i.exec(rest);
    if (lineBreak) {
      flush();
      out.push({ text: "", ...fmt, lineBreak: true });
      i += lineBreak[0].length;
      continue;
    }
    const code = /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      flush();
      out.push({ text: code[2] ?? "", ...fmt, code: true });
      i += code[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      flush();
      out.push(...parseInline(link[1] ?? "", { ...fmt, link: link[2] ?? "" }));
      i += link[0].length;
      continue;
    }
    // `(?![*_])`: `**b *c***` iç italiği kapatmadan erken bitmesin.
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1(?![*_])/.exec(rest);
    if (bold && boundary(src, i, bold)) {
      flush();
      out.push(...parseInline(bold[2] ?? "", { ...fmt, bold: true }));
      i += bold[0].length;
      continue;
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      flush();
      out.push(...parseInline(strike[1] ?? "", { ...fmt, strike: true }));
      i += strike[0].length;
      continue;
    }
    const italic = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1/.exec(rest);
    if (italic && boundary(src, i, italic)) {
      flush();
      out.push(...parseInline(italic[2] ?? "", { ...fmt, italic: true }));
      i += italic[0].length;
      continue;
    }
    buf += src[i];
    i++;
  }
  flush();
  return out;
}

/** `_` vurgusu kelime içinde açılıp kapanmaz: `dosya_adi_v2` düz metindir. */
function boundary(src: string, at: number, m: RegExpExecArray): boolean {
  if (!m[0].startsWith("_")) return true;
  const before = src[at - 1];
  const after = src[at + m[0].length];
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after));
}

const isExternal = (url: string) => /^(https?:|mailto:|tel:)/i.test(url);

function inlineChildren(text: string): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const run of parseInline(text)) {
    const options = {
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italics: true } : {}),
      ...(run.strike ? { strike: true } : {}),
      ...(run.code ? { font: CODE_FONT } : {}),
    };
    if (run.lineBreak) {
      children.push(new TextRun({ break: 1 }));
      continue;
    }
    if (run.link && isExternal(run.link)) {
      children.push(
        new ExternalHyperlink({
          link: run.link,
          children: [new TextRun({ text: run.text, style: "Hyperlink", ...options })],
        }),
      );
      continue;
    }
    children.push(new TextRun({ text: run.text, ...options }));
  }
  return children;
}

// ─── Görsel ────────────────────────────────────────────────────────────────────────────────────

type ImageType = "png" | "jpg" | "gif" | "bmp";

/** Görsel türü ve piksel boyutu dosya başlığından; desteklenmeyen tür `undefined`. */
export function imageInfo(
  buf: Buffer,
): { type: ImageType; width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { type: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 26 && buf.toString("ascii", 0, 2) === "BM") {
    return { type: "bmp", width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = buf[p + 1] ?? 0;
      // SOF0–SOF15 (DHT C4, JPG C8, DAC CC hariç) boyutu taşır.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpg", height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  return undefined;
}

// ─── Belge ─────────────────────────────────────────────────────────────────────────────────────

export interface DocxBuildOptions {
  /** Göreli görsel yolları bu klasöre göre çözülür (belgenin klasörü). */
  baseDir: string;
  pageSize: DocxPageSize;
  landscape: boolean;
  title?: string;
  pageNumbers: boolean;
  lang?: Locale;
}

export interface DocxBuildResult {
  bytes: Buffer;
  headings: number;
  tables: number;
  images: number;
  warnings: string[];
}

const border = (size: number) => ({ style: BorderStyle.SINGLE, size, color: RULE_COLOR });

/** Sütun genişliği içerik uzunluğuyla orantılı, en dar sütun da okunur kalır; toplam tam tutar. */
export function columnWidths(
  header: string[],
  rows: string[][],
  columns: number,
  total: number,
): number[] {
  const weights = Array.from({ length: columns }, (_, c) => {
    const longest = Math.max(
      ...[header, ...rows].map((r) => (r[c] ?? "").replace(/[*_`~]|<br>/g, "").length),
    );
    return Math.min(40, Math.max(4, longest));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((total * w) / sum));
  const rest = total - widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] = (widths[widths.length - 1] ?? 0) + rest;
  return widths;
}

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
} as const;

export async function markdownToDocx(
  markdown: string,
  options: DocxBuildOptions,
): Promise<DocxBuildResult> {
  const d = dict(options.lang ?? "tr");
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const page = PAGE[options.pageSize];
  // Yatayda da dikey ölçü verilir; kütüphane yönü görünce en ve boyu kendisi değiştirir.
  const contentWidth = (options.landscape ? page.height : page.width) - 2 * MARGIN;
  const contentHeight = (options.landscape ? page.width : page.height) - 2 * MARGIN;
  const warnings: string[] = [];
  let headings = 0;
  let tables = 0;
  let images = 0;
  let listInstance = 0;
  let firstHeading: string | undefined;

  const children: (Paragraph | Table)[] = [];
  for (const block of parseMarkdown(markdown)) {
    switch (block.kind) {
      case "heading": {
        headings++;
        firstHeading ??= parseInline(block.text)
          .map((r) => r.text)
          .join("");
        const level =
          [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
            HeadingLevel.HEADING_5,
            HeadingLevel.HEADING_6,
          ][block.level - 1] ?? HeadingLevel.HEADING_6;
        children.push(new Paragraph({ heading: level, children: inlineChildren(block.text) }));
        break;
      }
      case "paragraph":
        children.push(new Paragraph({ children: inlineChildren(block.text) }));
        break;
      case "list": {
        // Her numaralı liste kendi örneğini alır: ikinci liste 1'den başlar, öncekinden sürmez.
        listInstance++;
        for (const item of block.items) {
          children.push(
            new Paragraph({
              numbering: {
                reference: item.ordered ? "codezal-number" : "codezal-bullet",
                level: item.level,
                instance: listInstance,
              },
              children: inlineChildren(item.text),
            }),
          );
        }
        break;
      }
      case "code":
        for (const line of block.lines.length > 0 ? block.lines : [""]) {
          children.push(
            new Paragraph({
              spacing: { before: 0, after: 0 },
              shading: { type: ShadingType.CLEAR, color: "auto", fill: "F5F5F5" },
              children: [new TextRun({ text: line, font: CODE_FONT, size: 20 })],
            }),
          );
        }
        break;
      case "quote":
        children.push(
          new Paragraph({
            indent: { left: 567 },
            border: { left: { ...border(12), space: 8 } },
            children: inlineChildren(block.text),
          }),
        );
        break;
      case "rule":
        children.push(new Paragraph({ border: { bottom: { ...border(6), space: 1 } } }));
        break;
      case "pagebreak":
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case "image": {
        const src = block.src.startsWith("~")
          ? expandPath(block.src)
          : isAbsolute(block.src)
            ? block.src
            : resolve(options.baseDir, block.src);
        const placeholder = () =>
          children.push(
            new Paragraph({
              children: [new TextRun({ text: `[${block.alt || block.src}]`, italics: true })],
            }),
          );
        if (/^https?:/i.test(block.src)) {
          warnings.push(fill(d.docx.imageRemote, { src: block.src }));
          placeholder();
          break;
        }
        let data: Buffer;
        try {
          data = readFileSync(src);
        } catch {
          warnings.push(fill(d.docx.imageMissing, { src: block.src }));
          placeholder();
          break;
        }
        const info = imageInfo(data);
        if (!info || info.width <= 0 || info.height <= 0) {
          warnings.push(fill(d.docx.imageUnsupported, { src: block.src }));
          placeholder();
          break;
        }
        const maxW = contentWidth / TWIP_PER_PX;
        const maxH = (contentHeight * 0.8) / TWIP_PER_PX;
        const scale = Math.min(1, maxW / info.width, maxH / info.height);
        images++;
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: info.type,
                data,
                transformation: {
                  width: Math.round(info.width * scale),
                  height: Math.round(info.height * scale),
                },
                altText: { name: block.alt || "image", description: block.alt, title: block.alt },
              }),
            ],
          }),
        );
        break;
      }
      case "table": {
        tables++;
        const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length));
        const widths = columnWidths(block.header, block.rows, columns, contentWidth);
        const row = (cells: string[], header: boolean) =>
          new TableRow({
            tableHeader: header,
            children: widths.map(
              (width, c) =>
                new TableCell({
                  width: { size: width, type: WidthType.DXA },
                  margins: { top: 60, bottom: 60, left: 100, right: 100 },
                  ...(header
                    ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } }
                    : {}),
                  children: [
                    new Paragraph({
                      spacing: { before: 0, after: 0 },
                      ...(block.align[c] ? { alignment: ALIGN[block.align[c]] } : {}),
                      children: inlineChildren(header ? `**${cells[c] ?? ""}**` : (cells[c] ?? "")),
                    }),
                  ],
                }),
            ),
          });
        children.push(
          new Table({
            width: { size: contentWidth, type: WidthType.DXA },
            columnWidths: widths,
            borders: {
              top: border(4),
              bottom: border(4),
              left: border(4),
              right: border(4),
              insideHorizontal: border(4),
              insideVertical: border(4),
            },
            rows: [row(block.header, true), ...block.rows.map((r) => row(r, false))],
          }),
        );
        // Ardışık iki tablo Word'de birleşir; araya boş paragraf girer.
        children.push(new Paragraph({ spacing: { before: 0, after: 0 } }));
        break;
      }
    }
  }
  if (children.length === 0) children.push(new Paragraph({}));

  const heading = (size: number, before: number) => ({
    run: { font: BODY_FONT, size, bold: true, color: "1F1F1F" },
    paragraph: { spacing: { before, after: 120 }, keepNext: true },
  });
  const title = options.title?.trim() || firstHeading;
  const doc = new Document({
    creator: "Codezal",
    ...(title ? { title } : {}),
    styles: {
      default: {
        document: {
          run: {
            font: BODY_FONT,
            size: 22,
            language: { value: (options.lang ?? "tr") === "tr" ? "tr-TR" : "en-US" },
          },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
        heading1: heading(32, 360),
        heading2: heading(26, 280),
        heading3: heading(24, 240),
        heading4: heading(22, 200),
        heading5: heading(22, 200),
        heading6: heading(22, 200),
        hyperlink: { run: { color: "0563C1", underline: {} } },
      },
    },
    numbering: {
      config: [
        {
          reference: "codezal-bullet",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: BULLETS[level % BULLETS.length] ?? "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
        {
          reference: "codezal-number",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: NUMBER_FORMATS[level % NUMBER_FORMATS.length] ?? LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: page.width,
              height: page.height,
              ...(options.landscape ? { orientation: PageOrientation.LANDSCAPE } : {}),
            },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          },
        },
        ...(options.pageNumbers
          ? {
              footers: {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080" }),
                      ],
                    }),
                  ],
                }),
              },
            }
          : {}),
        children,
      },
    ],
  });
  const bytes = await Packer.toBuffer(doc);
  return { bytes, headings, tables, images, warnings };
}
