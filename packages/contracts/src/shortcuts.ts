import type { AppCommand } from "./ipc.js";

export interface Shortcut {
  command: AppCommand;
  /** Electron accelerator biçimi. */
  accelerator: string;
  group: "Genel" | "Oturum";
}

/**
 * Tek doğruluk kaynağı: menü hızlandırıcıları ve Ayarlar > Klavye kısayolları buradan türetilir.
 * Etiket yok: gösterilen ad i18n'den gelir (`shortcuts.<komut>.label`).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { command: "new-task", accelerator: "CmdOrCtrl+N", group: "Genel" },
  { command: "search", accelerator: "CmdOrCtrl+K", group: "Genel" },
  { command: "settings", accelerator: "CmdOrCtrl+,", group: "Genel" },
  { command: "toggle-sidebar", accelerator: "CmdOrCtrl+\\", group: "Genel" },
  { command: "toggle-panel", accelerator: "CmdOrCtrl+G", group: "Oturum" },
  { command: "terminal", accelerator: "CmdOrCtrl+J", group: "Oturum" },
  { command: "changes", accelerator: "CmdOrCtrl+Shift+G", group: "Oturum" },
  { command: "commit", accelerator: "CmdOrCtrl+Shift+K", group: "Oturum" },
  { command: "model", accelerator: "CmdOrCtrl+Shift+M", group: "Oturum" },
  { command: "find", accelerator: "CmdOrCtrl+F", group: "Oturum" },
];

/**
 * "CmdOrCtrl+Shift+G" → ["⌘", "⇧", "G"] (macOS) ya da ["Ctrl", "Shift", "G"]. Harf ve noktalama
 * ABD düzenine göredir; kullanıcının düzeninde hangi tuşa denk geldiğini arayüz ayrıca çözer.
 */
export function acceleratorKeys(acc: string, mac: boolean): string[] {
  return acc.split("+").map((part) => {
    if (part === "CmdOrCtrl") return mac ? "⌘" : "Ctrl";
    if (part === "Shift") return mac ? "⇧" : "Shift";
    if (part === "Alt") return mac ? "⌥" : "Alt";
    return part;
  });
}

/** Kısayolun etkin hızlandırıcısı: kullanıcı tanımlıysa o, yoksa varsayılan. */
export function resolveAccelerator(
  command: AppCommand,
  overrides?: Record<string, string> | undefined,
): string {
  const custom = overrides?.[command];
  if (custom) return custom;
  return SHORTCUTS.find((s) => s.command === command)?.accelerator ?? "";
}
