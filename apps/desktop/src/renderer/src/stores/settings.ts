import type { AppSettings } from "@codezal/contracts";
import { localeTag } from "@codezal/i18n";
import { create } from "zustand";
import { invoke } from "../api";
import { i18n } from "../lib/i18n";
import { useApp } from "./app";

interface SettingsState {
  settings: AppSettings | null;
  load: () => Promise<void>;
  patch: (patch: Partial<AppSettings>) => Promise<void>;
}

/** Kalıcı ayarlar (main'deki settings.json). Tema değişimi app mağazasına da yansır. */
export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  load: async () => {
    const settings = await invoke("settings:get", undefined);
    set({ settings });
    useApp.getState().setTheme(settings.theme);
    useApp.setState({ userName: settings.profileName });
    applyLanguage(settings.language);
  },
  patch: async (patch) => {
    const cur = get().settings;
    // İyimser güncelleme: anahtar anında yer değiştirsin. Yazım düşerse **geri alınır** ve
    // hata bildirilir; aksi hâlde anahtar açık görünürken ayar dosyasına hiç yazılmamış olurdu
    // (kullanıcı uygulamayı yeniden açınca "kendi kendine kapandı" sanır).
    if (cur) set({ settings: { ...cur, ...patch } });
    let settings: AppSettings;
    try {
      settings = await invoke("settings:set", patch);
    } catch (error) {
      if (cur) set({ settings: cur });
      if (patch.theme) useApp.getState().setTheme(cur?.theme ?? patch.theme);
      throw error;
    }
    set({ settings });
    if (patch.theme) useApp.getState().setTheme(patch.theme);
    if (patch.profileName !== undefined) useApp.setState({ userName: patch.profileName });
    applyLanguage(settings.language);
  },
}));

/** Uygulama dilini i18next'e ve belgenin dil özniteliğine uygular. */
function applyLanguage(language: AppSettings["language"]): void {
  if (i18n.language !== language) void i18n.changeLanguage(language);
  // a11y: ekran okuyucu ve yazım denetimi doğru dili görsün; index.html'deki sabit değer yerine.
  document.documentElement.lang = localeTag(language);
}
