import type { MenuCallbackAnchor } from "../lib/menuPos";

/**
 * Komut çalıştırıcısının menü çapası. Komutlar depo katmanından yürür (React ağacının dışında),
 * ama `/model` ve `/mod` gibi komutlar seçiciyi giriş kutusunun üstünde açmak zorundadır: kompozer
 * kendi kutusunu buraya kaydeder, çalıştırıcı ölçülmüş dikdörtgeni okur. Kayıt tekildir çünkü
 * ekranda tek kompozer vardır (oturum da giriş de aynı kutu bileşenini kullanır).
 */
let anchor: HTMLElement | null = null;

export function setComposerAnchor(el: HTMLElement | null): void {
  anchor = el;
}

/**
 * Kompozerin ekrandaki yeri. Kutu yoksa (henüz bağlanmadı, söküldü ya da test ortamı) pencerenin
 * alt-ortasına düşülür: komut yine de çalışır, seçici yalnız alışılmadık bir yerde açılır —
 * komutun sessizce hiçbir şey yapmaması daha kötü olurdu. Dikdörtgen kurulmaz, `{x, y}` noktası
 * döner: `DOMRect` her ortamda tanımlı değildir (birim testleri DOM'suz koşar).
 */
export function commandAnchor(): MenuCallbackAnchor {
  if (anchor?.isConnected) return anchor;
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return { x: window.innerWidth / 2 - 180, y: window.innerHeight - 120 };
}
