import type { AuditStartOptions, AuditView } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface AuditState {
  /** Görüntülenen oturum; geç gelen yanıtlar bu kimlikle karşılaştırılır. */
  sessionId: string | null;
  view: AuditView | null;
  loading: boolean;
  busy: boolean;
  /** Son dışa aktarılan PDF yolu (toast/bağlantı için). */
  exported: string | null;
  load: (sessionId: string) => Promise<void>;
  start: (sessionId: string, options?: AuditStartOptions) => Promise<void>;
  exportReport: (sessionId: string) => Promise<string | null>;
  reveal: (sessionId: string) => Promise<void>;
}

/**
 * Denetim run'ı görünümü. Durum uygulamada (`userData/audits`) tutulur; burada yalnızca panelin
 * gördüğü kompakt görünüm önbelleğe alınır ve `audit:changed` olayında tazelenir.
 */
export const useAudit = create<AuditState>((set, get) => ({
  sessionId: null,
  view: null,
  loading: false,
  busy: false,
  exported: null,
  load: async (sessionId) => {
    set({ sessionId, loading: true });
    try {
      const view = await invoke("audit:state", { sessionId });
      if (get().sessionId === sessionId) set({ view });
    } finally {
      set({ loading: false });
    }
  },
  start: async (sessionId, options) => {
    set({ busy: true });
    try {
      const view = await invoke("audit:start", {
        sessionId,
        options: options ?? { profile: "standard" },
      });
      set({ sessionId, view });
    } finally {
      set({ busy: false });
    }
  },
  exportReport: async (sessionId) => {
    set({ busy: true });
    try {
      const { path } = await invoke("audit:export", { sessionId });
      set({ exported: path });
      return path;
    } finally {
      set({ busy: false });
    }
  },
  reveal: (sessionId) => invoke("audit:reveal", { sessionId }),
}));

on("audit:changed", ({ sessionId }) => {
  if (useAudit.getState().sessionId === sessionId) void useAudit.getState().load(sessionId);
});
