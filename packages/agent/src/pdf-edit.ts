import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import fontkit from "@pdf-lib/fontkit";
import {
  degrees,
  EncryptedPDFError,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { expandReadPath } from "./read-path.js";
import { expandPath } from "./resources.js";

/**
 * Var olan PDF'ler üzerinde sayfa ve form işlemleri (`pdf_edit`). Üretim `pdf_create`'te
 * (Chromium); burada `pdf-lib` ile yalnız yapı değişir: birleştir, böl, döndür, sayfa sil/çıkar,
 * filigran, AcroForm doldur. Şifreleme ve OCR kapsam dışı: pdf-lib şifreli PDF açamaz ve yazamaz,
 * taranmış sayfa zaten `read` ile görüntü olarak modele gider.
 */

export const PDF_EDIT_ACTIONS = [
  "merge",
  "split",
  "rotate",
  "delete_pages",
  "extract_pages",
  "watermark",
  "fill_form",
  "list_fields",
] as const;

export type PdfEditAction = (typeof PDF_EDIT_ACTIONS)[number];

export interface PdfFieldValue {
  name: string;
  value: string | boolean;
}

export interface PdfEditInput {
  action: PdfEditAction;
  /** Ana girdi; `merge`'te ilk dosya. */
  path: string;
  /** `merge`: `path`'in ardına sırayla eklenecek dosyalar. */
  inputs?: string[];
  output?: string;
  pages?: string;
  ranges?: string[];
  angle?: number;
  text?: string;
  opacity?: number;
  size?: number;
  color?: string;
  fields?: PdfFieldValue[];
  flatten?: boolean;
}

export class PdfEditError extends Error {}

/** Tek çağrıda en çok bu kadar girdi birleşir ve en çok bu kadar parçaya bölünür. */
const MAX_INPUTS = 50;
const MAX_PARTS = 100;
/** Varsayılan çıktı adı doluysa `-2`, `-3`… denenir; bu kadar denemede boş ad yoksa hata. */
const MAX_NAME_TRIES = 100;

/**
 * Varsayılan çıktı adının eki. Hedef yol izin kapısında, tur yedeğinde ve araçta aynı çözülmeli;
 * bunlar dil bilmediği için ek sabit ve İngilizce tutuldu (dil seçimiyle dosya adı değişmesin).
 */
const SUFFIX: Record<Exclude<PdfEditAction, "list_fields" | "split">, string> = {
  merge: "merged",
  rotate: "rotated",
  delete_pages: "trimmed",
  extract_pages: "extract",
  watermark: "watermarked",
  fill_form: "filled",
};

/**
 * Unicode yazı tipi adayları: pdf-lib'in standart yazı tipleri yalnız WinAnsi basar (ş, ğ, ı, İ
 * yok), filigran ve form değeri için bir TTF gömülür. Depoda yazı tipi taşınmıyor; işletim
 * sisteminin kendi yazı tipi kullanılır. Yalnız düz .ttf (TTC koleksiyonu fontkit'te alt kümelenmiyor).
 * Arial Unicode büyük (23 MB) ama alt kümelendiği için PDF'e yalnız kullanılan glifler girer.
 */
export const PDF_FONT_CANDIDATES: readonly string[] = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/Library/Fonts/Arial.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];

/** Var olan ilk aday; yoksa `undefined` (araç WinAnsi'ye sığan metinde Helvetica'ya düşer). */
export function resolvePdfFont(
  candidates: readonly string[] = PDF_FONT_CANDIDATES,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return candidates.find((path) => exists(path));
}

export interface PdfEditTargets {
  /** Ana girdi (`path`). */
  source: string;
  /** Okunan bütün girdiler; `merge`'te `path` + `inputs`, diğerlerinde yalnız `source`. */
  sources: string[];
  /** Yazılacak dosyalar; `list_fields`'ta boş, `split`'te parça başına bir yol. */
  targets: string[];
}

function resolveInputPath(raw: string, cwd: string): string {
  return resolve(expandReadPath(raw.trim(), cwd));
}

