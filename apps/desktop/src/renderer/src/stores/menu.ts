import { create } from "zustand";
import type { IconName } from "../icons";
// Yön ve sığdırma kararını `MenuLayer` ölçerek verir; burada yalnızca tutunulan yer saklanır.
import { anchorRect, type MenuAnchor, type MenuCallbackAnchor } from "../lib/menuPos";

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Gerçek uygulama simgesi (data URL); varsa `icon` yerine bu çizilir. */
  iconSrc?: string;
  desc?: string;
  key?: string;
  check?: boolean;
  active?: boolean;
  danger?: boolean;
  top?: boolean;
  disabled?: boolean;
  /** Alt menü öğeleri (hover ile açılır). */
  sub?: MenuItem[];
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | { label: string; isLabel: true };

export interface MenuSpec {
  items: MenuEntry[];
  search?: string;
  minWidth?: number;
}

interface MenuState {
  open: { spec: MenuSpec; anchor: MenuAnchor } | null;
  openAt: (anchor: MenuCallbackAnchor, spec: MenuSpec) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  openAt: (anchor, spec) => {
    const r = anchorRect(anchor);
    set({ open: { spec, anchor: { top: r.top, bottom: r.bottom, left: r.left } } });
  },
  close: () => set({ open: null }),
}));
