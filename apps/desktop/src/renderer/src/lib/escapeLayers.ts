import { useApp } from "../stores/app";
import { findBarOpen } from "../stores/find";
import { floatingLayerOpen, useLayers } from "../stores/layers";

/**
 * Esc sahipliği. Katmanların hepsi pencere dinleyicisi olduğu için bir basış hepsine ulaşır ve
 * dinleyici sırası bileşenlerin bağlanma sırasına göre değişir. İki kural birlikte uygulanır:
 * Esc'i işleyen katman `preventDefault` der (sonra gelenler `defaultPrevented` görür), alttaki
 * katman ayrıca üstte açık katman var mı diye store'lara bakar (önce çalışsa da kapanmaz).
 */

/** Ayarlar kaplamasının üstünde açık katman var mı (sayfa içi modallar dahil). */
export function layerAboveSettings(): boolean {
  const app = useApp.getState();
  return (
    floatingLayerOpen() ||
    useLayers.getState().modals.length > 0 ||
    app.searchOpen ||
    app.commandsOpen ||
    app.modal !== null
  );
}

/** Oturum ekranının üstünde açık katman var mı; Ayarlar da oturumu örter. */
export function layerAboveSession(): boolean {
  return layerAboveSettings() || useApp.getState().settingsOpen;
}

type EscapeEvent = Pick<KeyboardEvent, "key" | "defaultPrevented">;

/**
 * Oturum ekranındaki Esc turu durdurur mu: yalnız tur sürerken ve üstte katman yokken. Bulma
 * çubuğu açıksa ilk Esc onu kapatır; tur ikinci Esc'te durur.
 */
export function escapeAbortsTurn(e: EscapeEvent, working: boolean): boolean {
  return (
    e.key === "Escape" && !e.defaultPrevented && working && !layerAboveSession() && !findBarOpen()
  );
}

/** Odak çubuğun dışındayken Esc bulma çubuğunu kapatır mı: üstte katman yoksa. */
export function escapeClosesFind(e: EscapeEvent): boolean {
  return e.key === "Escape" && !e.defaultPrevented && findBarOpen() && !layerAboveSession();
}

/** Ayarlar'daki Esc kaplamayı kapatır mı: başka katman Esc'i almadıysa. */
export function escapeClosesSettings(e: EscapeEvent): boolean {
  return e.key === "Escape" && !e.defaultPrevented && !layerAboveSettings();
}
