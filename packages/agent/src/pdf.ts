import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { dict, type Locale, SOURCE_LOCALE } from "@codezal/i18n";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * PDF okuma: metin katmanı çıkarılır, taranmış ve çizim sayfaları görüntü olarak eklenir.
 *
 * Pi'nin `read` aracı PDF'i tanımaz ve ham baytları utf-8 metin sanar; sessizce çöp döndürür.
 * Bu modül `read` sarmalayıcısından (`read-tool.ts`) çağrılır, böylece modelin ayrı bir araç
 * öğrenmesi gerekmez: PDF'i `read` ile açar, okunur içerik gelir.
 */

/** Tek çağrıda işlenen sayfa; kalanı için model `offset` ile devam eder (Pi'nin metin davranışı). */
const MAX_PAGES = 20;
/** Tek çağrıda gönderilen sayfa görüntüsü. Her görüntü bağlamda pahalı, sınır bilinçli düşük. */
const MAX_IMAGES = 5;
const MAX_CHARS = 60_000;
/** Görüntünün uzun kenarı: taranmış metnin okunur kalması ile bağlam maliyeti arasındaki denge. */
const MAX_SIDE = 1400;
/**
 * Bu kadar karakteri bulmayan sayfa metinsiz sayılır. Eşik bilinçli olarak düşük: taranmış
 * sayfalarda bazen birkaç karakterlik artık metin bulunur, ama gerçekten metin taşıyan bir sayfa
 * bu kadarıyla sınırlı kalmaz. Boş sayfa ile taranmış sayfa ayırt edilmez, ikisi de görüntü olur.
 */
const MIN_TEXT = 4;
/**
 * Çizim sayfası: metin katmanı var ama sayfayı anlatmıyor (şema, plan, grafik). Elektrik pano
 * çizimlerinde metin yüz karakterlik etiketlerden ibarettir; yalnızca metni gönderirsek model
 * çizimi hiç görmez ve kendi başına PDF'i görüntüye çevirmeye çalışır. Bu yüzden az metinli ama
 * çizim taşıyan sayfa hem metin hem görüntü olarak gider.
 */
const DRAWING_MAX_CHARS = 1200;
/** Sayfayı çizim yapan asgari vektör yolu: şemada binlerce, düz metin sayfasında onlarca bulunur. */
const DRAWING_PATHS = 120;
/** Sayfaya basılan bitmap bu kadar pikselden büyükse şekildir; küçüğü logo/simge sayılır. */
const DRAWING_IMAGE_PIXELS = 200_000;

type Pdfjs = typeof import("pdfjs-dist");
type Canvas = typeof import("@napi-rs/canvas");

let pdfjs: Promise<Pdfjs> | undefined;
let canvasKit: Promise<Canvas> | undefined;

/**
 * pdfjs 8 MB, canvas 12 MB yer tutar ve ikisi de yalnızca PDF açılınca gerekir; ilk kullanımda
 * yüklenirler ki uygulama açılışı ağırlaşmasın. Node ortamında `legacy` yapı kullanılır.
 */
const loadPdfjs = (): Promise<Pdfjs> => {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
};

const loadCanvas = (): Promise<Canvas> => {
  canvasKit ??= import("@napi-rs/canvas");
  return canvasKit;
};

/** Yazı tipi, cmap ve wasm varlıkları paketin içinden okunur; verilmezse gömülü yazı tipleri bozulur. */
function assetDirs(): {
  standardFontDataUrl: string;
  cMapUrl: string;
  iccUrl: string;
  wasmUrl: string;
} {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dir = (name: string) => `${join(root, name)}/`;
  return {
    standardFontDataUrl: dir("standard_fonts"),
    cMapUrl: dir("cmaps"),
    iccUrl: dir("iccs"),
    wasmUrl: dir("wasm"),
  };
}

/** Sayfa metni: pdfjs parçaları satır bilgisiyle verir, `hasEOL` olmadan her şey tek satıra yapışır. */
function pageText(items: readonly unknown[]): string {
  let out = "";
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item)) continue;
    const part = item as { str: string; hasEOL?: boolean };
    out += part.str;
    if (part.hasEOL) out += "\n";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PdfReadOptions {
  /** Başlanacak sayfa (1 tabanlı); `read` aracının `offset` değeri buraya gelir. */
  firstPage?: number;
  /** En çok sayfa; `read` aracının `limit` değeri. MAX_PAGES ile sınırlanır. */
  pageLimit?: number;
  /**
   * Her sayfayı metnin yanında görüntü olarak da gönder. Metin ağırlıklı bir çizim (7 bin karakter
   * etiketli pano projesi) çizim eşiğini aşar ve görüntü almaz; model yerleşimi denetlemek için
   * PDF'i terminalde görüntüye çevirmeye kalkıyordu. Görüntü sınırı (MAX_IMAGES) yine geçerlidir.
   */
  render?: boolean;
  /** Model görsel okuyabiliyor mu; okuyamıyorsa sayfa görüntüsü yerine sebebi gönderilir. */
  vision: boolean;
  lang?: Locale;
}

