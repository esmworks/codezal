import { create } from "zustand";
import { invoke } from "../api";

interface PathsState {
  home: string;
  documents: string;
  userData: string;
  /** Plan modunda yazılan plan dosyalarının kökü (userData/plans). */
  plansDir: string;
  loaded: boolean;
  load: () => Promise<void>;
}

/** Uygulama yolları (ev, Belgeler, userData); ilk kullanımda bir kez yüklenir. */
export const usePaths = create<PathsState>((set, get) => ({
  home: "",
  documents: "",
  userData: "",
  plansDir: "",
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const p = await invoke("app:paths", undefined);
    set({
      home: p.home,
      documents: p.documents,
      userData: p.userData,
      plansDir: p.plansDir,
      loaded: true,
    });
  },
}));
