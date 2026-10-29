import { foldQuery, foldWithMap, type TranscriptItem } from "@codezal/contracts";
import type { RunGroup } from "./openRuns";
import { collapsePrompt } from "./promptText";

/**
 * Sohbet içi bulma (⌘F) için eşleşme hesabı. Sohbet uzun oturumda sanallaştırıldığı için
 * (`virtualWindow.ts`) tarayıcının sayfa içi araması ekran dışındaki turları göremez; eşleşmeler
 * burada **veri modelinden** sayılır, ekrandaki vurgu ayrıca çizilir (`findHighlight.ts`).
 *
 * Aranan metin ekranda görünenle aynı kuraldadır: kullanıcı balonunda gönderim blokları çözülmüş
 * metin, asistanda yanıt metni. Düşünme ve araç çıktısı aranmaz (⌘K içerik aramasıyla aynı).
 */

/** Tek eşleşme: satır (grup) sırası, öğe ve satır içindeki sırası. */
export interface FindMatch {
  /** `groups` içindeki satır sırası. */
  row: number;
  itemId: string;
  role: "user" | "assistant";
  /** Öğenin zaman damgası; ⌘K isabetinden atlarken mesaj bununla bulunur. */
  at: number;
  /** Aynı satırdaki eşleşmeler arasında sıra (0'dan); ekrandaki vurgu buna göre seçilir. */
  inRow: number;
}

/** Sayılacak en çok eşleşme; tek harflik sorgu uzun oturumda on binler üretmesin. */
export const MAX_FIND_MATCHES = 10_000;

type Findable = Extract<TranscriptItem, { type: "user" } | { type: "assistant" }>;

/** Öğe başına katlanmış metin; öğeler değişmez nesnelerdir (indirgeyici kimliği korur). */
const folded = new WeakMap<Findable, string>();

/** Öğenin ekranda görünen, aranacak metni. */
export function findableText(item: Findable): string {
  return item.type === "user" ? collapsePrompt(item.text) : item.text;
}

function foldedOf(item: Findable): string {
  const cached = folded.get(item);
  if (cached !== undefined) return cached;
  const value = foldWithMap(findableText(item)).folded;
  folded.set(item, value);
  return value;
}

/** Bir satırdaki aranabilir öğeler, ekrandaki sırayla. */
function rowItems(group: RunGroup, skip: ReadonlySet<string>): Findable[] {
  if (Array.isArray(group)) {
    // Dizideki tur sonu mesajları yalnız düşünmeleri için girer; metinleri ayrı satırda çizilir.
    return group.filter(
      (i): i is Findable => i.type === "assistant" && !skip.has(i.id) && i.text.trim().length > 0,
    );
  }
  if (group.type === "user" || group.type === "assistant") return [group];
  return [];
}

/** Katlanmış metinde örtüşmesiz geçiş sayısı. */
function countIn(haystack: string, needle: string, limit: number): number {
  let n = 0;
  let from = 0;
  while (n < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    n++;
    from = at + needle.length;
  }
  return n;
}

/**
 * Satırlar üzerinde bütün eşleşmeler (en çok `MAX_FIND_MATCHES`). `skip`: dizi içinde olup
 * metni ayrı satırda çizilen tur sonu mesajları (`findTurnEnds` sonuçları).
 */
export function findMatches(
  groups: readonly RunGroup[],
  query: string,
  skip: ReadonlySet<string> = new Set(),
): FindMatch[] {
  const needle = foldQuery(query);
  if (!needle) return [];
  const out: FindMatch[] = [];
  for (let row = 0; row < groups.length; row++) {
    const group = groups[row];
    if (!group) continue;
    let inRow = 0;
    for (const item of rowItems(group, skip)) {
      const n = countIn(foldedOf(item), needle, MAX_FIND_MATCHES - out.length);
      for (let k = 0; k < n; k++) {
        out.push({ row, itemId: item.id, role: item.type, at: item.at, inRow: inRow++ });
      }
      if (out.length >= MAX_FIND_MATCHES) return out;
    }
  }
  return out;
}

/** ⌘K içerik isabetinin hedefi: mesajın rolü, zaman damgası ve yedek sıra. */
export interface FindTarget {
  role: "user" | "assistant";
  at: number;
  /** Kullanıcı + asistan mesajları arasındaki sıra (1'den). */
  ordinal: number;
}

/**
 * Hedef mesajdaki ilk eşleşmenin sırası. Önce rol + zaman damgası (kayma yapmaz); bulunamazsa
 * kullanıcı + asistan öğeleri arasındaki sıra; o da yoksa ilk eşleşme. Eşleşme yoksa -1.
 */
export function pickMatch(
  matches: readonly FindMatch[],
  target: FindTarget,
  transcript: readonly TranscriptItem[],
): number {
  if (matches.length === 0) return -1;
  const exact = matches.findIndex((m) => m.role === target.role && m.at === target.at);
  if (exact >= 0) return exact;
  let ordinal = 0;
  for (const item of transcript) {
    if (item.type !== "user" && item.type !== "assistant") continue;
    ordinal++;
    if (ordinal !== target.ordinal) continue;
    const byOrdinal = matches.findIndex((m) => m.itemId === item.id);
    return byOrdinal >= 0 ? byOrdinal : 0;
  }
  return 0;
}

/** Görünen ilk satırdan (dahil) sonraki ilk eşleşme; yoksa son eşleşme. Eşleşme yoksa -1. */
export function firstMatchFrom(matches: readonly FindMatch[], row: number): number {
  if (matches.length === 0) return -1;
  const at = matches.findIndex((m) => m.row >= row);
  return at >= 0 ? at : matches.length - 1;
}

/** Sonraki/önceki eşleşme; uçlarda başa/sona sarar. */
export function stepMatch(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}
