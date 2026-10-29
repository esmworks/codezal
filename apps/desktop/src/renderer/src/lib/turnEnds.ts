import type { TranscriptItem } from "@codezal/contracts";

export interface TurnEnds {
  /** Kapanış dizilerindeki tüm metinli asistan mesajları: sonuç bloğu olarak çizilirler. */
  results: Set<string>;
  /** Her kapanış dizisinin son mesajı: rozet, dosya satırı ve tur sonu kontrolü buraya iner. */
  finals: Set<string>;
  /** Dizideki en son kapanış mesajı; tur sonu kontrolü yalnızca onun altında çizilir. */
  last: string | undefined;
}

/**
 * Tur kapanışlarını bulur. Kapanış, turun sonunda araçlarla kesilmeyen metinli asistan
 * mesajlarıdır. Arka plan bitişi gibi gizli dürtmeler aynı görsel turda yeni bir kapanış bölgesi
 * açar: dürtme sınırı (`boundary`) öncesindeki rapor da sonuç sayılır ki dürtme yanıtı bir araç
 * çağırdığında asıl rapor katlanmış çalışma dizisine gömülmesin. Dosya satırı, rozet ve tur sonu
 * kontrolü yine yalnızca görsel turun son kapanışında kalır.
 *
 * Sondan başa tek geçiş: araç öğesi kapanışı kapatır, kullanıcı mesajı ve dürtme sınırı yenisini
 * açar; komut sonucu işaretleri (`marker`) ne kapatır ne açar, dizide görünmez sayılır. `busy`
 * iken dizinin ucundaki kapanış henüz tamamlanmamıştır; sayılmaz.
 */
export function findTurnEnds(items: readonly TranscriptItem[], busy: boolean): TurnEnds {
  const results = new Set<string>();
  const finals = new Set<string>();
  let last: string | undefined;
  let open = !busy;
  // Sondan geliyoruz: açık alanda ilk rastlanan metin, o dizinin son mesajıdır.
  let finalPending = open;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    // Dürtme sınırı bölgeyi açar ama "finals"ı devretmez: önceki rapor görünür kalır.
    if (item.type === "boundary") {
      open = true;
      continue;
    }
    if (item.type === "tool") {
      open = false;
      finalPending = false;
      continue;
    }
    if (item.type === "user") {
      open = true;
      finalPending = true;
      continue;
    }
    if (!open || item.type === "marker" || item.streaming || !item.text.trim()) continue;
    results.add(item.id);
    if (finalPending) {
      finals.add(item.id);
      last ??= item.id;
      finalPending = false;
    }
  }
  return { results, finals, last };
}
