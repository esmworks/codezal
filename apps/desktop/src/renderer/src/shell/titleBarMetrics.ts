import { isMac } from "../lib/platform";

/**
 * Başlık şeridi ölçüleri tek yerde: macOS trafik ışıkları (window.ts `trafficLightPosition`),
 * şeritteki düğmeler ve içerik başlığı aynı ritmi paylaşmalı. Sabit sayıları ekranlara dağıtmak
 * şeride düğme eklendiğinde başlığın düğmelerin altına girmesine yol açıyordu.
 */

/** Başlık şeridinin yüksekliği: pencere kontrolleri bu şeritte dikey ortalanır. */
export const TITLE_BAR_HEIGHT = 34;

/** Trafik ışıklarından sonraki ilk düğmenin sol kenarı. */
export const FIRST_BUTTON_LEFT = isMac ? 83 : 10;

/** Düğme kutusu 22px + arada 1px; TitleBar'daki kutular bu adımla dizilir. */
const BUTTON_STEP = 23;

/** Şeritteki düğme sayısı: kenar çubuğu, arama, tema, ayar — dördü de her zaman görünür. */
const BUTTONS = 4;

/** Düğmeler bitince başlık yazısına kalan boşluk. */
const TITLE_GAP = 12;

/**
 * Kenar çubuğu gizliyken içerik başlığının sol boşluğu: başlık şeritteki düğmelerin altına
 * girmesin. Kenar çubuğu açıkken başlık zaten içerik alanının içinde durur, bu değer kullanılmaz.
 */
export function titleLeftInset(): number {
  return FIRST_BUTTON_LEFT + BUTTONS * BUTTON_STEP + TITLE_GAP;
}