/**
 * PDF'i `read` sonucunun yerine geçecek içeriğe çevirir. Metin katmanı sayfayı anlatan sayfalar
 * metin, anlatmayanlar (taranmış sayfa; etiketten ibaret çizim) görüntü olarak döner; sayfa sırası
 * korunur ki model hangi görüntünün hangi sayfaya ait olduğunu bilsin.
 */
export async function readPdfContent(
  path: string,
  options: PdfReadOptions,
): Promise<(TextContent | ImageContent)[]> {
  return withPdf(path, (doc, lib) => collect(doc, path, options, lib.OPS));
}

/** Belgeyi açar, işi yaptırır ve her durumda kapatır. */
async function withPdf<T>(
  path: string,
  work: (doc: PDFDocumentProxy, lib: Pdfjs) => Promise<T>,
): Promise<T> {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await readFile(path));
  const task = lib.getDocument({ data, ...assetDirs() });
  try {
    return await work(await task.promise, lib);
  } finally {
    // Kapatılmazsa pdfjs sayfa ve yazı tipi önbelleğini tutar; çok PDF okunan oturumda birikir.
    await task.destroy();
  }
}

/** Sayfanın modele nasıl gideceği: yalnızca metin, taranmış görüntü ya da çizim (metin + görüntü). */
type PageKind = "text" | "scanned" | "drawing";

async function collect(
  doc: PDFDocumentProxy,
  path: string,
  options: PdfReadOptions,
  ops: Pdfjs["OPS"],
): Promise<(TextContent | ImageContent)[]> {
  const d = dict(options.lang ?? SOURCE_LOCALE);
  const total = doc.numPages;
  const asked = Math.trunc(options.firstPage ?? 1);
  // `offset` metin dosyalarında satır numarasıdır; model PDF'e aynı alışkanlıkla büyük bir sayı
  // verebiliyor. Sessizce son sayfaya kırpılırsa model "belgenin tamamı bu" diye yanlış sonuca
  // varıyordu; sayfa sayısını aşan değer baştan okumaya çevrilir ve durum nota yazılır.
  const outOfRange = asked > total;
  const from = outOfRange ? 1 : Math.min(Math.max(1, asked), total);
  const span = Math.min(MAX_PAGES, Math.max(1, Math.trunc(options.pageLimit ?? MAX_PAGES)));
  const last = Math.min(total, from + span - 1);

  const content: (TextContent | ImageContent)[] = [];
  const buffer: string[] = [];
  let chars = 0;
  let images = 0;
  let stopped = 0;
  // Metin blokları biriktirilir, görüntüden hemen önce boşaltılır: sıra bozulmadan blok sayısı azalır.
  const flush = () => {
    if (buffer.length === 0) return;
    content.push({ type: "text", text: buffer.join("\n\n") });
    buffer.length = 0;
  };

  for (let n = from; n <= last; n++) {
    if (chars >= MAX_CHARS) {
      stopped = n;
      break;
    }
    const page = await doc.getPage(n);
    const text = pageText((await page.getTextContent()).items);
    const kind = await pageKind(page, text, ops);
    chars += text.length;
    if (kind === "text" && !options.render) {
      buffer.push(`${d.pdf.page.replace("{{page}}", String(n))}\n${text}`);
      continue;
    }
    // Çizimde etiket metni, istek üzerine çevrilen sayfada tam metin de gönderilir: görüntü
    // şekli, metin aranabilir adları taşır.
    const label = kind === "scanned" ? "" : `\n${text}`;
    const shownHead =
      kind === "scanned" ? d.pdf.scanned : kind === "drawing" ? d.pdf.drawing : d.pdf.rendered;
    const skipped =
      kind === "scanned"
        ? d.pdf.scannedSkipped
        : kind === "drawing"
          ? d.pdf.drawingSkipped
          : d.pdf.renderedSkipped;
    if (!options.vision) {
      const head = skipped.replace("{{page}}", String(n)).replace("{{reason}}", d.pdf.noVision);
      buffer.push(`${head}${label}`);
      continue;
    }
    if (images >= MAX_IMAGES) {
      stopped = n;
      break;
    }
    // Görüntüye çevirme yerel bir bağlamaya (canvas) dayanır ve platforma göre bulunamayabilir.
    // Tek sayfa yüzünden okuma çökerse o ana kadar çıkarılan metin de kaybolur; sayfa atlanır.
    let image: ImageContent | undefined;
    try {
      image = await renderPage(page, await loadCanvas());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const head = skipped.replace("{{page}}", String(n)).replace("{{reason}}", () => reason);
      buffer.push(`${head}${label}`);
      continue;
    }
    buffer.push(`${shownHead.replace("{{page}}", String(n))}${label}`);
    flush();
    content.push(image);
    images += 1;
  }
  flush();

  const shown = stopped > 0 ? stopped - 1 : last;
  // Dosya adı `$&` gibi değiştirme desenleri içerebilir; işlev biçimi onları harfi harfine yazar.
  const header = d.pdf.header
    .replace("{{name}}", () => basename(path))
    .replace("{{pages}}", String(total));
  const more =
    shown < total
      ? `\n${d.pdf.more
          .replace("{{shown}}", String(shown))
          .replace("{{total}}", String(total))
          .replace("{{next}}", String(shown + 1))}`
      : "";
  // Sessiz kırpma yok: istenen sayfa belgenin dışındaysa model bunu görür, yanlış sonuca varmaz.
  const notice = outOfRange
    ? `\n${d.pdf.offsetOutOfRange
        .replace("{{asked}}", String(asked))
        .replace("{{total}}", String(total))}`
    : "";
  // Belge bu okumaya sığmıyorsa ilk açılışta yol haritası verilir: yer imleri ve arama. Yoksa
  // model yüzlerce sayfalık bir kataloğu baştan 20'şer sayfa okuyor ya da sayfa tahmin ediyordu.
  // Model ilk okumada çoğu kez `offset: 1` verir; devam okumaları (offset=21…) tekrar almaz.
  const opening = from === 1 && last < total;
  const guide = opening ? await tableOfContents(doc, d) : "";
  const hint = opening ? `\n${d.pdf.searchHint}` : "";
  content.unshift({ type: "text", text: `${header}${notice}${more}${hint}${guide}` });
  return content;
}

