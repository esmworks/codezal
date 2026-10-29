import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXlsx, markdownToDocx } from "@codezal/agent";
import { afterAll, describe, expect, it } from "vitest";
import { listDir, readFile, searchFiles } from "./files";

const dir = mkdtempSync(join(tmpdir(), "cz-files-"));
mkdirSync(join(dir, "src", "ui"), { recursive: true });
mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
writeFileSync(join(dir, "src", "ui", "Session.tsx"), "export const a = 1;\n");
writeFileSync(join(dir, "src", "index.ts"), "");
writeFileSync(join(dir, "node_modules", "x", "index.js"), "");
writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("files", () => {
  it("klasörleri önce, node_modules'ü gizli listeler ve rozet uygular", () => {
    const nodes = listDir(dir, dir, new Map([["src/index.ts", "M"]]));
    expect(nodes.map((n) => n.name)).toEqual(["src", "bin.dat"]);
    expect(nodes[0]?.badge).toBe("M");
  });
  it("kök dışına çıkmayı reddeder", () => {
    expect(() => listDir(dir, join(dir, ".."), new Map())).toThrow();
  });
  it("ada göre arar", () => {
    const r = searchFiles(dir, "sess");
    expect(r.map((n) => n.name)).toEqual(["Session.tsx"]);
  });
  it("ikili dosyayı tanır", () => {
    expect(readFile(join(dir, "bin.dat")).binary).toBe(true);
    expect(readFile(join(dir, "src", "ui", "Session.tsx")).content).toContain("export");
  });
  it("Word belgesine okuma görünümü ekler; bozuk paket önizlemesiz ikili kalır", async () => {
    const { bytes } = await markdownToDocx("# Teklif\n\nFiyat **120 TL**", {
      baseDir: dir,
      pageSize: "A4",
      landscape: false,
      pageNumbers: false,
    });
    writeFileSync(join(dir, "teklif.docx"), bytes);
    const file = readFile(join(dir, "teklif.docx"));
    expect(file.binary).toBe(true);
    expect(file.markdown).toBe("# Teklif\n\nFiyat **120 TL**");
    writeFileSync(join(dir, "bozuk.docx"), Buffer.from([0, 1, 2]));
    expect(readFile(join(dir, "bozuk.docx")).markdown).toBeUndefined();
    expect(readFile(join(dir, "bin.dat")).markdown).toBeUndefined();
  });
  it("Excel kitabına sayfa tablolu okuma görünümü ekler", () => {
    const { bytes } = buildXlsx([
      {
        name: "Özet",
        rows: [
          ["Ad", "Adet"],
          ["x", 2],
        ],
      },
    ]);
    writeFileSync(join(dir, "ozet.xlsx"), bytes);
    const file = readFile(join(dir, "ozet.xlsx"));
    expect(file.binary).toBe(true);
    expect(file.markdown).toContain("## Sayfa 1: Özet");
    expect(file.markdown).toContain("| 2 | x | 2 |");
  });
});
