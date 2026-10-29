import { describe, expect, it, vi } from "vitest";

// Store modül düzeyinde `on("update:status")` ile abone oluyor; node ortamında köprü yok.
vi.mock("../api", () => ({ invoke: vi.fn(), on: () => () => {} }));

import { updateView } from "./update";

const app = "1.0.0";
const next = "1.1.0";

describe("updateView", () => {
  it("yeni sürüm yokken kart görünmez", () => {
    expect(updateView({ state: "disabled" }, false, null)).toBe("hidden");
    expect(updateView({ state: "idle", version: app, currentVersion: app }, false, null)).toBe(
      "hidden",
    );
    expect(updateView({ state: "checking", version: app, currentVersion: app }, false, null)).toBe(
      "hidden",
    );
  });

  it("yeni sürüm bulununca kart, 'Sonra' deyince rozet olur", () => {
    const available = { state: "available", version: next, currentVersion: app } as const;
    expect(updateView(available, false, null)).toBe("card");
    expect(updateView(available, true, next)).toBe("badge");
    // Başka bir sürüm için "Sonra" kararı geçersiz: kart geri açılır.
    expect(updateView(available, true, "1.0.5")).toBe("card");
  });

  it("indirme ve hazır durumları rozete izin verir", () => {
    const downloading = {
      state: "downloading",
      version: next,
      currentVersion: app,
      percent: 42,
    } as const;
    const ready = { state: "ready", version: next, currentVersion: app } as const;
    expect(updateView(downloading, true, next)).toBe("badge");
    expect(updateView(ready, true, next)).toBe("badge");
    expect(updateView(ready, false, next)).toBe("card");
  });

  it("denetim hatası kart açmaz, indirme hatası açar", () => {
    expect(
      updateView({ state: "error", message: "ağ", version: app, currentVersion: app }, false, null),
    ).toBe("hidden");
    expect(
      updateView(
        { state: "error", message: "ağ", version: next, currentVersion: app },
        false,
        null,
      ),
    ).toBe("card");
  });
});