/** Açık `output`: göreli ad kaynağın klasörüne göre, `~` ev dizinine; `.pdf` yoksa eklenir. */
function resolveOutputPath(raw: string, source: string, withExt: boolean): string {
  const abs = raw.startsWith("~")
    ? expandPath(raw)
    : isAbsolute(raw)
      ? resolve(raw)
      : resolve(dirname(source), raw);
  if (!withExt) return abs.replace(/\.pdf$/i, "");
  return /\.pdf$/i.test(abs) ? abs : `${abs}.pdf`;
}

function stemOf(source: string): string {
  const ext = extname(source);
  return join(dirname(source), basename(source, ext));
}

/** Kartta gösterilen varsayılan çıktı adı (diske bakmaz); gerçek yol sonuçta `details.path`. */
export function defaultPdfEditName(source: string, action: PdfEditAction, part = 1): string {
  if (action === "list_fields") return source;
  if (action === "split") return `${stemOf(source)}-part-${part}.pdf`;
  return `${stemOf(source)}-${SUFFIX[action]}.pdf`;
}

/**
 * Girdi ve çıktı yolları. Girdi hiçbir zaman örtük olarak üzerine yazılmaz: `output` verilmezse
 * kaynağın yanında ekli bir ad seçilir ve o ad doluysa sıradaki boş ad alınır. Yalnız `output`
 * açıkça girdiyle aynı verilirse girdi değişir. İzin kapısı, tur yedeği ve araç aynı sonucu
 * görsün diye tek yerde çözülür (dosya sistemi araç çalışana dek değişmez).
 */
