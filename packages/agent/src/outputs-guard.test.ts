import { describe, expect, it } from "vitest";
import { createOutputsGuard } from "./outputs-guard.js";

const CWD = "/tmp/cz/asistan/p1";
const OUT = "/Users/e/Documents/Codezal Asistan/Finans/Çıktılar";

describe("createOutputsGuard", () => {
  it("çıktı ve çalışma klasörüne yazmaya izin verir, başka yeri ilk seferde engeller", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("write", { path: `${OUT}/rapor.md` })).toBeUndefined();
    expect(guard("write", { path: "gecici.txt" })).toBeUndefined();
    expect(guard("write", { path: `${CWD}/alt/x.md` })).toBeUndefined();
    expect(guard("read", { path: "/Users/e/iCloud/Finans/a.md" })).toBeUndefined();
    const reason = guard("write", { path: "/Users/e/iCloud/Finans/rapor.md" });
    expect(reason).toContain(OUT);
  });

  it("aynı yola ikinci denemeyi bilinçli sayıp geçirir", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("write", { path: "/Users/e/iCloud/Finans/rapor.md" })).toBeDefined();
    expect(guard("write", { path: "/Users/e/iCloud/Finans/rapor.md" })).toBeUndefined();
    expect(guard("write", { path: "/Users/e/iCloud/Finans/baska.md" })).toBeDefined();
  });

  it("docx_create: göreli ad çıktı klasörüne düşer, dışarıdaki mutlak yol engellenir", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("docx_create", { path: "teklif" })).toBeUndefined();
    expect(guard("docx_create", { path: "/Users/e/Masaüstü/teklif.docx" })).toContain(OUT);
  });

  it("docx_edit: yerinde düzenleme serbest, dışarıya `output` ilk seferde engellenir", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("docx_edit", { path: "/Users/e/Masaüstü/teklif.docx" })).toBeUndefined();
    expect(guard("docx_edit", { path: `${OUT}/teklif.docx`, output: "teklif-2" })).toBeUndefined();
    expect(
      guard("docx_edit", { path: "/Users/e/Masaüstü/teklif.docx", output: "teklif-2" }),
    ).toContain(OUT);
  });

  it("xlsx_create ve xlsx_edit: docx ile aynı kapı", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("xlsx_create", { path: "maliyet" })).toBeUndefined();
    expect(guard("xlsx_create", { path: "/Users/e/Masaüstü/maliyet.xlsx" })).toContain(OUT);
    expect(guard("xlsx_edit", { path: "/Users/e/Masaüstü/maliyet.xlsx" })).toBeUndefined();
    expect(
      guard("xlsx_edit", { path: "/Users/e/Masaüstü/maliyet.xlsx", output: "maliyet-2" }),
    ).toContain(OUT);
  });

  it("pdf_edit: kaynağın yanına varsayılan çıktı serbest, dışarıya `output` ilk seferde engellenir", () => {
    const guard = createOutputsGuard(CWD, OUT);
    const src = "/Users/e/Masaüstü/teklif.pdf";
    expect(guard("pdf_edit", { action: "rotate", path: src })).toBeUndefined();
    expect(
      guard("pdf_edit", { action: "rotate", path: `${OUT}/t.pdf`, output: "t2" }),
    ).toBeUndefined();
    expect(guard("pdf_edit", { action: "watermark", path: src, output: "gizli" })).toContain(OUT);
  });

  it("pdf_create: göreli ad çıktı klasörüne düşer, dışarıdaki mutlak yol engellenir", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("pdf_create", { path: "rapor" })).toBeUndefined();
    expect(guard("pdf_create", { path: `${CWD}/gecici.pdf` })).toBeUndefined();
    expect(guard("pdf_create", { path: "/Users/e/iCloud/Finans/rapor.pdf" })).toContain(OUT);
  });

  it("çıktı klasörüne benzeyen komşu klasörü dışarı sayar", () => {
    const guard = createOutputsGuard(CWD, OUT);
    expect(guard("write", { path: `${OUT}2/rapor.md` })).toBeDefined();
  });

  it("kod deposu altındaki eski çıktı klasörünü dışarı sayar", () => {
    // Kural değişmeden önce çıktılar <Belgeler>/Codezal/<proje>/Çıktılar altındaydı; o yol artık dışarıda.
    const guard = createOutputsGuard(CWD, OUT);
    expect(
      guard("write", { path: "/Users/e/Documents/Codezal/Finans/Çıktılar/rapor.md" }),
    ).toBeDefined();
  });
});
