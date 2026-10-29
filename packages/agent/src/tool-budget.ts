/**
 * Araç sonucu bütçesi: modele giden metnin üst sınırı.
 *
 * Pi'nin yerleşik araçları (bash, read, grep) kendi çıktılarını kırpıp tam hâlini geçici dosyaya
 * yazar. Codezal'in kendi araçları — özellikle uzak MCP bağlayıcıları — böyle bir sınır taşımaz:
 * bir sunucu tek çağrıda megabayt döndürebilir ve o metin **her sonraki turda** yeniden gönderilir.
 * Sonuç: bağlam bir anda dolar, sıkıştırma devreye girer, kullanıcı turu kaybeder.
 *
 * Kırpma sessiz değildir: sona makine tarafından okunabilir bir işaret eklenir. Model, elindeki
 * görünümün kısmi olduğunu bilir ve gerekirse daha dar bir sorguyla yeniden çağırır; aksi hâlde
 * yarım çıktıyı tam sanıp yanlış sonuca varıyordu (ZCode'un `resultBudget` deseni).
 */

/** Araç sonucu başına modele giden en fazla karakter. */
export const MAX_TOOL_RESULT_CHARS = 40_000;

/**
 * Metni bütçeye indirir. Sınırı aşan metinde **baş** korunur (araç çıktılarında anlamlı kısım
 * genelde baştadır: arama sonuçları, liste başları, hata mesajları) ve sona işaret eklenir.
 * `tail` stratejisi sondan korur (günlük/derleme çıktısı gibi sonu önemli olanlar için).
 */
export function truncateToolText(
  text: string,
  limit = MAX_TOOL_RESULT_CHARS,
  strategy: "head" | "tail" = "head",
): string {
  if (text.length <= limit) return text;
  const marker = `\n\n[çıktı kırpıldı: özgün ${text.length} karakter, gösterilen ${limit}, strateji=${strategy}]`;
  if (strategy === "tail") return `${marker.trimStart()}\n\n${text.slice(text.length - limit)}`;
  return `${text.slice(0, limit)}${marker}`;
}

/**
 * Metin bloklarının toplamını bütçeye indirir; blok sınırlarını korur (görsel bloklar ayrı
 * bütçede olduğu için dokunulmaz). Toplam aşılırsa bloklar sırayla kırpılır, taşan bloklar kısalır.
 */
export function boundTextBlocks<T extends { type: string; text?: string }>(
  blocks: readonly T[],
  limit = MAX_TOOL_RESULT_CHARS,
): T[] {
  let remaining = limit;
  const out: T[] = [];
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") {
      out.push(block);
      continue;
    }
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      out.push(block);
      continue;
    }
    if (remaining <= 0) continue;
    // Bütçe bittiğinde blok **düşürülür**, boş metin olarak bırakılmaz: sağlayıcılar boş metin
    // bloğunu reddeder ("text content blocks must be non-empty") ve bütün tur başarısız olur.
    out.push({ ...block, text: truncateToolText(block.text, remaining) });
    remaining = 0;
  }
  return out;
}
