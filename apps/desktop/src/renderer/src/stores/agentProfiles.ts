import type { AgentCatalog, AgentDraft, AgentInfo, ModelRef } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface AgentProfilesState {
  catalog: AgentCatalog | null;
  /** Son yüklenen kapsam; `agents:changed` gelince aynı kapsam yenilenir. */
  cwd: string | null;
  loading: boolean;
  busy: boolean;
  load: (cwd: string | null) => Promise<void>;
  create: (draft: AgentDraft) => Promise<AgentInfo>;
  update: (id: string, draft: AgentDraft) => Promise<AgentInfo>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Gömülü ajanın modeli; `null` ana oturumun modelini devralmak demektir. */
  setModelOverride: (id: string, model: ModelRef | null) => Promise<void>;
  reveal: (path: string) => Promise<void>;
}

/**
 * Alt ajan tanımları (Ayarlar > Ajanlar). Depo motorda (`engine.agents`) olduğu için sayfada
 * kaydedilen değişiklik modelin gördüğü listeyle aynıdır; main her yazma sonrası
 * `agents:changed` yayar ve açık oturumları tazeler.
 */
export const useAgentProfiles = create<AgentProfilesState>((set, get) => ({
  catalog: null,
  cwd: null,
  loading: false,
  busy: false,
  load: async (cwd) => {
    set({ cwd, loading: true });
    try {
      const catalog = await invoke("agents:list", { cwd });
      // Bu arada kapsam değiştiyse eski yanıtı yazma.
      if (get().cwd === cwd) set({ catalog });
    } finally {
      set({ loading: false });
    }
  },
  create: async (draft) => {
    set({ busy: true });
    try {
      return await invoke("agents:create", { cwd: get().cwd, draft });
    } finally {
      set({ busy: false });
    }
  },
  update: async (id, draft) => {
    set({ busy: true });
    try {
      return await invoke("agents:update", { cwd: get().cwd, id, draft });
    } finally {
      set({ busy: false });
    }
  },
  remove: async (id) => {
    set({ busy: true });
    try {
      await invoke("agents:delete", { cwd: get().cwd, id });
    } finally {
      set({ busy: false });
    }
  },
  setEnabled: async (id, enabled) => {
    const cur = get().catalog;
    // Anahtar anında dönsün: yazma başarısız olursa `agents:changed` listeyi geri getirir.
    if (cur) {
      set({
        catalog: { ...cur, agents: cur.agents.map((a) => (a.id === id ? { ...a, enabled } : a)) },
      });
    }
    await invoke("agents:setEnabled", { id, enabled });
  },
  setModelOverride: async (id, model) => {
    await invoke("agents:setModelOverride", { id, model });
  },
  reveal: (path) => invoke("agents:reveal", { path }),
}));

on("agents:changed", () => {
  const { cwd, catalog } = useAgentProfiles.getState();
  if (catalog) void useAgentProfiles.getState().load(cwd);
});
