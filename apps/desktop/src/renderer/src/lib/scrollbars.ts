/**
 * Kaydırma çubuğu görünürlüğü: macOS'taki gibi yalnızca kaydırırken belirir, durunca söner.
 *
 * Chromium `::-webkit-scrollbar-*` sözde öğelerinde transition çalıştırmadığı için solma
 * iki adımda yapılır: önce tam renk (`cz-scrolling`), sonra kısa bir yarı saydam kare
 * (`cz-scroll-fade`). Kurallar `styles.css` içindedir.
 */

/** Kaydırma durduktan sonra tutamacın tam görünür kaldığı süre (ms). */
const HOLD = 700;
/** Sönerken geçilen yarı saydam adımın süresi (ms). */
const FADE = 180;

interface Timers {
  hold: number;
  fade: number;
}

/**
 * Kaydırılan öğeyi işaretler, zamanlayıcıyla temizler. Zamanlayıcılar öğeye bağlı tutulur:
 * aynı kap art arda kaydırılınca eskiler iptal edilip süre baştan başlar.
 */
export function flashScrollbar(el: Element, timers: WeakMap<Element, Timers>): void {
  const prev = timers.get(el);
  if (prev) {
    clearTimeout(prev.hold);
    clearTimeout(prev.fade);
  }
  el.classList.add("cz-scrolling");
  el.classList.remove("cz-scroll-fade");
  const hold = window.setTimeout(() => {
    el.classList.remove("cz-scrolling");
    el.classList.add("cz-scroll-fade");
  }, HOLD);
  const fade = window.setTimeout(() => el.classList.remove("cz-scroll-fade"), HOLD + FADE);
  timers.set(el, { hold, fade });
}

/**
 * Belgedeki bütün kaydırma olaylarını yakalama evresinde dinler: kap hangisi olursa olsun
 * (iç içe listeler, modaller, terminal) çubuk aynı kuralla belirir. Bırakma işlevi döner.
 */
export function watchScrollbars(doc: Document = document): () => void {
  const timers = new WeakMap<Element, Timers>();
  const onScroll = (e: Event) => {
    const target = e.target;
    const el = target instanceof Element ? target : doc.documentElement;
    flashScrollbar(el, timers);
  };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener("scroll", onScroll, { capture: true });
}
