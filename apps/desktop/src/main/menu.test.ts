import { tr } from "@codezal/i18n";
import { describe, expect, it, vi } from "vitest";

let captured: unknown = null;

vi.mock("electron", () => ({
  app: { name: "Codezal", isPackaged: false, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: (template: unknown) => {
      captured = template;
    },
  },
  shell: { openExternal: () => {} },
}));

const { installMenu } = await import("./menu");

/** Menü şablonunda etikete göre hızlandırıcıyı bulur (alt menüler dahil). */
function acceleratorOf(label: string): string | undefined {
  const items = captured as Array<{
    submenu?: Array<{ label?: string; accelerator?: string; submenu?: unknown }>;
  }>;
  for (const item of items) {
    for (const entry of item.submenu ?? []) {
      if (entry.label === label) return entry.accelerator;
    }
  }
  return undefined;
}

describe("installMenu", () => {
  it("kullanıcı tanımlı kısayolu menüye yazar", () => {
    installMenu("tr", { search: "CmdOrCtrl+P" });
    expect(acceleratorOf(tr.menu.search)).toBe("CmdOrCtrl+P");
  });

  it("tanımsız komutta varsayılanı kullanır", () => {
    installMenu("tr");
    expect(acceleratorOf(tr.menu.search)).toBe("CmdOrCtrl+K");
  });

  it("sohbet içi bulma Düzen menüsünde ⌘F ile durur", () => {
    installMenu("tr");
    expect(acceleratorOf(tr.menu.find)).toBe("CmdOrCtrl+F");
  });

  it("askıya alma hızlandırıcıları kaldırır", () => {
    installMenu("tr", undefined, true);
    expect(acceleratorOf(tr.menu.search)).toBeUndefined();
  });
});