/** Gösterilen yer imi derinliği ve sayısı: katalog içindekileri bağlamı doldurmasın. */
const OUTLINE_DEPTH = 3;
const OUTLINE_ENTRIES = 150;
const OUTLINE_TITLE = 120;

/** pdfjs yer imi düğümü; paketin tipi `items`'ı `any[]` bırakır, burada daraltılır. */
interface OutlineNode {
  title: string;
  dest: unknown;
  items: OutlineNode[];
}

/**
 * PDF'in yer imleri (içindekiler) sayfa numaralarıyla. Üreticiler katalog ve standartlara çoğunlukla
 * yer imi koyar; model bununla aradığı bölümün sayfasına `offset` ile doğrudan gider. Yer imi yoksa
 * ya da okunamıyorsa boş döner, okuma bundan etkilenmez.
 */
async function tableOfContents(doc: PDFDocumentProxy, d: ReturnType<typeof dict>): Promise<string> {
  let roots: OutlineNode[] | null;
  try {
    roots = (await doc.getOutline()) as OutlineNode[] | null;
  } catch {
    return "";
  }
  if (!roots || roots.length === 0) return "";
  const lines: string[] = [];
  let hidden = 0;
  const walk = async (nodes: readonly OutlineNode[], depth: number): Promise<void> => {
    for (const node of nodes) {
      if (lines.length >= OUTLINE_ENTRIES) {
        hidden += 1 + countNodes(node.items);
        continue;
      }
      const title = node.title.replace(/\s+/g, " ").trim().slice(0, OUTLINE_TITLE);
      const page = await destinationPage(doc, node.dest);
      const entry =
        page === undefined
          ? title
          : d.pdf.outlineEntry.replace("{{title}}", () => title).replace("{{page}}", String(page));
      lines.push(`${"  ".repeat(depth)}- ${entry}`);
      if (depth + 1 < OUTLINE_DEPTH) await walk(node.items, depth + 1);
      else hidden += countNodes(node.items);
    }
  };
  await walk(roots, 0);
  const tail = hidden > 0 ? `\n${d.pdf.outlineMore.replace("{{n}}", String(hidden))}` : "";
  return `\n\n${d.pdf.outlineHead}\n${lines.join("\n")}${tail}`;
}

