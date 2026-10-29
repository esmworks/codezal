import type { UpdateStatus } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

export type UpdateView = "hidden" | "badge" | "card";

/**
 * Kart görünürlüğü. `error` yalnızca bilinen bir yeni sürümün indirme/kurulum hatasında gösterilir;
 * denetim hataları (sürüm bilinmiyor) Ayarlar > Hesap satırında kalır.
 */
export function updateView(
  status: UpdateStatus,
  minimized: boolean,
  snoozed: string | null,
): UpdateView {
  const { version } = status;
  if (!version || version === status.currentVersion) return "hidden";
  switch (status.state) {
    case "available":
    case "downloading":
    case "ready":
    case "error":
      return minimized && snoozed === version ? "badge" : "card";
    default:
      return "hidden";
  }
}

interface UpdateState {
  status: UpdateStatus;
  minimized: boolean;
  /** Kartı kapatınca hatırlanan sürüm; aynı sürümde kart kendiliğinden geri açılmaz. */
  snoozed: string | null;
  load: () => Promise<void>;
  snooze: () => void;
  reopen: () => void;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

/** Yeni sürüm görülünce kart kapanmışsa geri açılır; aynı sürümde "Sonra" kararı korunur. */
function applyStatus(status: UpdateStatus): void {
  useUpdate.setState((s) => {
    const isNew = !!status.version && status.version !== s.status.version;
    return isNew ? { status, minimized: false, snoozed: null } : { status };
  });
}

export const useUpdate = create<UpdateState>((set, get) => ({
  status: { state: "disabled" },
  minimized: false,
  snoozed: null,
  load: async () => applyStatus(await invoke("app:updateStatus", undefined)),
  snooze: () => set({ minimized: true, snoozed: get().status.version ?? null }),
  reopen: () => set({ minimized: false }),
  download: async () => applyStatus(await invoke("app:downloadUpdate", undefined)),
  install: async () => {
    await invoke("app:installUpdate", undefined);
  },
}));

on("update:status", applyStatus);
