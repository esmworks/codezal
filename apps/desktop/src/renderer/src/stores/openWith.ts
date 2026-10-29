import type { OpenWithApp } from "@codezal/contracts";
import { create } from "zustand";
import { invoke } from "../api";
import { useSettings } from "./settings";
import { humanizeError, toast } from "./toast";

interface OpenWithState {
  apps: OpenWithApp[];
  /**
   * Kurulu uygulama listesini tazeler ve taze listeyi döner. Menü, öğeleri bu dönüşten kurar:
   * durum güncellemesi bir sonraki çizime kaldığı için `apps` okunsa kullanıcı az önce kurduğu
   * uygulamayı bir sonraki açılışta görürdü.
   */
  load: () => Promise<OpenWithApp[]>;
  open: (appId: string, path: string) => Promise<void>;
}

/** "Şurada aç": liste main'de tespit edilir, son seçim ayarlarda saklanır. */
export const useOpenWith = create<OpenWithState>((set, get) => ({
  apps: [],
  load: async () => {
    try {
      const apps = await invoke("openWith:list", undefined);
      set({ apps });
      return apps;
    } catch (error) {
      toast.error(humanizeError(error));
      return get().apps;
    }
  },
  open: async (appId, path) => {
    // Tercih açmadan önce yazılır: açma başarısız olsa da menü son seçimi hatırlar.
    await useSettings.getState().patch({ openWithApp: appId });
    try {
      await invoke("openWith:open", { appId, path });
    } catch (error) {
      toast.error(humanizeError(error));
    }
  },
}));
