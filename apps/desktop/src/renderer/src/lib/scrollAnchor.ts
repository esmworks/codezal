import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Sohbet kaydırma çapası. İçerik sonradan yeniden gruplanınca (canlı turda araç kartları eşiği
 * aşıp tek satıra katlanınca) aynı karede yükseklik değişir; tarayıcının doğal scroll anchoring'i
 * buna yetmiyor: katlanan satır DOM'dan çıkınca çapa kayboluyor ve sohbet zıplıyor. Burada
 * görünürdeki ilk satırı ölçüp scrollTop'u fark kadar düzeltiyoruz; içerik ne kadar değişirse
 * değişsin görünen satır aynı pikselde kalır. Kullanıcı kaydırdığında çapa referansı tazelenir:
 * yoksa telafi kullanıcının kaydırmasını geri iter (yukarı kaydırınca dibe dönme hatası).
 *
 * Referanslar: deepseek-harness ChatView (`observedTop` defteri + `data-chat-anchor-key`,
 * yalnızca pinliyken dibe takip) ve pi-main `layout.ts` (kırpılan scrollTop farkı kadar
 * içeriği öteleme).
 */

/** Görünür satırın çapası: stabil anahtar + scrollport üst kenarına göre konum. */
export interface ScrollAnchor {
  key: string;
  /** Satırın scrollport üst kenarına göre y konumu (px). */
  top: number;
}

/** Kaydırma kararı: dibe yapış, görüntüyü fark kadar ötele ya da dokunma. */
export type ScrollAction = { type: "follow" } | { type: "nudge"; delta: number } | { type: "none" };

/**
 * Sıralı satır kutularında görünür alana giren ilk satırın indeksini döner; hiçbiri görünmüyorsa
 * -1. İkili arama: rect okuma sayısı satır sayısıyla değil logaritmayla artar, her karede
 * ölçüm yapılabilir.
 */
export function locateAnchor(
  count: number,
  rectAt: (index: number) => { top: number; bottom: number },
  viewportTop: number,
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rectAt(mid).bottom > viewportTop + 0.5) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/**
 * Programatik yazım defterine göre konumu kullanıcı mı değiştirdi. Bizim yazımlarımız
 * `observed`'a işlendiği için fark varsa kaydırma kullanıcıdan gelmiştir.
 */
export function isUserScroll(scrollTop: number, observed: number): boolean {
  return Math.abs(scrollTop - observed) > 0.5;
}

/** Aynı satır iki ölçüm arasında kaç piksel kaydı; satır değiştiyse 0 (telafi anlamsız). */
export function anchorDelta(prev: ScrollAnchor | null, now: ScrollAnchor | null): number {
  if (!prev || !now || prev.key !== now.key) return 0;
  const delta = now.top - prev.top;
  return Math.abs(delta) > 0.5 ? delta : 0;
}

/**
 * Kaydırma yazımını seçer. Dipteyken akış takip edilir: içerik büyüse de katlansa da dibe
 * yapışılır, en son içerik görünür kalır. Dipte değilken görünen satırın konumu korunur;
 * katlanma gibi yükseklik değişimleri bu durumda sohbeti zıplatamaz.
 */
export function planScrollAction(input: {
  prev: ScrollAnchor | null;
  now: ScrollAnchor | null;
  /** Kullanıcı dipte mi ve takip engellenmemiş mi. */
  pinned: boolean;
}): ScrollAction {
  if (input.pinned) return { type: "follow" };
  const delta = anchorDelta(input.prev, input.now);
  return delta === 0 ? { type: "none" } : { type: "nudge", delta };
}

/** Görünür ilk satırın çapasını ölçer; anahtarlı satır yoksa null. */
function measureAnchor(el: HTMLElement, box: HTMLElement): ScrollAnchor | null {
  const rows = box.querySelectorAll<HTMLElement>("[data-anchor-key]");
  if (rows.length === 0) return null;
  const viewportTop = el.getBoundingClientRect().top;
  const index = locateAnchor(
    rows.length,
    (i) => rows.item(i)?.getBoundingClientRect() ?? { top: 0, bottom: 0 },
    viewportTop,
  );
  if (index < 0) return null;
  const row = rows.item(index);
  const key = row?.dataset.anchorKey;
  if (!row || key === undefined) return null;
  return { key, top: row.getBoundingClientRect().top - viewportTop };
}

/**
 * Çapa telafisini her commit'te uygular ve yeniden kullanılabilir bir `follow` döner. Dipten
 * sayılan boşluk `pinGap`; programatik yazımlar `observed` defterine geçer, böylece scroll
 * olayında "bunu kullanıcı mı kaydırdı" ayrımı cihazdan bağımsız yapılır ve telafi yazımı
 * akış takibini kapatmaz.
 */
