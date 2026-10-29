/**
 * Tur bazlı pencere hesabı: uzun bir oturumda bütün turları DOM'a basmak yerine yalnız görünen
 * bölgeyi (artı pay) çizer, geri kalanının yerini **boşlukla** tutar.
 *
 * Neden boşluk (spacer) ve neden tur bazında:
 *
 * - Boşluk toplam yüksekliği korur. Sohbetin kaydırma çapası (`scrollAnchor.ts`) görünür satırı
 *   ölçüp `scrollTop`u düzeltir; yükseklik toplamı yanlış olsaydı çapa her karede yanlış yere
 *   hizalanır ve sohbet zıplardı. Boşlukla geometri aynı kalır, yalnız çizilmeyen satırların
 *   yerini tek bir `div` tutar.
 * - Tur bazında çünkü ZCode da öyle yapar ve sohbetin anlamlı birimi turdur: bir turu yarım
 *   çizmek (kullanıcı balonu görünürken yanıtı görünmemek) tek satırlık sanallaştırmadan daha
 *   kötü bir deneyim olurdu.
 *
 * Eşik altındaki oturumlarda pencere uygulanmaz (`VIRTUAL_MIN_ROWS`): kısa sohbette davranış
 * bugünküyle birebir aynı kalır, sanallaştırmanın riski yalnız gerçekten uzun oturumlara gider.
 */

/** Bu sayının altındaki tur listelerinde pencere uygulanmaz. */
export const VIRTUAL_MIN_ROWS = 150;

/** Görünen alanın üstünde/altında çizilecek fazladan tur: hızlı kaydırmada boşluk görünmesin. */
export const VIRTUAL_OVERSCAN = 6;

/**
 * Ölçülmemiş bir satırın **adımı**: satır + altındaki boşluk (px). Küçük seçildi: fazla tahmin,
 * pencere kaydığında aşağı doğru sıçrama üretir; eksik tahmin yalnızca biraz daha erken çizmeye
 * yol açar.
 *
 * Boşluk burada çünkü sanallaştırma açıkken kolon aralığı `gap` yerine satır dolgusuyla verilir
 * (`ROW_SPACING_CLASS`): `getBoundingClientRect` yüksekliği dolguyu içerir, yani ölçüm ile tahmin
 * aynı birimde olur. `gap` ile ölçülseydi atlanan her satır 20px'lik boşluğunu da götürür ve
 * toplam yükseklik pencere her kaydığında oynardı.
 */
export const ROW_HEIGHT_ESTIMATE = 116;

export interface VirtualWindowInput {
  /** Toplam tur sayısı. */
  count: number;
  /** Kabın `scrollTop`u. */
  scrollTop: number;
  /** Kabın görünür yüksekliği. */
  viewport: number;
  /**
   * Tur başına bilinen yükseklik; `undefined` ise `ROW_HEIGHT_ESTIMATE` kullanılır.
   * Dizinin uzunluğu `count` olmalıdır.
   */
  heights: ReadonlyArray<number | undefined>;
  overscan?: number | undefined;
}

export interface VirtualWindow {
  /** Çizilecek ilk tur (dahil). */
  start: number;
  /** Çizilecek son tur (hariç). */
  end: number;
  /** Çizilmeyen üst turların toplam yüksekliği. */
  padTop: number;
  /** Çizilmeyen alt turların toplam yüksekliği. */
  padBottom: number;
}

/** Bir turun yüksekliği: ölçülmüşse o, değilse tahmin. */
function heightAt(heights: ReadonlyArray<number | undefined>, index: number): number {
  const known = heights[index];
  return typeof known === "number" && known > 0 ? known : ROW_HEIGHT_ESTIMATE;
}

/**
 * Bir aralığın toplam adımı (yükseklik + satır altı boşluk). Pencere boşluklarını kuran hesabın
 * aynısı dışarıya da açılır: tur çubuğu bir mesaja atlarken satır DOM'da olmayabilir ve konum
 * yalnız bu modelden bilinebilir.
 */