export function resolvePdfEditTargets(
  input: {
    action?: unknown;
    path: string;
    inputs?: unknown;
    output?: unknown;
    ranges?: unknown;
  },
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): PdfEditTargets {
  const action = PDF_EDIT_ACTIONS.find((a) => a === input.action) ?? "rotate";
  const source = resolveInputPath(input.path, cwd);
  const extra =
    action === "merge" && Array.isArray(input.inputs)
      ? input.inputs.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];
  const sources = [source, ...extra.map((p) => resolveInputPath(p, cwd))];
  if (action === "list_fields") return { source, sources, targets: [] };
  const output = typeof input.output === "string" ? input.output.trim() : "";

  if (action === "split") {
    const count = Array.isArray(input.ranges) ? Math.min(input.ranges.length, MAX_PARTS) : 0;
    const parts = Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1);
    if (output) {
      const base = resolveOutputPath(output, source, false);
      return { source, sources, targets: parts.map((i) => `${base}-${i}.pdf`) };
    }
    const stem = stemOf(source);
    for (let n = 1; n <= MAX_NAME_TRIES; n++) {
      const tag = n === 1 ? "" : `-${n}`;
      const targets = parts.map((i) => `${stem}-part-${i}${tag}.pdf`);
      if (targets.every((t) => !exists(t))) return { source, sources, targets };
    }
    return { source, sources, targets: parts.map((i) => `${stem}-part-${i}.pdf`) };
  }

  if (output) return { source, sources, targets: [resolveOutputPath(output, source, true)] };
  const base = `${stemOf(source)}-${SUFFIX[action]}`;
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const target = n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`;
    if (!exists(target)) return { source, sources, targets: [target] };
  }
  return { source, sources, targets: [`${base}.pdf`] };
}

/**
 * Sayfa aralığı: "1-3, 5, 8-" (1 tabanlı; "8-" sona kadar, "-3" baştan 3'e). Sıra korunur,
 * tekrar eden sayfa bir kez alınır. Geçersiz ya da sayfa sayısını aşan aralık hatadır.
 */
export function parsePageRanges(spec: string, pageCount: number, lang: Locale = "tr"): number[] {
  const d = dict(lang).pdfEdit;
  const out: number[] = [];
  const seen = new Set<number>();
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) throw new PdfEditError(fill(d.badPages, { spec }));
  for (const part of parts) {
    const m = /^(\d*)\s*(?:(-)\s*(\d*))?$/.exec(part);
    if (!m || (m[1] === "" && (m[3] ?? "") === "")) {
      throw new PdfEditError(fill(d.badPages, { spec: part }));
    }
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      throw new PdfEditError(fill(d.pageOutOfRange, { spec: part, count: pageCount }));
    }
    if (from > to) throw new PdfEditError(fill(d.badPages, { spec: part }));
    for (let p = from; p <= to; p++) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p - 1);
    }
  }
  return out;
}

function fill(s: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
}

/** Şifreli PDF'te açık bir Türkçe hata; bozuk dosyada okuyucunun gerekçesi. */
export async function loadPdf(bytes: Uint8Array, path: string, lang: Locale = "tr") {
  const d = dict(lang).pdfEdit;
  try {
    // Üretici/değişiklik tarihi gibi meta veriye dokunulmaz: kullanıcının belgesi olduğu gibi kalsın.
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // pdf-lib ES5'e derlendiği için Error alt sınıflarında `instanceof` güvenilmez; ileti de denenir.
    if (error instanceof EncryptedPDFError || /is encrypted/i.test(reason)) {
      throw new PdfEditError(fill(d.encrypted, { path }));
    }
    throw new PdfEditError(fill(d.unreadable, { path, reason }));
  }
}

/**
 * Metni basabilecek yazı tipi. Unicode TTF verilmişse alt kümelenerek gömülür; yoksa metin
 * WinAnsi'ye sığıyorsa Helvetica kullanılır, sığmıyorsa (ş, ğ, ı…) açık hata. Yazı tipinde glifi
 * olmayan karakter de hatadır: PDF'te sessizce boş kutu çıkmasın.
 */
async function textFont(
  doc: PDFDocument,
  texts: readonly string[],
  fontPath: string | undefined,
  lang: Locale,
): Promise<PDFFont> {
  const d = dict(lang).pdfEdit;
  const chars = new Set<number>();
  for (const t of texts) {
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      // Satır sonu ve sekme glif değildir; tek satırlık filigran/alan için yok sayılır.
      if (cp !== undefined && cp >= 0x20) chars.add(cp);
    }
  }
  if (fontPath) {
    doc.registerFontkit(fontkit);
    let font: PDFFont;
    try {
      font = await doc.embedFont(readFileSync(fontPath), { subset: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PdfEditError(fill(d.fontFailed, { path: fontPath, reason }));
    }
    const available = new Set(font.getCharacterSet());
    const missing = [...chars].filter((cp) => !available.has(cp));
    if (missing.length > 0) {
      throw new PdfEditError(
        fill(d.missingGlyphs, { chars: missing.map((cp) => String.fromCodePoint(cp)).join(" ") }),
      );
    }
    return font;
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  try {
    for (const t of texts) font.encodeText(t);
  } catch {
    throw new PdfEditError(d.noFont);
  }
  return font;
}

function parseColor(raw: string | undefined, lang: Locale) {
  if (!raw) return rgb(0.5, 0.5, 0.5);
  const m = /^#?([0-9a-f]{6})$/i.exec(raw.trim());
  if (!m?.[1]) throw new PdfEditError(fill(dict(lang).pdfEdit.badColor, { color: raw }));
  const n = Number.parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export interface PdfEditOutput {
  path: string;
  bytes: Uint8Array;
  pages: number;
}

export interface PdfFieldInfo {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "list" | "button" | "signature" | "other";
  value: string | boolean | string[] | undefined;
  options?: string[];
  readOnly: boolean;
}

export type PdfEditResult =
  | { kind: "write"; outputs: PdfEditOutput[]; count: number; total: number }
  | { kind: "fields"; fields: PdfFieldInfo[] };

export interface PdfEditOptions {
  lang?: Locale;
  /** Unicode TTF yolu (filigran ve form değeri için); bkz. `resolvePdfFont`. */
  fontPath?: string;
  /** Dosya okuyucu; testte ve araçta `readFileSync`. */
  read?: (path: string) => Uint8Array;
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  // Alan görünümleri gerekiyorsa işlem kendi yazı tipiyle önceden üretti; pdf-lib'in varsayılanı
  // (Helvetica) Türkçe değerde kodlama hatası verir.
  return doc.save({ updateFieldAppearances: false });
}

async function copyInto(sourceDoc: PDFDocument, indices: number[]): Promise<PDFDocument> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(sourceDoc, indices);
  for (const page of pages) out.addPage(page);
  return out;
}

function fieldType(field: PDFField): PdfFieldInfo["type"] {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFDropdown) return "dropdown";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFOptionList) return "list";
  if (field instanceof PDFButton) return "button";
  if (field instanceof PDFSignature) return "signature";
  return "other";
}

function describeField(field: PDFField): PdfFieldInfo {
  const base = { name: field.getName(), readOnly: field.isReadOnly() };
  if (field instanceof PDFTextField) {
    return { ...base, type: "text", value: field.getText() ?? "" };
  }
  if (field instanceof PDFCheckBox) {
    return { ...base, type: "checkbox", value: field.isChecked() };
  }
  if (field instanceof PDFDropdown) {
    return {
      ...base,
      type: "dropdown",
      value: field.getSelected(),
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFRadioGroup) {
    return { ...base, type: "radio", value: field.getSelected(), options: field.getOptions() };
  }
  if (field instanceof PDFOptionList) {
    return { ...base, type: "list", value: field.getSelected(), options: field.getOptions() };
  }
  return { ...base, type: fieldType(field), value: undefined };
}

const TRUE_WORDS = new Set(["true", "yes", "on", "evet", "x", "1", "checked", "işaretli"]);
const FALSE_WORDS = new Set(["false", "no", "off", "hayır", "hayir", "0", "", "unchecked"]);

function setCheckbox(field: PDFCheckBox, value: string | boolean, lang: Locale): void {
  const d = dict(lang).pdfEdit;
  const word = typeof value === "boolean" ? undefined : value.trim().toLocaleLowerCase("tr");
  const on = value === true || (word !== undefined && TRUE_WORDS.has(word));
  const off = value === false || (word !== undefined && FALSE_WORDS.has(word));
  if (!on && !off) {
    throw new PdfEditError(fill(d.badCheckbox, { name: field.getName(), value: String(value) }));
  }
  if (on) field.check();
  else field.uncheck();
}

function pickOption(name: string, value: string, options: string[], lang: Locale): string {
  const exact = options.find((o) => o === value);
  if (exact !== undefined) return exact;
  const folded = value.toLocaleLowerCase("tr");
  const loose = options.find((o) => o.toLocaleLowerCase("tr") === folded);
  if (loose !== undefined) return loose;
  throw new PdfEditError(
    fill(dict(lang).pdfEdit.badOption, { name, value, options: options.join(", ") || "—" }),
  );
}

async function fillForm(
  doc: PDFDocument,
  input: PdfEditInput,
  options: PdfEditOptions,
  lang: Locale,
): Promise<number> {
  const d = dict(lang).pdfEdit;
  const values = input.fields ?? [];
  if (values.length === 0) throw new PdfEditError(d.fieldsRequired);
  const form = doc.getForm();
  const fields = form.getFields();
  if (fields.length === 0) throw new PdfEditError(d.noForm);
  const byName = new Map(fields.map((f) => [f.getName(), f]));
  const texts: string[] = [];
  for (const { name, value } of values) {
    const field = byName.get(name);
    if (!field) {
      const names = fields.map((f) => f.getName());
      const list = names.slice(0, 40).join(", ") + (names.length > 40 ? ", …" : "");
      throw new PdfEditError(fill(d.fieldNotFound, { name, names: list }));
    }
    if (field.isReadOnly()) throw new PdfEditError(fill(d.fieldReadOnly, { name }));
    texts.push(String(value));
  }
  // Yazı tipi yalnız metin gösteren alanlar için gerekir; önce gömülür ki eksik glif hiçbir
  // alanı değiştirmeden hata versin.
  const font = await textFont(doc, texts, options.fontPath, lang);
  for (const { name, value } of values) {
    const field = byName.get(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) {
        field.setText(typeof value === "boolean" ? (value ? "X" : "") : value);
      } else if (field instanceof PDFCheckBox) {
        setCheckbox(field, value, lang);
      } else if (field instanceof PDFDropdown) {
        const text = String(value);
        // Düzenlenebilir açılır listede listede olmayan değer de yazılabilir.
        field.select(
          field.isEditable() && !field.getOptions().includes(text)
            ? text
            : pickOption(name, text, field.getOptions(), lang),
        );
      } else if (field instanceof PDFRadioGroup) {
        field.select(pickOption(name, String(value), field.getOptions(), lang));
      } else if (field instanceof PDFOptionList) {
        const wanted = String(value)
          .split(/\s*[;\n]\s*/)
          .filter((v) => v !== "")
          .map((v) => pickOption(name, v, field.getOptions(), lang));
        field.select(wanted);
      } else {
        throw new PdfEditError(fill(d.fieldUnsupported, { name, type: fieldType(field) }));
      }
    } catch (error) {
      if (error instanceof PdfEditError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new PdfEditError(fill(d.fieldFailed, { name, reason }));
    }
  }
  if (input.flatten) {
    // Düzleştirmede her alan görünümüyle sayfaya basılır; görünümü olmayan alan kalmasın diye
    // hepsi gömülen yazı tipiyle yeniden üretilir.
    for (const field of fields) form.markFieldAsDirty(field.ref);
    form.updateFieldAppearances(font);
    form.flatten({ updateFieldAppearances: false });
  } else {
    form.updateFieldAppearances(font);
  }
  return values.length;
}

async function watermark(
  doc: PDFDocument,
  input: PdfEditInput,
  options: PdfEditOptions,
  lang: Locale,
): Promise<number> {
  const d = dict(lang).pdfEdit;
  const text = input.text?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) throw new PdfEditError(d.textRequired);
  const opacity = input.opacity ?? 0.2;
  if (!(opacity > 0 && opacity <= 1)) throw new PdfEditError(d.badOpacity);
  const angle = input.angle ?? 45;
  if (!Number.isFinite(angle)) throw new PdfEditError(fill(d.badAngle, { angle: String(angle) }));
  if (input.size !== undefined && !(input.size > 0 && input.size <= 500)) {
    throw new PdfEditError(d.badSize);
  }
  const color = parseColor(input.color, lang);
  const font = await textFont(doc, [text], options.fontPath, lang);
  const indices = input.pages
    ? parsePageRanges(input.pages, doc.getPageCount(), lang)
    : doc.getPageIndices();
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const unitWidth = font.widthOfTextAtSize(text, 1);
  for (const index of indices) {
    const page = doc.getPage(index);
    const box = page.getCropBox();
    // Verilmezse yazı, eğimli hâliyle sayfanın %80'ine sığacak büyüklükte.
    const fit = Math.min(
      Math.abs(cos) > 1e-6 ? (box.width * 0.8) / Math.abs(cos) : Number.POSITIVE_INFINITY,
      Math.abs(sin) > 1e-6 ? (box.height * 0.8) / Math.abs(sin) : Number.POSITIVE_INFINITY,
    );
    const size = input.size ?? Math.max(8, Math.min(120, fit / unitWidth));
    const width = unitWidth * size;
    const height = font.heightAtSize(size, { descender: false });
    // drawText sol alt köşeden döndürür; yazının merkezi sayfanın merkezine gelsin diye köşe
    // döndürülmüş yarım boyut kadar geri çekilir.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    page.drawText(text, {
      x: cx - ((width / 2) * cos - (height / 2) * sin),
      y: cy - ((width / 2) * sin + (height / 2) * cos),
      size,
      font,
      color,
      opacity,
      rotate: degrees(angle),
    });
  }
  return indices.length;
}

/**
 * İşlemi uygular ve yazılacak baytları döndürür; diske yazmaz (araç yazar). Hedef yollar
 * `resolvePdfEditTargets`'tan gelir ki izin kapısı ve tur yedeğiyle aynı olsun.
 */
export async function editPdf(
  input: PdfEditInput,
  targets: PdfEditTargets,
  options: PdfEditOptions = {},
): Promise<PdfEditResult> {
  const lang = options.lang ?? "tr";
  const d = dict(lang).pdfEdit;
  const read = options.read ?? ((path: string) => readFileSync(path));
  const open = async (path: string) => {
    if (!/\.pdf$/i.test(path)) throw new PdfEditError(fill(d.notPdf, { path }));
    if (!existsSync(path)) throw new PdfEditError(fill(d.missing, { path }));
    return loadPdf(read(path), path, lang);
  };
  const [target] = targets.targets;

  if (input.action === "merge") {
    if (targets.sources.length < 2) throw new PdfEditError(d.inputsRequired);
    if (targets.sources.length > MAX_INPUTS) {
      throw new PdfEditError(fill(d.tooManyInputs, { n: MAX_INPUTS }));
    }
    const out = await PDFDocument.create({ updateMetadata: false });
    for (const path of targets.sources) {
      const doc = await open(path);
      const pages = await out.copyPages(doc, doc.getPageIndices());
      for (const page of pages) out.addPage(page);
    }
    if (!target) throw new PdfEditError(d.noTarget);
    const total = out.getPageCount();
    return {
      kind: "write",
      outputs: [{ path: target, bytes: await save(out), pages: total }],
      count: targets.sources.length,
      total,
    };
  }

  const doc = await open(targets.source);
  const pageCount = doc.getPageCount();

  if (input.action === "list_fields") {
    const fields = doc.getForm().getFields().map(describeField);
    return { kind: "fields", fields };
  }

  if (input.action === "split") {
    const ranges = input.ranges ?? [];
    if (ranges.length === 0) throw new PdfEditError(d.rangesRequired);
    if (ranges.length > MAX_PARTS) throw new PdfEditError(fill(d.tooManyParts, { n: MAX_PARTS }));
    const outputs: PdfEditOutput[] = [];
    for (const [i, spec] of ranges.entries()) {
      const path = targets.targets[i];
      if (!path) throw new PdfEditError(d.noTarget);
      if (path === targets.source) throw new PdfEditError(fill(d.outputIsInput, { path }));
      const indices = parsePageRanges(spec, pageCount, lang);
      const part = await copyInto(doc, indices);
      outputs.push({ path, bytes: await save(part), pages: indices.length });
    }
    return { kind: "write", outputs, count: outputs.length, total: pageCount };
  }

  if (!target) throw new PdfEditError(d.noTarget);
  const single = async (out: PDFDocument, count: number): Promise<PdfEditResult> => ({
    kind: "write",
    outputs: [{ path: target, bytes: await save(out), pages: out.getPageCount() }],
    count,
    total: out.getPageCount(),
  });

  switch (input.action) {
    case "rotate": {
      const angle = input.angle ?? 90;
      if (![90, 180, 270, -90].includes(angle)) {
        throw new PdfEditError(fill(d.badRotation, { angle: String(angle) }));
      }
      const indices = input.pages
        ? parsePageRanges(input.pages, pageCount, lang)
        : doc.getPageIndices();
      for (const index of indices) {
        const page = doc.getPage(index);
        const next = (((page.getRotation().angle + angle) % 360) + 360) % 360;
        page.setRotation(degrees(next));
      }
      return single(doc, indices.length);
    }
    case "delete_pages": {
      if (!input.pages?.trim()) throw new PdfEditError(d.pagesRequired);
      const indices = parsePageRanges(input.pages, pageCount, lang);
      if (indices.length >= pageCount) throw new PdfEditError(d.deleteAll);
      // Sondan başa silinir ki kalan dizinler kaymasın.
      for (const index of [...indices].sort((a, b) => b - a)) doc.removePage(index);
      return single(doc, indices.length);
    }
    case "extract_pages": {
      if (!input.pages?.trim()) throw new PdfEditError(d.pagesRequired);
      const indices = parsePageRanges(input.pages, pageCount, lang);
      return single(await copyInto(doc, indices), indices.length);
    }
    case "watermark":
      return single(doc, await watermark(doc, input, options, lang));
    case "fill_form":
      return single(doc, await fillForm(doc, input, options, lang));
  }
}
