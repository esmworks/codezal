import { useApp } from "../stores/app";
import { usePanel } from "../stores/panel";

/**
 * Terminali sağ panelde görünür kılar: projede açık terminal varsa onu öne alır, yoksa yeni bir
 * terminal sekmesi açar; panel kapalıysa açar. Kısayol, ⌘J ve Ortam kutusundaki "Terminal" satırı
 * aynı davranışı paylaşsın diye tek yerde durur (`revealChanges` ile aynı kalıp).
 */
export function revealTerminal(cwd: string): void {
  if (cwd) usePanel.getState().showTerminal(cwd);
  const app = useApp.getState();
  if (!app.panelOpen) app.togglePanel();
}
