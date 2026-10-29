import { useApp } from "../stores/app";
import { usePanel } from "../stores/panel";

/** Panel kapalıysa açar; açık panel kullanıcının seçimini bozmaz. */
export function showPanel(): void {
  const app = useApp.getState();
  if (!app.panelOpen) app.togglePanel();
}

/**
 * Bir alt ajan koşusunu sağ panelin "İşler" sekmesinde, ayrıntı görünümünde açar (Claude'daki
 * "Background tasks" gibi): geri oku listeye döner.
 *
 * `openTab` yalnız sekmeyi seçer; panel kapalıysa hiçbir şey görünmez. Durum kartı ise tanımı
 * gereği panel kapalıyken çizilir (`showEnv = !panelOpen`), bu yüzden tıklamanın paneli de açması
 * şarttır. Sohbetteki "Canlı izle" düğmesi panel açıkken de çağrılabildiği için açma koşulludur.
 */
export function revealAgent(sessionId: string, runId: string): void {
  usePanel.getState().showJob({ sessionId, kind: "agent", id: runId });
  showPanel();
}

/** Oturumun bütün işlerini (çalışan ve biten ajanlar, arka plan komutları) liste olarak açar. */
export function revealJobs(): void {
  usePanel.getState().showJob(null);
  showPanel();
}