export function useScrollAnchor(options: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** Kullanıcı dipte mi; hook yazar, çağıran okur. */
  pinnedRef: RefObject<boolean>;
  /** Dipten sayılan en büyük boşluk (px). */
  pinGap?: number;
  /** Otomatik dibe inişi engelleyen koşul (örn. metin seçimi açık). */
  blocked?: (el: HTMLElement) => boolean;
  /** Her ölçüm/yazım sonrası dipten boşluk: düğme görünürlüğü gibi türev görünümler için. */
  onChange?: (gap: number) => void;
}): () => void {
  const { scrollRef, contentRef, pinnedRef, pinGap = 40 } = options;
  // Geri çağrılar ref'te: hook kimliği sabit kalsın, effect'ler her render yeniden kurulmasın.
  const blockedRef = useRef(options.blocked);
  blockedRef.current = options.blocked;
  const onChangeRef = useRef(options.onChange);
  onChangeRef.current = options.onChange;

  /** Son programatik yazımın scrollTop değeri. */
  const observed = useRef(0);
  const anchor = useRef<ScrollAnchor | null>(null);

  const apply = useCallback(() => {
    const el = scrollRef.current;
    const box = contentRef.current;
    if (!el || !box) return;
    // Scroll olayı henüz gelmemiş olabilir (commit ya da ResizeObserver araya girdi): konum
    // bizim yazımızdan farklıysa kullanıcı kaydırmıştır. Takip kararı burada tazelenir;
    // yoksa takip açık kalıp kullanıcıyı dibe geri çeker.
    if (isUserScroll(el.scrollTop, observed.current)) {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < pinGap;
      anchor.current = null;
    }
    // Takip varken çapa ölçümü gerekmez: yazım tamamen dibe gider. Seçim sırasında ya da
    // dipte değilken ölçüm yapılır ve görünen satır yerinde tutulur.
    const tracking = pinnedRef.current && !blockedRef.current?.(el);
    const now = tracking ? null : measureAnchor(el, box);
    const action = planScrollAction({ prev: anchor.current, now, pinned: tracking });
    if (action.type === "follow") {
      el.scrollTop = el.scrollHeight;
      observed.current = el.scrollTop;
      // Yazımdan sonraki gerçek konum kaydedilir: bir sonraki karenin telafisi buna göre.
      anchor.current = measureAnchor(el, box);
    } else if (action.type === "nudge") {
      el.scrollTop += action.delta;
      observed.current = el.scrollTop;
      // Ölçüm nudge'dan sonra tazelenir: kalan eski konum bir sonraki karede ters yönlü
      // düzeltme doğuruyor, içerik ileri geri zıplıyordu.
      anchor.current = measureAnchor(el, box);
    } else {
      anchor.current = now;
    }
    onChangeRef.current?.(el.scrollHeight - el.scrollTop - el.clientHeight);
  }, [scrollRef, contentRef, pinnedRef, pinGap]);

  const follow = useCallback(() => {
    const el = scrollRef.current;
    const box = contentRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
    observed.current = el.scrollTop;
    // Dibe inişten sonraki konum kaydedilir: kullanıcı hemen yukarı kaydırırsa telafi hazır.
    anchor.current = box ? measureAnchor(el, box) : null;
    onChangeRef.current?.(0);
  }, [scrollRef, contentRef, pinnedRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Defter: yazım bizden mi geldi, kullanıcı mı kaydırdı? Aksi halde çapa telafisi
      // "kullanıcı yukarı kaydırdı" sanılıp takibi kapatıyordu.
      if (isUserScroll(el.scrollTop, observed.current)) {
        pinnedRef.current = gap < pinGap;
        // Kullanıcı kaydırdı: eski çapa bu yeni konumu anlatmıyor. Sıfırlanmazsa bir sonraki
        // apply bunu içerik kayması sanıp kaydırmayı aynı oranda geri iter.
        anchor.current = null;
      }
      observed.current = el.scrollTop;
      onChangeRef.current?.(gap);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, pinnedRef, pinGap]);

  // İçerik eşzamansız da büyür (görselin çözülmesi, katlanan kart, kademeli metin): commit
  // gelmese de ölçülür.
  useEffect(() => {
    const box = contentRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => apply());
    ro.observe(box);
    return () => ro.disconnect();
  }, [contentRef, apply]);

  // Her commit'te ölçülür: gruplama içeriği değiştirmeden de yükseklik değişebilir. Karar
  // fonksiyonu zaten "değişim yoksa dokunma" der.
  useLayoutEffect(() => {
    apply();
  });

  return follow;
}
