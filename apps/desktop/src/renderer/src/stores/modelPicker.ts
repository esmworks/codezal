import type { ModelRef } from "@codezal/contracts";
import { create } from "zustand";
import { anchorRect, type MenuCallbackAnchor } from "../lib/menuPos";

interface ModelPickerState {
  open: { rect: DOMRect; onChange: (ref: ModelRef) => void; current: ModelRef | null } | null;
  /**
   * `current`: işaretlenecek model (oturumun modeli); verilmezse genel tercih. Çapa bir öğe ya da
   * hazır dikdörtgen olabilir: çipler öğeyle açar, `/model` komutu kompozerin dikdörtgeniyle
   * (çip görünürde yokken de seçici girişin üstünde belirsin).
   */
  openAt: (
    anchor: MenuCallbackAnchor,
    onChange: (ref: ModelRef) => void,
    current?: ModelRef | null,
  ) => void;
  close: () => void;
}

/** Model seçici katmanı: tek örnek, App kökünde çizilir. */
export const useModelPicker = create<ModelPickerState>((set) => ({
  open: null,
  openAt: (anchor, onChange, current = null) =>
    set({ open: { rect: anchorRect(anchor), onChange, current } }),
  close: () => set({ open: null }),
}));
