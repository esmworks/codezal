import type { SkillCatalog } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface SkillsState {
  catalog: SkillCatalog | null;
  /** Son yüklenen kapsam; `skills:changed` gelince aynı kapsam yenilenir. */
  cwd: string | null;
  loading: boolean;
  load: (cwd: string | null) => Promise<void>;
  setEnabled: (path: string, enabled: boolean) => Promise<void>;
  addSource: (path: string) => Promise<void>;
  removeSource: (path: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
}

/** Beceri kataloğu; main'deki Pi ayar dosyasını yansıtır. */
export const useSkills = create<SkillsState>((set, get) => ({
  catalog: null,
  cwd: null,
  loading: false,
  load: async (cwd) => {
    set({ cwd, loading: true });
    try {
      const catalog = await invoke("skills:list", { cwd });
      // Bu arada kapsam değiştiyse eski yanıtı yazma.
      if (get().cwd === cwd) set({ catalog });
    } finally {
      set({ loading: false });
    }
  },
  setEnabled: async (path, enabled) => {
    const cur = get().catalog;
    if (cur) {
      set({
        catalog: {
          ...cur,
          skills: cur.skills.map((r) => (r.path === path ? { ...r, enabled } : r)),
        },
      });
    }
    try {
      await invoke("skills:setEnabled", { cwd: get().cwd, path, enabled });
    } catch (error) {
      // Yazım düşerse anahtar eski konumuna döner: aksi hâlde arayüz dosyayla çelişir ve
      // kullanıcı becerinin açık olduğunu sanır (main `skills:changed`ı yalnız başarıda yayar).
      if (cur) set({ catalog: cur });
      throw error;
    }
  },
  addSource: (path) => invoke("skills:addSource", { path }),
  removeSource: (path) => invoke("skills:removeSource", { path }),
  reveal: (path) => invoke("skills:reveal", { path }),
}));

on("skills:changed", () => {
  const { cwd, catalog } = useSkills.getState();
  if (catalog) void useSkills.getState().load(cwd);
});
