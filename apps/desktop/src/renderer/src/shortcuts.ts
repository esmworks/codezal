import { type AppCommand, resolveAccelerator } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { isMac } from "./lib/platform";
import { type Layout, shortcutHint, shortcutKeys } from "./lib/shortcutKeys";
import { useSettings } from "./stores/settings";

/**
 * Kısayol etiketleri: `SHORTCUTS` tek kaynak, gösterim platforma ve klavye düzenine göre çözülür.
 * Biçimlendirme `lib/shortcutKeys` içinde saf işlevlerde; burada yalnızca düzen haritası okunur.
 */

interface KeyboardLayout {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

// Düzen haritası süreç başına bir kez okunur; tüm çağıranlar aynı sonucu paylaşır.
let layout: Layout = null;
const waiting = new Set<() => void>();
let started = false;

function loadLayout(): void {
  if (started) return;
  started = true;
  const kb = (navigator as Navigator & { keyboard?: KeyboardLayout }).keyboard;
  if (!kb?.getLayoutMap) return;
  void kb.getLayoutMap().then(
    (map) => {
      layout = map;
      for (const notify of waiting) notify();
    },
    () => {
      // Düzen okunamazsa ABD karşılıkları gösterilir; işlev kaybı yok.
    },
  );
}

/** Harita hazır olduğunda bileşeni yeniden çizer; hazırsa hiç beklemez. */
function useLayoutReady(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    loadLayout();
    if (layout) return;
    const notify = () => bump((n) => n + 1);
    waiting.add(notify);
    return () => {
      waiting.delete(notify);
    };
  }, []);
}

export function useResolvedAccelerator(command: AppCommand): string {
  const overrides = useSettings((x) => x.settings?.keybindings);
  return resolveAccelerator(command, overrides);
}

/** Ayarlar > Klavye kısayolları listesindeki tuş kutuları. */
export function useShortcutKeys(accelerator: string): string[] {
  useLayoutReady();
  return shortcutKeys(accelerator, isMac, layout);
}

/** Menü ve ipucu metinlerindeki tek satırlık gösterim: "⌘N" ya da "Ctrl+N". */
export function useShortcutHint(command: AppCommand): string {
  useLayoutReady();
  return shortcutHint(useResolvedAccelerator(command), isMac, layout);
}
