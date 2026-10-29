/** Menünün tutunduğu öğenin ekrandaki yeri. */
export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
}

/** Katmanların kabul ettiği çapa: bir öğe, hazır dikdörtgen ya da yalnız bir nokta. */
export type MenuCallbackAnchor = HTMLElement | DOMRect | { x: number; y: number };

/**
 * Çapayı dikdörtgene çevirir. Katmanlar (menü, model seçici) çapayı öğe olarak da hazır
 * dikdörtgen olarak da alabilir: çipler kendi öğeleriyle açar, `/model` ve `/mod` komutları
 * kompozerin ölçülmüş dikdörtgeniyle açar (komutu yazan çip görünürde yoktur).
 */
export function anchorRect(anchor: MenuCallbackAnchor): DOMRect {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  if (anchor instanceof DOMRect) return anchor;
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

interface Size {
  width: number;
  height: number;
}

export interface MenuPos {
  left: number;
  top: number;
  /** Menü bu yüksekliği aşarsa kendi içinde kaydırılır. */
  maxHeight: number;
}

/** Menünün pencere kenarına en fazla yaklaşacağı boşluk. */
const MARGIN = 8;
/** Menü ile tutunduğu öğe arasındaki aralık. */
const GAP = 4;
/** Dar pencerede bile menü bu kadarını gösterir; gerisi kaydırılır. */
const MIN_HEIGHT = 120;

/**
 * Menüyü öğenin altına açar; altta yer yoksa üstüne çevirir. Yön kararı ölçülen gerçek
 * yüksekliğe göre verilir: satır sayısından tahmin etmek açıklamalı (iki satırlık) öğelerde
 * yanılıyor ve menünün alt ucu pencerenin dışında kalıyordu.
 */
export function menuPos(anchor: MenuAnchor, menu: Size, view: Size): MenuPos {
  const roomBelow = view.height - MARGIN - (anchor.bottom + GAP);
  const roomAbove = anchor.top - GAP - MARGIN;
  // İki yöne de sığmıyorsa geniş olan tarafa yaslanır, kalanı kaydırmaya bırakılır.
  const above = menu.height > roomBelow && roomAbove > roomBelow;
  const maxHeight = Math.max(MIN_HEIGHT, above ? roomAbove : roomBelow);
  const top = above
    ? Math.max(MARGIN, anchor.top - GAP - Math.min(menu.height, maxHeight))
    : anchor.bottom + GAP;
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - menu.width - MARGIN));
  return { left, top, maxHeight };
}
