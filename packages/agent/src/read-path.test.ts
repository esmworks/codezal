import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandReadPath, resolveReadPath } from "./read-path.js";

const dir = mkdtempSync(join(tmpdir(), "codezal-read-path-"));

describe("expandReadPath", () => {
  it("baştaki @ işaretini atar", () => {
    expect(expandReadPath("@Çıktılar/rapor.pdf", "/proje")).toBe("/proje/Çıktılar/rapor.pdf");
  });

  it("~ genişletir ve mutlak yola dokunmaz", () => {
    expect(expandReadPath("~/rapor.pdf", "/proje")).toBe(join(process.env.HOME ?? "", "rapor.pdf"));
    expect(expandReadPath("/mutlak/rapor.pdf", "/proje")).toBe("/mutlak/rapor.pdf");
  });
});

describe("resolveReadPath", () => {
  it("diskteki NFD yazımını bulur", async () => {
    // macOS dosya adlarını ayrıştırılmış (NFD) tutar; model adı NFC yazar.
    const nfd = join(dir, "Çıktılar.pdf".normalize("NFD"));
    writeFileSync(nfd, "x");
    const found = await resolveReadPath("Çıktılar.pdf".normalize("NFC"), dir);
    expect(found.exists).toBe(true);
    expect(found.path.normalize("NFC")).toBe(join(dir, "Çıktılar.pdf").normalize("NFC"));
  });

  it("bulunamayan dosyada genişletilmiş yolu ve exists=false döner", async () => {
    const missing = await resolveReadPath("@yok.pdf", dir);
    expect(missing).toEqual({ path: join(dir, "yok.pdf"), exists: false });
  });
});
