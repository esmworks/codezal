import type { ProviderQuota } from "@codezal/contracts";
import { create } from "zustand";
import { invoke } from "../api";

interface QuotaState {
  items: ProviderQuota[];
  loading: boolean;
  /** Önbellekteki kotayı okur; ağa çıkmaz. */
  load: () => Promise<void>;
  /** Kotayı tazeler; `force` önbellek ömrünü yok sayar (elle "Yenile"). */
  refresh: (provider?: string, force?: boolean) => Promise<void>;
}

export const useQuota = create<QuotaState>((set, get) => ({
  items: [],
  loading: false,
  load: async () => {
    try {
      set({ items: await invoke("quota:list", undefined) });
    } catch {
      // Kota okunamazsa rozetler "okunamadı" durumunda kalır; sayfa çalışmaya devam eder.
    }
  },
  refresh: async (provider, force = false) => {
    set({ loading: true });
    try {
      const fresh = await invoke("quota:refresh", {
        ...(provider ? { provider } : {}),
        force,
      });
      // Tek sağlayıcı tazelenince yanıt yalnız onu içerir; listeyi onunla değiştirmek diğer
      // rozetleri "yükleniyor"a düşürürdü.
      const items = provider
        ? [...get().items.filter((q) => q.provider !== provider), ...fresh]
        : fresh;
      set({ items, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));

/** Sağlayıcı kimliğiyle kota kaydını bulur. */
export function quotaOf(
  items: readonly ProviderQuota[],
  provider: string,
): ProviderQuota | undefined {
  return items.find((q) => q.provider === provider);
}
