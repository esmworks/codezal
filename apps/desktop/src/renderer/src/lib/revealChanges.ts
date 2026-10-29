import { useApp } from "../stores/app";
import { usePanel } from "../stores/panel";

/**
 * Çalışma ağacı değişikliklerini sağ paneldeki Değişiklikler sekmesinde görünür kılar.
 *
 * `openTab` yalnız sekmeyi seçer; panel kapalıyken hiçbir şey görünmez. Kutu içindeki
 * "Değişiklikler" satırı ve ⌘G kısayolu panel kapalıyken de çağrılabildiği için panel burada
 * açılır; açıkken kullanıcının seçimi bozulmaz.
 */
export function revealChanges(): void {
  usePanel.getState().openTab("Değişiklikler");
  const app = useApp.getState();
  if (!app.panelOpen) app.togglePanel();
}
