import { describe, expect, it, vi } from "vitest";

// Kapı node:path'i doğrudan kullandığından Windows davranışı ancak win32 uygulaması takılarak
// sınanabilir; macOS/Linux üzerinde koşan testte ayraç hatası aksi halde görünmez.
vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...path.win32, default: path.win32 };
});

const { createOutputsGuard } = await import("./outputs-guard.js");

const CWD = "C:\\Users\\e\\AppData\\Roaming\\Codezal\\asistan\\p1";
const OUT = "C:\\Users\\e\\Documents\\Codezal Asistan\\Finans\\Çıktılar";

describe("createOutputsGuard (Windows)", () => {
  it("ters bölülü çıktı ve çalışma klasörünü içeride sayar", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("write", { path: `${OUT}\\rapor.md` })).toBeUndefined();
    expect(guard("write", { path: `${OUT}\\alt\\rapor.md` })).toBeUndefined();
    expect(guard("write", { path: "gecici.txt" })).toBeUndefined();
    expect(guard("write", { path: `${CWD}\\alt\\x.md` })).toBeUndefined();
  });

  it("düz bölülü yazılan aynı klasörü de tanır, dışarısını engeller", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(
      guard("write", { path: "C:/Users/e/Documents/Codezal Asistan/Finans/Çıktılar/rapor.md" }),
    ).toBe(undefined);
    expect(guard("write", { path: `${OUT}2\\rapor.md` })).toBeDefined();
    expect(guard("write", { path: "D:\\yedek\\rapor.md" })).toContain(OUT);
  });
});
