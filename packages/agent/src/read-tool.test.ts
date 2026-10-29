import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildDocx, p, r, style } from "./docx.fixture.js";
import { writePdf } from "./pdf.fixture.js";
import { readTool } from "./read-tool.js";
import { buildXlsx } from "./xlsx-build.js";

type Params = { path: string; offset?: number; limit?: number; render?: boolean; search?: string };

// Pi gerçek oturumda `ctx.cwd`'yi aracın cwd'siyle aynı verir; göreli yol oradan çözülür.
const ctx = (cwd: string, vision: boolean) =>
  ({ cwd, model: { input: vision ? ["text", "image"] : ["text"] } }) as unknown as ExtensionContext;

const run = (cwd: string, params: Params, vision = true) =>
  readTool(cwd).execute("t1", params, undefined, undefined, ctx(cwd, vision));

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

describe("read sarmalayıcısı", () => {
  it("açıklaması PDF'i ve sayfa anlamını söyler, render parametresi taşır", () => {
    const tool = readTool("/tmp");
    expect(tool.name).toBe("read");
    expect(tool.description).toContain("PDF");
    expect(tool.description).toContain("2000 satır");
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "path",
      "offset",
      "limit",
      "render",
      "search",
    ]);
    expect(readTool("/tmp", "en").description).toContain("PDF");
  });

  it("PDF olmayan dosyayı Pi'nin read aracına bırakır", async () => {
    const pdf = await writePdf([{ text: "x" }]);
    const dir = dirname(pdf);
    await writeFile(join(dir, "not.txt"), "birinci satır\nikinci satır\n", "utf8");
    const out = textOf(await run(dir, { path: "not.txt", offset: 2 }));
    expect(out).toContain("ikinci satır");
    expect(out).not.toContain("birinci satır");
  });

  it("PDF'i sayfa sayfa okur; offset ve limit sayfa anlamındadır", async () => {
    const pdf = await writePdf([{ text: "Birinci" }, { text: "Ikinci" }, { text: "Ucuncu" }]);
    const out = textOf(await run(dirname(pdf), { path: "belge.pdf", offset: 2, limit: 1 }));
    expect(out).toContain("PDF: belge.pdf");
    expect(out).toContain("Ikinci");
    expect(out).not.toContain("Birinci");
    expect(out).not.toContain("Ucuncu");
    expect(out).toContain("offset=3");
  });

  it("search PDF'te eşleşen sayfaları döndürür; PDF olmayan dosyada hata verir", async () => {
    const pdf = await writePdf([{ text: "Giris" }, { text: "Model GS-450 teknik veri" }]);
    const out = textOf(await run(dirname(pdf), { path: "belge.pdf", search: "gs-450" }));
    expect(out).toContain("--- sayfa 2 (1 eşleşme) ---");
    expect(out).not.toContain("Giris");
    await writeFile(join(dirname(pdf), "not.txt"), "GS-450\n", "utf8");
    await expect(run(dirname(pdf), { path: "not.txt", search: "GS-450" })).rejects.toThrow("grep");
  });

  it("render istenince metin sayfası da görüntü olarak gelir; görselsiz modelde gelmez", async () => {
    const pdf = await writePdf([{ text: "Duz metin sayfasi" }]);
    const withImage = await run("/", { path: pdf, render: true });
    expect(withImage.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(withImage)).toContain("Duz metin sayfasi");
    const plain = await run("/", { path: pdf });
    expect(plain.content.some((c) => c.type === "image")).toBe(false);
    const blind = await run("/", { path: pdf, render: true }, false);
    expect(blind.content.some((c) => c.type === "image")).toBe(false);
  });

  it("Word belgesini Markdown olarak okur; bozuk paket için okunamadı hatası", async () => {
    const pdf = await writePdf([{ text: "x" }]);
    const dir = dirname(pdf);
    await writeFile(
      join(dir, "rapor.docx"),
      buildDocx(p(r("Özet"), style("Balk1")) + p(r("Çalışma"))),
    );
    const out = textOf(await run(dir, { path: "rapor.docx" }));
    expect(out).toContain("Word: rapor.docx");
    expect(out).toContain("# Özet\n\nÇalışma");
    expect(readTool("/tmp").description).toContain(".docx");
    await writeFile(join(dir, "bozuk.docx"), "eski biçim");
    await expect(run(dir, { path: "bozuk.docx" })).rejects.toThrow(/Word belgesi okunamadı/);
  });

  it("Excel kitabını sayfa sayfa Markdown tablo olarak okur; eski .xls okunamadı hatası verir", async () => {
    const pdf = await writePdf([{ text: "x" }]);
    const dir = dirname(pdf);
    const { bytes } = buildXlsx([
      {
        name: "Teklif",
        rows: [
          ["Kalem", "Tutar"],
          ["A", "=2*3"],
        ],
      },
    ]);
    await writeFile(join(dir, "teklif.xlsx"), bytes);
    const out = textOf(await run(dir, { path: "teklif.xlsx" }));
    expect(out).toContain("Excel: teklif.xlsx");
    expect(out).toContain("| 2 | A | 6 |");
    expect(out).toContain("- B2: `=2*3`");
    expect(readTool("/tmp").description).toContain(".xlsx");
    await writeFile(join(dir, "bozuk.xlsx"), "eski biçim");
    await expect(run(dir, { path: "bozuk.xlsx" })).rejects.toThrow(/Excel dosyası okunamadı/);
  });

  it("olmayan PDF için Pi'nin hatası döner, bozuk PDF için okunamadı hatası", async () => {
    await expect(run("/tmp", { path: "/tmp/yok-boyle-bir-dosya.pdf" })).rejects.toThrow();
    const pdf = await writePdf([{ text: "x" }], "bozuk.pdf");
    await writeFile(pdf, "bu bir pdf degil", "utf8");
    await expect(run("/", { path: pdf })).rejects.toThrow(/PDF okunamadı/);
  });
});
