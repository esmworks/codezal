import { create } from "zustand";
import { reportFirstRender } from "../lib/perf";
import { useAssistant } from "./assistant";
import { useProjects } from "./projects";
import { useSessions } from "./sessions";
import { humanizeError } from "./toast";

export type StartupStatus = "loading" | "ready" | "error";

interface StartupState {
  /**
   * Kenar çubuğunu dolduran ilk yüklemelerin durumu (projeler, oturumlar, asistan projeleri).
   * Liste gelmeden ya da IPC hatasında kenar çubuğu "Henüz proje yok" diyordu; kullanıcı
   * projelerinin silindiğini sanıyordu.
   */
  status: StartupStatus;
  error: string | null;
  load: () => Promise<void>;
}

export const useStartup = create<StartupState>((set) => ({
  status: "loading",
  error: null,
  load: async () => {
    set({ status: "loading", error: null });
    // Biri düşse de diğerleri yüklensin: `allSettled`, ilk hata diğer listeleri yarıda bırakmaz.
    const results = await Promise.allSettled([
      useProjects.getState().load(),
      useSessions.getState().loadList(),
      useAssistant.getState().load(),
    ]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) set({ status: "error", error: humanizeError(failed.reason) });
    else {
      set({ status: "ready", error: null });
      // Kenar çubuğu dolu ilk kare "ilk anlamlı boyama"dır (PRD 11 açılış ölçütü).
      reportFirstRender();
    }
  },
}));
