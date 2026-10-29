import { foldQuery, foldWithMap } from "@codezal/contracts";

/**
 * Sohbet içi bulmanın ekrandaki vurgusu. CSS Custom Highlight API kullanılır: DOM'a `<mark>`
 * eklenmez, yalnız `Range` kaydedilir. Böylece React'in yönettiği (ve `memo`lu) metin düğümlerine
 * dokunulmaz; akan yanıt yeniden çizilince vurgu bozulmaz, bir sonraki boyamada tazelenir.
 *
 * Yalnız aranabilir bloklar taranır (`[data-quotable]` asistan metni, `[data-find-text]`
 * kullanıcı balonu); araç kartı ve düşünme metni veri modelinde de aranmadığı için dışarıda kalır,
 * satır içi sıra (`inRow`) bu sayede veri modeliyle örtüşür.
 */

/** Bütün eşleşmelerin ve geçerli eşleşmenin vurgu adları (`styles.css` `::highlight`). */
export const FIND_HIGHLIGHT = "cz-find";
export const FIND_HIGHLIGHT_CURRENT = "cz-find-current";

const BLOCKS = "[data-quotable], [data-find-text]";

/**
 * Vurgu biçimi çalışma anında eklenir: `::highlight()` sözde öğesini derlemedeki CSS
 * küçültücüsü (lightningcss) tanımıyor ve kuralı `styles.css`'ten sessizce düşürüyordu.
 * Renkler `tokens.css`'teki `--findHit` / `--findCur` değişkenlerinden, tema ile değişir.
 */
const STYLE = [
  `::highlight(${FIND_HIGHLIGHT}) { background-color: var(--findHit); color: inherit; }`,
  `::highlight(${FIND_HIGHLIGHT_CURRENT}) { background-color: var(--findCur); color: var(--tx); }`,
].join("\n");
let styled = false;

function ensureStyle(): void {
  if (styled || typeof CSSStyleSheet === "undefined") return;
  styled = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Biçim eklenemezse vurgu görünmez; sayaç ve atlama yine çalışır.
  }
}

/** Tarayıcı vurgu API'sini destekliyor mu (jsdom ve eski motorlarda yok). */
function registry(): HighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  if (typeof Highlight === "undefined") return null;
  ensureStyle();
  return CSS.highlights;
}

/** Bir bloktaki metin düğümleri ve birleşik metindeki başlangıçları. */
function textNodes(block: Element): { nodes: Text[]; starts: number[]; text: string } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  return { nodes, starts, text };
}

/** Birleşik metindeki konumu (düğüm, düğüm içi konum) çiftine çevirir. */
function locate(
  nodes: readonly Text[],
  starts: readonly number[],
  offset: number,
  preferEnd: boolean,
): [Text, number] | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const start = starts[i] ?? 0;
    const node = nodes[i];
    if (!node) continue;
    // Bitiş konumu düğüm sınırına denk gelirse önceki düğümün sonuna bağlanır.
    if (preferEnd ? offset > start : offset >= start) return [node, offset - start];
  }
  const first = nodes[0];
  return first ? [first, 0] : null;
}

/** Bir satır elemanındaki eşleşme aralıkları, ekrandaki sırayla. */
export function rangesIn(row: Element, query: string): Range[] {
  const needle = foldQuery(query);
  if (!needle) return [];
  const out: Range[] = [];
  for (const block of row.querySelectorAll(BLOCKS)) {
    // İç içe blok (balon içindeki işaretli alt blok) iki kez sayılmasın.
    const outer = block.parentElement?.closest(BLOCKS);
    if (outer && row.contains(outer)) continue;
    const { nodes, starts, text } = textNodes(block);
    if (!text) continue;
    const source = foldWithMap(text);
    let from = 0;
    for (;;) {
      const at = source.folded.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const start = source.map[at] ?? 0;
      const lastSrc = source.map[at + needle.length - 1] ?? start;
      const cp = text.codePointAt(lastSrc) ?? 0;
      const end = lastSrc + (cp > 0xffff ? 2 : 1);
      const a = locate(nodes, starts, start, false);
      const b = locate(nodes, starts, end, true);
      if (!a || !b) continue;
      const range = document.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1]);
      out.push(range);
    }
  }
  return out;
}

/**
 * Çizili satırlardaki bütün eşleşmeleri boyar; geçerli eşleşmenin aralığını döner (satır çizili
 * değilse ya da metin henüz görünmüyorsa `null`). `current.inRow` satırdaki aralık sayısından
 * büyükse (Markdown çizimi veri modelinden farklı sayı üretti) son aralık seçilir.
 */
export function paintFind(
  root: Element,
  query: string,
  current: { rowKey: string; inRow: number } | null,
): Range | null {
  const reg = registry();
  let found: Range | null = null;
  const all: Range[] = [];
  for (const row of root.querySelectorAll<HTMLElement>("[data-anchor-key]")) {
    const ranges = rangesIn(row, query);
    all.push(...ranges);
    if (current && row.dataset.anchorKey === current.rowKey && ranges.length > 0) {
      found = ranges[Math.min(current.inRow, ranges.length - 1)] ?? null;
    }
  }
  if (reg) {
    reg.set(FIND_HIGHLIGHT, new Highlight(...all));
    if (found) reg.set(FIND_HIGHLIGHT_CURRENT, new Highlight(found));
    else reg.delete(FIND_HIGHLIGHT_CURRENT);
  }
  return found;
}

/** Vurguları kaldırır (bulma çubuğu kapanınca). */
export function clearFind(): void {
  const reg = registry();
  reg?.delete(FIND_HIGHLIGHT);
  reg?.delete(FIND_HIGHLIGHT_CURRENT);
}
