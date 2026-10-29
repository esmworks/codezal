import type { PermissionMode, ThinkingLevel } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import type { TFunction } from "i18next";
import type { IconName } from "../icons";
import type { MenuEntry } from "../stores/menu";

/**
 * İzin modu ve düşünme seviyesi menülerinin satırları. Çipler (`chips.tsx`) ve `/mod` ile
 * `/düşünme` komutları aynı listeyi çizer: menü iki yerde kopyalanınca birinde etiket, öbüründe
 * sıra farklılaşıyordu (ZCode da komut ve çip için tek katalog kullanır).
 */

export const PERMISSION_ICONS: Record<PermissionMode, IconName> = {
  ask: "permAsk",
  "auto-edit": "permAuto",
  plan: "permPlan",
  full: "permFull",
};

export const PERMISSION_KEYS: Record<PermissionMode, TranslationKey> = {
  ask: "permissionMode.ask",
  "auto-edit": "permissionMode.auto-edit",
  plan: "permissionMode.plan",
  full: "permissionMode.full",
};

const PERMISSION_DESC_KEYS: Record<PermissionMode, TranslationKey> = {
  ask: "chips.permAsk",
  "auto-edit": "chips.permAuto",
  plan: "chips.permPlan",
  full: "chips.permFull",
};

export const THINKING_KEYS: Record<ThinkingLevel, TranslationKey> = {
  low: "thinkingLevel.low",
  high: "thinkingLevel.high",
  max: "thinkingLevel.max",
};

/** İzin modu menüsü: dört mod, açıklamalı, seçili olan işaretli. */
export function permissionMenuItems(
  t: TFunction,
  value: PermissionMode,
  onPick: (mode: PermissionMode) => void,
): MenuEntry[] {
  const modes = Object.keys(PERMISSION_KEYS) as PermissionMode[];
  return modes.map((mode) => ({
    label: t(PERMISSION_KEYS[mode]),
    icon: PERMISSION_ICONS[mode],
    desc: t(PERMISSION_DESC_KEYS[mode]),
    check: mode === value,
    active: mode === value,
    onSelect: () => onPick(mode),
  }));
}

/** Düşünme seviyesi menüsü. */
export function thinkingMenuItems(
  t: TFunction,
  value: ThinkingLevel,
  onPick: (level: ThinkingLevel) => void,
): MenuEntry[] {
  const levels = Object.keys(THINKING_KEYS) as ThinkingLevel[];
  return levels.map((level) => ({
    label: t(THINKING_KEYS[level]),
    check: level === value,
    active: level === value,
    onSelect: () => onPick(level),
  }));
}