export function sumRowHeights(
  heights: ReadonlyArray<number | undefined>,
  from: number,
  to: number,
): number {
  let total = 0;
  for (let i = from; i < to; i++) total += heightAt(heights, i);
  return total;
}

/**
 * Görünen bölgeyi kapsayan pencereyi hesaplar.
 *
 * Liste kısaysa (`VIRTUAL_MIN_ROWS` altı) tamamı döner: çağıran dallanmak zorunda kalmasın ve
 * kısa sohbette boşluk div'i hiç oluşmasın.
 */
export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { count, scrollTop, viewport, heights } = input;
  const overscan = input.overscan ?? VIRTUAL_OVERSCAN;
  if (count <= VIRTUAL_MIN_ROWS) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 };
  }

  const top = Math.max(0, scrollTop);
  const visible = Math.max(0, viewport);
  // Kap henüz ölçülmemişse (ilk kare) listenin **sonu** çizilir: sohbet dibe yapışıktır ve
  // baştan çizmek ilk karede eski mesajları gösterip sonra aşağı atlardı.
  if (visible === 0) {
    const start = Math.max(0, count - overscan * 3);
    return { start, end: count, padTop: sumRowHeights(heights, 0, start), padBottom: 0 };
  }
  const bottom = top + visible;

  // Görünen aralığı yürüyerek bul: tur sayısı binlerle ifade edilse de bu döngü kare başına
  // bir kez koşar ve ölçüm okumalarından (getBoundingClientRect) çok daha ucuzdur.
  let y = 0;
  let firstVisible = count;
  let lastVisible = 0;
  for (let i = 0; i < count; i++) {
    const h = heightAt(heights, i);
    const rowBottom = y + h;
    if (rowBottom > top && i < firstVisible) firstVisible = i;
    if (y < bottom) lastVisible = i;
    y = rowBottom;
    if (y >= bottom && firstVisible < count) break;
  }
  // Hiçbir satır görünmüyorsa (boş liste ya da sıfır yükseklik) hepsini çiz: boş ekran olmasın.
  if (firstVisible >= count) return { start: 0, end: count, padTop: 0, padBottom: 0 };

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + 1 + overscan);
  return {
    start,
    end,
    padTop: sumRowHeights(heights, 0, start),
    padBottom: sumRowHeights(heights, end, count),
  };
}

/**
 * Tur yüksekliği önbelleği. Ölçülen yükseklikler turun **kararlı kimliğiyle** saklanır; pencere
 * kaydığında bir tur yeniden çizilirse eski yüksekliği hazır olur ve boşluk tahmini düzelir.
 * Sınırlıdır: uzun bir oturumda tur sayısı kadar kayıt tutmak anlamsız, en yeni turlar yeter.
 */
export class RowHeightCache {
  readonly #max: number;
  readonly #heights = new Map<string, number>();

  constructor(max = 600) {
    this.#max = max;
  }

  /** Ölçülen yüksekliği yazar; kapasite aşılırsa en eski kayıt düşer. */
  set(key: string, height: number): void {
    if (height <= 0) return;
    // Yeniden ekleme Map sırasını tazeler: LRU, ekleme sırasına göre çalışır.
    this.#heights.delete(key);
    this.#heights.set(key, height);
    while (this.#heights.size > this.#max) {
      const oldest = this.#heights.keys().next().value;
      if (oldest === undefined) break;
      this.#heights.delete(oldest);
    }
  }

  get(key: string): number | undefined {
    return this.#heights.get(key);
  }

  /** Tur sırasına göre yükseklik dizisi; bilinmeyenler `undefined` (tahmine düşülür). */
  series(keys: readonly string[]): (number | undefined)[] {
    return keys.map((k) => this.#heights.get(k));
  }

  clear(): void {
    this.#heights.clear();
  }

  get size(): number {
    return this.#heights.size;
  }
}