function countNodes(nodes: readonly OutlineNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.items), 0);
}

/** Yer iminin hedef sayfası (1 tabanlı); adlı hedef önce çözülür, bozuk hedefte sayfa yazılmaz. */
async function destinationPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | undefined> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return undefined;
    const target: unknown = explicit[0];
    if (typeof target === "number") return target + 1;
    if (typeof target !== "object" || target === null) return undefined;
    const ref = target as { num?: unknown; gen?: unknown };
    if (typeof ref.num !== "number" || typeof ref.gen !== "number") return undefined;
    return (await doc.getPageIndex({ num: ref.num, gen: ref.gen })) + 1;
  } catch {
    return undefined;
  }
}

/** Arama sonucunda sayfa başına gösterilen alıntı ve listelenen sayfa sınırı. */
const SEARCH_SNIPPETS = 3;
const SEARCH_PAGES = 40;
/**
 * Bundan çok sayfada eşleşen genel terimde sayfa başına tek alıntı: gerçek katalogda
 * "evaporatör" 128 sayfada eşleşip ~20 bin karakter döndürüyordu; model zaten aramayı daraltır.
 */
const SEARCH_BROAD = 10;
/** Alıntıda eşleşmenin iki yanındaki karakter. */
const SEARCH_CONTEXT = 80;
/** Metin katmanı olmayan sayfalardan listelenen numara. */
const SEARCH_BLANK_PAGES = 20;

export interface PdfSearchOptions {
  lang?: Locale;
  signal?: AbortSignal;
}

/**
 * PDF'in metin katmanında terim arar, eşleşen sayfaları alıntıyla döndürür: kodda `grep`'in
 * karşılığı. Katalog sorularında aranan çoğunlukla bir model kodu ya da terimdir; model eşleşen
 * sayfaları sonra `read` ile açar. Metin katmanı olmayan sayfalar aranamaz, numaraları bildirilir
 * ki model gerekirse onları görüntü olarak okusun.
 */
export async function searchPdfContent(
  path: string,
  query: string,
  options: PdfSearchOptions = {},
): Promise<TextContent[]> {
  return withPdf(path, async (doc) => {
    const d = dict(options.lang ?? SOURCE_LOCALE);
    const total = doc.numPages;
    const hits: { page: number; count: number; snippets: string[] }[] = [];
    const blank: number[] = [];
    let matches = 0;
    for (let n = 1; n <= total; n++) {
      options.signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      page.cleanup();
      if (text.length < MIN_TEXT) {
        blank.push(n);
        continue;
      }
      const found = findMatches(text, query);
      if (found.count === 0) continue;
      matches += found.count;
      hits.push({ page: n, ...found });
    }

    const header = d.pdf.header
      .replace("{{name}}", () => basename(path))
      .replace("{{pages}}", String(total));
    const shownQuery = query.trim();
    const lines = [header];
    if (hits.length === 0) {
      lines.push(d.pdf.searchNone.replace("{{query}}", () => shownQuery));
    } else {
      lines.push(
        d.pdf.searchSummary
          .replace("{{query}}", () => shownQuery)
          .replace("{{pages}}", String(hits.length))
          .replace("{{matches}}", String(matches)),
      );
      const perPage = hits.length > SEARCH_BROAD ? 1 : SEARCH_SNIPPETS;
      for (const hit of hits.slice(0, SEARCH_PAGES)) {
        lines.push(
          "",
          d.pdf.searchPage
            .replace("{{page}}", String(hit.page))
            .replace("{{count}}", String(hit.count)),
          ...hit.snippets.slice(0, perPage),
        );
      }
      if (hits.length > SEARCH_PAGES) {
        const rest = hits.slice(SEARCH_PAGES).map((hit) => hit.page);
        lines.push("", d.pdf.searchMore.replace("{{pages}}", rest.join(", ")));
      }
    }
    if (blank.length > 0) {
      const listed = blank.slice(0, SEARCH_BLANK_PAGES).join(", ");
      const more = blank.length > SEARCH_BLANK_PAGES ? ", …" : "";
      lines.push(
        "",
        d.pdf.searchBlank
          .replace("{{count}}", String(blank.length))
          .replace("{{pages}}", `${listed}${more}`),
      );
    }
    return [{ type: "text", text: lines.join("\n") }];
  });
}

