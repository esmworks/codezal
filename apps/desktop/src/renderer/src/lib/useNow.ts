import { useSyncExternalStore } from "react";

/** Göreli zaman etiketlerinin tazelenme aralığı: en küçük birim dakika olduğu için 60 sn. */
const INTERVAL_MS = 60_000;

let current = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/**
 * Bir sonraki tazeleme anına kalan süre. Aralığın katına hizalanır: etiketler (29 dk → 30 dk)
 * saat sınırında döner ve zamanlayıcı gecikmeleri zamanla birikmez.
 */
export function msUntilNextTick(now: number, intervalMs: number = INTERVAL_MS): number {
  const rest = now % intervalMs;
  return rest === 0 ? intervalMs : intervalMs - rest;
}

/** Abonelere saati bildirir; değer değişmediyse boşuna render tetiklemez. */
function emit(): void {
  const next = Date.now();
  if (next === current) return;
  current = next;
  // Bildirim sırasında bir abone çıkarsa iterasyon bozulmasın: kopya üzerinden dolaş.
  for (const listener of [...listeners]) listener();
}

function schedule(): void {
  if (timer !== null || listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    emit();
    schedule();
  }, msUntilNextTick(Date.now()));
}

function stop(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** Arka planda kısılan zamanlayıcı dönüşte bayat etiket göstermesin: görünür olunca hemen tazele. */
function onVisibility(): void {
  if (document.hidden) return;
  stop();
  emit();
  schedule();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // Dinleyici yokken saat bayatlamış olabilir; ilk abonede tazele ve görünürlük dönüşünü izle.
    current = Date.now();
    document.addEventListener("visibilitychange", onVisibility);
  }
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibility);
    stop();
  };
}

/**
 * Kenar çubuğu, arama paleti, arşiv ve bellek listelerindeki göreli zaman etiketleri ("5dk") için
 * dakikada bir tazelenen ortak saat. Bütün çağıranlar tek zamanlayıcıyı paylaşır: onlarca satır
 * olsa da tek uyanma olur ve aynı etiketler aynı anda döner.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current);
}
