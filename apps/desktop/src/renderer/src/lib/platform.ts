/**
 * Platform bilgisi preload köprüsünden gelir (`process.platform`): renderer'ın tek doğruluk
 * kaynağı bu. `navigator.platform` kullanımdan kalktı ve yalnız köprü yokken (test ortamı)
 * yedek olarak okunur.
 */
function detectPlatform(): string {
  if (typeof window === "undefined" || !window.codezal) {
    return typeof navigator === "undefined" ? "" : navigator.platform;
  }
  return window.codezal.platform;
}

const platform = detectPlatform();

/** macOS'ta trafik ışıkları ve ⌘ simgeleri var; diğer platformlarda yerleşim ve etiketler değişir. */
export const isMac = platform === "darwin" || platform.toLowerCase().includes("mac");

/**
 * Üst şeritlerin sağ dolgusu: macOS'ta sabit, Windows/Linux'ta pencere denetimleri kadar artar
 * (`--wco`, styles.css). Denetimler kapalıysa `--wco` 0px'tir, değer taban dolguya eşit kalır.
 */
export function padRight(base: number): string {
  return `calc(${base}px + var(--wco))`;
}
