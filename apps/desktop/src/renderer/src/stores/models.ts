import type {
  CatalogModel,
  ModelRef,
  PermissionMode,
  ProviderInfo,
  ThinkingLevel,
} from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";
import { i18n } from "../lib/i18n";
import { loadJson, saveJson } from "../lib/storage";
import { toast } from "./toast";

interface Persisted {
  model: ModelRef | null;
  permission: PermissionMode;
  thinking: ThinkingLevel;
  /** Son seçilen modeller, en yeni önde (model seçicide "Son kullanılan"). */
  recent: ModelRef[];
}

interface ModelsState extends Persisted {
  providers: ProviderInfo[];
  catalog: CatalogModel[];
  loading: boolean;
  /** Uzak katalog çekiliyor ("Katalogu yenile"); listenin kendi yüklemesinden ayrı tutulur. */
  refreshing: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setModel: (model: ModelRef) => void;
  setPermission: (permission: PermissionMode) => void;
  setThinking: (thinking: ThinkingLevel) => void;
  setApiKey: (provider: string, apiKey: string, label?: string) => Promise<void>;
  logout: (provider: string) => Promise<void>;
  removeApiKey: (provider: string, keyId: string) => Promise<void>;
  activateApiKey: (provider: string, keyId: string) => Promise<void>;
}

const KEY = "codezal.models";
const persisted = loadJson<Persisted>(KEY, {
  model: null,
  permission: "ask",
  thinking: "low",
  recent: [],
});

function persist(s: ModelsState) {
  saveJson(KEY, {
    model: s.model,
    permission: s.permission,
    thinking: s.thinking,
    recent: s.recent,
  });
}

export const useModels = create<ModelsState>((set, get) => ({
  ...persisted,
  recent: persisted.recent ?? [],
  providers: [],
  catalog: [],
  loading: false,
  refreshing: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [providers, catalog] = await Promise.all([
        invoke("models:providers", undefined),
        invoke("models:catalog", undefined),
      ]);
      let model = get().model;
      const stillValid =
        model && catalog.some((m) => m.provider === model?.provider && m.id === model?.id);
      if (!stillValid) {
        const first = catalog.find((m) => m.available) ?? null;
        model = first ? { provider: first.provider, id: first.id } : null;
      }
      set({ providers, catalog, model, loading: false });
      persist(get());
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  refresh: async () => {
    set({ refreshing: true });
    try {
      // Ağ hatası motorda yutulur; buraya yalnızca güncel liste döner.
      await invoke("models:refresh", undefined);
      await get().load();
    } finally {
      set({ refreshing: false });
    }
  },
  setModel: (model) => {
    const rest = get().recent.filter((r) => !(r.provider === model.provider && r.id === model.id));
    set({ model, recent: [model, ...rest].slice(0, 4) });
    persist(get());
  },
  setPermission: (permission) => {
    set({ permission });
    persist(get());
  },
  setThinking: (thinking) => {
    set({ thinking });
    persist(get());
  },
  setApiKey: async (provider, apiKey, label) => {
    await invoke("models:setApiKey", { provider, apiKey, ...(label ? { label } : {}) });
    await get().load();
  },
  logout: async (provider) => {
    await invoke("models:logout", { provider });
    await get().load();
  },
  removeApiKey: async (provider, keyId) => {
    await invoke("models:removeApiKey", { provider, keyId });
    await get().load();
  },
  activateApiKey: async (provider, keyId) => {
    await invoke("models:activateApiKey", { provider, keyId });
    await get().load();
  },
}));

/** Yuva adı: etiket varsa o, yoksa "Anahtar N" (N = listedeki sıra). */
export function slotName(
  slot: { id: string; label?: string | undefined; hint: string },
  keys: readonly { id: string }[],
): string {
  if (slot.label) return slot.label;
  const index = keys.findIndex((k) => k.id === slot.id);
  const n = index >= 0 ? index + 1 : 0;
  return n > 0 ? i18n.t("settings.connection.keyN", { n }) : `…${slot.hint}`;
}

// Uzak katalog tazelendi ve liste değişti: model seçici ve ayarlar güncel listeyi görsün.
on("models:changed", () => {
  void useModels.getState().load();
});

// Limit dolunca anahtar değişti: kısa bildirim ve sağlayıcı listesini yenile.
on("credential:rotated", (ev) => {
  const state = useModels.getState();
  void state.load();
  // Geçilecek başka anahtar yoksa rotasyon olmamıştır. Pi çoğu zaman kendi yeniden denemesiyle
  // sürdürür ve ilk başarılı istekte soğuma silinir; "tüm anahtarlar dolu" bildirimi saniyeler
  // sonra yanlış çıkıyordu. Gerçekten tıkanırsa hata bandı görünür, soğuma Ayarlar'da yazar.
  if (!ev.to) return;
  const provider = state.providers.find((p) => p.id === ev.provider);
  const keys = provider?.keys ?? [];
  toast.info(
    i18n.t("settings.connection.rotated", {
      provider: provider?.name ?? ev.provider,
      to: slotName(ev.to, keys),
      from: slotName(ev.from, keys),
      time: new Date(ev.cooldownUntil).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    }),
  );
});