/**
 * Sayfa metninde terimi arar. Büyük/küçük harf, Türkçe İ/ı ve aksanlar (ş, ğ, ü…) yok sayılır,
 * boşluklar tek boşluğa indirilir: satır sonunda bölünen "GS 450" ya da "SOGUTMA" yazılan
 * "soğutma" da bulunur. Katlama karakter başına uzunluk koruyarak yapılır, alıntı özgün metinden
 * kesilir. Birbirine yakın eşleşmeler tek alıntıda gösterilir, sayıma yine girer.
 */
export function findMatches(text: string, query: string): { count: number; snippets: string[] } {
  const needle = fold(query.replace(/\s+/g, " ").trim());
  if (needle.length === 0) return { count: 0, snippets: [] };
  const flat = text.replace(/\s+/g, " ");
  const hay = fold(flat);
  const snippets: string[] = [];
  let count = 0;
  let covered = -1;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    count += 1;
    if (at < covered || snippets.length >= SEARCH_SNIPPETS) continue;
    const from = Math.max(0, at - SEARCH_CONTEXT);
    const to = Math.min(flat.length, at + needle.length + SEARCH_CONTEXT);
    covered = to;
    const head = from > 0 ? "…" : "";
    const tail = to < flat.length ? "…" : "";
    snippets.push(`${head}${flat.slice(from, to).trim()}${tail}`);
  }
  return { count, snippets };
}

/** Arama için katlama; her UTF-16 birimi tek birime döner ki konumlar özgün metinle örtüşsün. */
function fold(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch.charCodeAt(0) < 128) {
      out += ch.toLowerCase();
      continue;
    }
    if (ch === "ı" || ch === "İ") {
      out += "i";
      continue;
    }
    out += ch.normalize("NFD").charAt(0).toLowerCase().charAt(0);
  }
  return out;
}

/**
 * Sayfa metninin sayfayı anlatmaya yetip yetmediği. Metin katmanı yoksa sayfa taranmıştır; metin
 * varsa ama azsa ve altında bir çizim duruyorsa (şema, plan, grafik) etiketten ibarettir. Elektrik
 * pano çizimlerinde bütün bir A4 şema yüz karakterlik etiket olarak geliyordu; model çizimi hiç
 * görmediği için PDF'i kendi başına görüntüye çevirmeye çalışıyordu.
 */
async function pageKind(page: PDFPageProxy, text: string, ops: Pdfjs["OPS"]): Promise<PageKind> {
  if (text.length < MIN_TEXT) return "scanned";
  if (text.length > DRAWING_MAX_CHARS) return "text";
  return (await hasDrawing(page, ops)) ? "drawing" : "text";
}

/**
 * Sayfada bakmaya değer bir şekil var mı. Vektör yol sayısına bakılır: şemada binlerce
 * `constructPath` bulunur, düz metin sayfasında (tablo çizgileri dahil) onlarca. Büyük bir bitmap
 * de şekil sayılır (fotoğraf, grafik ekran görüntüsü); logo boyutundakiler elenir.
 *
 * İşlem listesi sayfa içeriğini baştan çözer; bu yüzden yalnızca metni az olan sayfalarda çağrılır.
 */
async function hasDrawing(page: PDFPageProxy, ops: Pdfjs["OPS"]): Promise<boolean> {
  const list = await page.getOperatorList();
  let paths = 0;
  for (const [i, fn] of list.fnArray.entries()) {
    if (fn === ops.constructPath) {
      paths += 1;
      continue;
    }
    if (fn !== ops.paintImageXObject && fn !== ops.paintInlineImageXObject) continue;
    if (imagePixels(list.argsArray[i]) >= DRAWING_IMAGE_PIXELS) return true;
  }
  return paths >= DRAWING_PATHS;
}

/** Bitmap piksel sayısı: `paintImageXObject` [kimlik, en, boy] verir, satır içi görüntü nesne. */
function imagePixels(args: unknown): number {
  if (!Array.isArray(args)) return 0;
  const [first, width, height] = args as [unknown, unknown, unknown];
  if (typeof width === "number" && typeof height === "number") return width * height;
  if (typeof first !== "object" || first === null) return 0;
  const box = first as { width?: unknown; height?: unknown };
  return typeof box.width === "number" && typeof box.height === "number"
    ? box.width * box.height
    : 0;
}

/** Sayfayı görüntüye çevirir. Taranmış sayfa fotoğraftır; JPEG PNG'nin birkaçta biri yer tutar. */
async function renderPage(page: PDFPageProxy, kit: Canvas): Promise<ImageContent> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = kit.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext("2d");
  await page.render({ canvas, canvasContext, viewport }).promise;
  return {
    type: "image",
    data: canvas.toBuffer("image/jpeg", 85).toString("base64"),
    mimeType: "image/jpeg",
  };
}
