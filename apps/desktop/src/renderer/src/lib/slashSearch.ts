import type { IconName } from "../icons";
import { foldForSearch } from "./searchText";

/**
 * `/` panelinin satır modeli ve puanlı araması. Puanlama ZCode'un `promptInputTriggers`
 * mantığıdır (Apache-2.0): baştan eşleşme > ad içinde geçme > harf sırası tutan eşleşme; ad,
 * açıklamadan ve anahtar kelimeden önce gelir. Düz alt dize süzgeci sıralama yapmadığı için
 * `/mo` yazınca açıklamasında "mo" geçen beceriler `/model`in önüne ya da yanına düşüyordu.
 */

/** Panel bölümü: komutlar, beceriler ve servis istemleri ayrı başlık altında listelenir. */
export type SlashKind = "command" | "skill" | "prompt";

export interface SlashSuggestion {
  /** Tekil anahtar: `command:help`, `skill:ad`. */
  id: string;
  kind: SlashKind;
  /** Kutuya yazılan ve modele/çalıştırıcıya giden metin: `/help`, `/skill:ad`. */
  value: string;
  /** Panelde ve etikette görünen ad: komutta `/help`, beceride yalnız ad. */
  label: string;
  description: string;
  /** Aramaya giren ek sözcükler (takma adlar, Türkçe yazımlar); ekranda görünmez. */
  keywords: readonly string[];
  icon: IconName;
  /**
   * Seçilince hemen çalışır mı: yerel eylem ve argüman istemeyen komutlar (ZCode'un "App
   * komutu"). Ötekiler kutuya etiket olarak girer, kullanıcı argümanını yazar.
   */
  runOnPick: boolean;
  /** Servis istemi: seçilince main'de işlenir, metni kompozere yazılır (etiket olarak girmez). */
  prompt?: SlashPrompt;
}

/** Servis (MCP) isteminin seçimde gereken kimliği ve argümanları. */
export interface SlashPrompt {
  connectorId: string;
  /** Sunucudaki gerçek ad; `value` içindeki yazım güvenli biçime çevrilmiş olabilir. */
  name: string;
  arguments: readonly { name: string; description: string; required: boolean }[];
}

/** Katlanmış metinde sorgunun puanı; küçük puan iyidir, eşleşme yoksa null. */
export function scoreMatch(text: string, query: string): number | null {
  const hay = foldForSearch(text.trim());
  const needle = foldForSearch(query.trim());
  if (!hay) return null;
  if (!needle) return 0;
  if (hay.startsWith(needle)) return hay.length - needle.length;
  const at = hay.indexOf(needle);
  if (at !== -1) return 100 + at;
  // Harf sırası: sorgunun harfleri aynı sırayla geçiyorsa aradaki boşluk kadar ceza.
  let score = 200;
  let from = 0;
  for (const char of needle) {
    const found = hay.indexOf(char, from);
    if (found === -1) return null;
    score += found - from;
    from = found + 1;
  }
  return score + (hay.length - needle.length);
}

/** Satırın en iyi puanı: ad (değer) > görünen ad > açıklama > anahtar kelime. */
function scoreSuggestion(item: SlashSuggestion, query: string): number | null {
  // Değer `/` ile başlar; sorgu `/` olmadan gelir, karşılaştırma iki taraf da çıplakken yapılır.
  const bare = (s: string) => s.replace(/^\/+/, "");
  const candidates = [
    scoreMatch(bare(item.value), query),
    offset(scoreMatch(bare(item.label), query), 50),
    // Açıklamada rastgele harf sırası neredeyse her şeyi eşler; açıklama yalnız alt dizeyle sayılır.
    offset(substringOnly(scoreMatch(item.description, query)), 250),
    ...item.keywords.map((k) => offset(scoreMatch(k, query), 450)),
  ];
  let best = Number.POSITIVE_INFINITY;
  for (const score of candidates) if (score !== null && score < best) best = score;
  return Number.isFinite(best) ? best : null;
}

function offset(score: number | null, by: number): number | null {
  return score === null ? null : score + by;
}

/** Harf sırası eşleşmesi (200+) açıklamada gürültüdür: yalnız önek ve alt dize kalır. */
function substringOnly(score: number | null): number | null {
  return score !== null && score < 200 ? score : null;
}

/**
 * Sorguya göre süzer ve sıralar. Boş sorgu katalog sırasını korur (ZCode da boş `/` panelinde
 * kataloğu olduğu gibi gösterir); eşit puanda da katalog sırası bozulmaz.
 */
export function filterSuggestions(
  items: readonly SlashSuggestion[],
  query: string,
): SlashSuggestion[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, index) => ({ item, index, score: scoreSuggestion(item, query) }))
    .filter(
      (row): row is { item: SlashSuggestion; index: number; score: number } => row.score !== null,
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.item);
}

/**
 * Bölümler katalog sırasıyla çizilir ama varsayılan seçim **bütün listenin** en iyi eşleşmesidir:
 * `/rev` yazınca komutlardaki zayıf bir açıklama eşleşmesi, becerilerdeki tam ad eşleşmesinin
 * önüne geçip seçili gelmesin (ZCode'un `getBestPromptInputSuggestionIndex`).
 */
export function bestIndex(items: readonly SlashSuggestion[], query: string): number {
  if (!query.trim()) return 0;
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const score = scoreSuggestion(item, query);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** Aynı değer iki kaynaktan gelirse ilk gelen kalır (komutlar önde verilir). */
export function uniqueSuggestions(items: readonly SlashSuggestion[]): SlashSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}
