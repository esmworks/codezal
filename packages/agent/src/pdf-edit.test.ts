import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editedFile, editedFiles } from "./create-tools.js";
import { readPdfContent } from "./pdf.js";
import {
  defaultPdfEditName,
  parsePageRanges,
  resolvePdfEditTargets,
  resolvePdfFont,
} from "./pdf-edit.js";
import { pdfEditTool } from "./pdf-edit-tool.js";
import { evaluatePermission } from "./permission.js";
import { describeTool } from "./tool-info.js";

/** Her sayfasında "Page N" yazan, verilen boyutta küçük bir PDF. */
async function makePdf(pages: number, label = "Page"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`${label} ${i}`, { x: 40, y: 300, size: 18, font });
  }
  return doc.save();
}

/** Metin alanı, onay kutusu, açılır liste ve seçenek grubu taşıyan AcroForm. */
async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField("ad_soyad").addToPage(page, { x: 20, y: 320, width: 300, height: 24 });
  form.createCheckBox("onay").addToPage(page, { x: 20, y: 280, width: 16, height: 16 });
  const city = form.createDropdown("sehir");
  city.addOptions(["Ankara", "Izmir"]);
  city.addToPage(page, { x: 20, y: 240, width: 160, height: 24 });
  const kind = form.createRadioGroup("tur");
  kind.addOptionToPage("bireysel", page, { x: 20, y: 200, width: 14, height: 14 });
  kind.addOptionToPage("kurumsal", page, { x: 60, y: 200, width: 14, height: 14 });
  return doc.save();
}

async function pageCount(path: string): Promise<number> {
  return (await PDFDocument.load(readFileSync(path))).getPageCount();
}

async function pageText(path: string): Promise<string> {
  const parts = await readPdfContent(path, { vision: false });
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

const FONT = resolvePdfFont();

describe("parsePageRanges", () => {
  it("aralık, tek sayfa ve açık uç; sıra korunur, tekrar atlanır", () => {
    expect(parsePageRanges("1-3, 5, 8-", 9)).toEqual([0, 1, 2, 4, 7, 8]);
    expect(parsePageRanges("-2", 5)).toEqual([0, 1]);
    expect(parsePageRanges("4, 2, 4", 5)).toEqual([3, 1]);
  });

  it("geçersiz ve belge dışı aralık hata verir", () => {
    expect(() => parsePageRanges("3-1", 5)).toThrow(/Geçersiz sayfa aralığı/);
    expect(() => parsePageRanges("abc", 5)).toThrow(/Geçersiz/);
    expect(() => parsePageRanges("2-9", 5)).toThrow(/5 sayfa/);
    expect(() => parsePageRanges(" , ", 5)).toThrow(/Geçersiz/);
  });
});

describe("resolvePdfEditTargets", () => {
  it("varsayılan çıktı kaynağın yanında ekli ad; dolu ad atlanır, girdi asla hedef olmaz", () => {
    const taken = new Set(["/d/rapor-rotated.pdf"]);
    const t = resolvePdfEditTargets({ action: "rotate", path: "rapor.pdf" }, "/d", (p) =>
      taken.has(p),
    );
    expect(t.source).toBe("/d/rapor.pdf");
    expect(t.targets).toEqual(["/d/rapor-rotated-2.pdf"]);
  });

  it("göreli output kaynağın klasörüne, .pdf eklenir; açık output girdiyle aynı olabilir", () => {
    const t = resolvePdfEditTargets(
      { action: "watermark", path: "/a/b/teklif.pdf", output: "gizli" },
      "/cwd",
    );
    expect(t.targets).toEqual(["/a/b/gizli.pdf"]);
    const same = resolvePdfEditTargets(
      { action: "rotate", path: "/a/teklif.pdf", output: "teklif.pdf" },
      "/cwd",
    );
    expect(same.targets).toEqual(["/a/teklif.pdf"]);
  });

  it("merge girdileri sırayla, split parça başına bir yol, list_fields yazmaz", () => {
    const merge = resolvePdfEditTargets(
      { action: "merge", path: "a.pdf", inputs: ["b.pdf", "/x/c.pdf"] },
      "/d",
      () => false,
    );
    expect(merge.sources).toEqual(["/d/a.pdf", "/d/b.pdf", "/x/c.pdf"]);
    expect(merge.targets).toEqual(["/d/a-merged.pdf"]);
    const split = resolvePdfEditTargets(
      { action: "split", path: "/d/a.pdf", ranges: ["1", "2-"] },
      "/d",
      () => false,
    );
    expect(split.targets).toEqual(["/d/a-part-1.pdf", "/d/a-part-2.pdf"]);
    const named = resolvePdfEditTargets(
      { action: "split", path: "/d/a.pdf", ranges: ["1", "2-"], output: "bolum.pdf" },
      "/d",
    );
    expect(named.targets).toEqual(["/d/bolum-1.pdf", "/d/bolum-2.pdf"]);
    expect(
      resolvePdfEditTargets({ action: "list_fields", path: "/d/a.pdf" }, "/d").targets,
    ).toEqual([]);
  });

  it("izin kapısı ve tur yedeği aynı yolu görür", () => {
    const input = { action: "split", path: "/nope/a.pdf", ranges: ["1", "2"] };
    expect(editedFiles("pdf_edit", input, "/d")).toEqual([
      "/nope/a-part-1.pdf",
      "/nope/a-part-2.pdf",
    ]);
    expect(editedFile("pdf_edit", input, "/d")).toBe("/nope/a-part-1.pdf");
    expect(editedFiles("pdf_edit", { action: "list_fields", path: "/nope/a.pdf" }, "/d")).toEqual(
      [],
    );
    expect(editedFile("pdf_edit", { action: "list_fields", path: "/nope/a.pdf" }, "/d")).toBe(
      "/nope/a.pdf",
    );
  });
});

describe("pdf_edit kartı ve izni", () => {
  it("yeni dosya kartı; list_fields okuma, girdinin üzerine yazma yerinde düzenleme", () => {
    expect(describeTool("pdf_edit", { action: "rotate", path: "/a/r.pdf" })).toMatchObject({
      kind: "create",
      title: "PDF düzenlendi",
      target: "/a/r-rotated.pdf",
    });
    expect(describeTool("pdf_edit", { action: "list_fields", path: "/a/f.pdf" })).toMatchObject({
      kind: "read",
      target: "/a/f.pdf",
    });
    expect(
      describeTool("pdf_edit", { action: "rotate", path: "/a/r.pdf", output: "r.pdf" }).kind,
    ).toBe("edit");
    expect(defaultPdfEditName("/a/r.pdf", "split", 2)).toBe("/a/r-part-2.pdf");
  });

  it("yazma işlemleri write sınıfında, alan listeleme serbest", () => {
    expect(evaluatePermission("ask", "pdf_edit", { action: "merge" })).toBe("ask");
    expect(evaluatePermission("plan", "pdf_edit", { action: "watermark" })).toBe("block");
    expect(evaluatePermission("auto-edit", "pdf_edit", { action: "rotate" })).toBe("allow");
    expect(evaluatePermission("plan", "pdf_edit", { action: "list_fields" })).toBe("allow");
  });
});

describe("pdf_edit aracı", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cz-pdf-edit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (params: Record<string, unknown>, fontPath = FONT) => {
    const tool = pdfEditTool({ cwd: dir, ...(fontPath ? { fontPath } : {}) });
    const r = await tool.execute("t1", params as never, undefined, undefined, {} as never);
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    return { text, details: r.details };
  };

  it("merge: sayfalar sırayla tek dosyada, girdiler değişmez", async () => {
    writeFileSync(join(dir, "a.pdf"), await makePdf(2, "Alfa"));
    writeFileSync(join(dir, "b.pdf"), await makePdf(3, "Beta"));
    const before = readFileSync(join(dir, "a.pdf"));
    const { text, details } = await run({ action: "merge", path: "a.pdf", inputs: ["b.pdf"] });
    const out = join(dir, "a-merged.pdf");
    expect(details.path).toBe(out);
    expect(await pageCount(out)).toBe(5);
    expect(text).toContain("5 sayfa");
    expect(readFileSync(join(dir, "a.pdf")).equals(before)).toBe(true);
    const content = await pageText(out);
    expect(content).toContain("Alfa 2");
    expect(content.indexOf("Alfa 2")).toBeLessThan(content.indexOf("Beta 1"));
  });

  it("split: her aralık ayrı dosya", async () => {
    writeFileSync(join(dir, "r.pdf"), await makePdf(6));
    const { details } = await run({ action: "split", path: "r.pdf", ranges: ["1-2", "3", "4-"] });
    expect(details.paths).toEqual([
      join(dir, "r-part-1.pdf"),
      join(dir, "r-part-2.pdf"),
      join(dir, "r-part-3.pdf"),
    ]);
    expect(await pageCount(join(dir, "r-part-1.pdf"))).toBe(2);
    expect(await pageCount(join(dir, "r-part-2.pdf"))).toBe(1);
    expect(await pageCount(join(dir, "r-part-3.pdf"))).toBe(3);
    expect(await pageText(join(dir, "r-part-2.pdf"))).toContain("Page 3");
  });

  it("rotate: seçili sayfalar mevcut açıya eklenerek döner; ikinci çağrı yeni ad alır", async () => {
    writeFileSync(join(dir, "r.pdf"), await makePdf(3));
    await run({ action: "rotate", path: "r.pdf", pages: "2-3", angle: 270 });
    const doc = await PDFDocument.load(readFileSync(join(dir, "r-rotated.pdf")));
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 270, 270]);
    const again = await run({ action: "rotate", path: "r-rotated.pdf", pages: "2", angle: 180 });
    expect(again.details.path).toBe(join(dir, "r-rotated-rotated.pdf"));
    const second = await run({ action: "rotate", path: "r.pdf", angle: 180 });
    expect(second.details.path).toBe(join(dir, "r-rotated-2.pdf"));
    const rotated = await PDFDocument.load(readFileSync(join(dir, "r-rotated-rotated.pdf")));
    expect(rotated.getPage(1).getRotation().angle).toBe(90);
    await expect(run({ action: "rotate", path: "r.pdf", angle: 45 })).rejects.toThrow(/90, 180/);
  });

  it("delete_pages ve extract_pages", async () => {
    writeFileSync(join(dir, "r.pdf"), await makePdf(5));
    await run({ action: "delete_pages", path: "r.pdf", pages: "2, 4" });
    const trimmed = join(dir, "r-trimmed.pdf");
    expect(await pageCount(trimmed)).toBe(3);
    const text = await pageText(trimmed);
    expect(text).toContain("Page 3");
    expect(text).not.toContain("Page 2");
    await run({ action: "extract_pages", path: "r.pdf", pages: "5, 1" });
    const extract = join(dir, "r-extract.pdf");
    expect(await pageCount(extract)).toBe(2);
    const ex = await pageText(extract);
    expect(ex.indexOf("Page 5")).toBeLessThan(ex.indexOf("Page 1"));
    await expect(run({ action: "delete_pages", path: "r.pdf", pages: "1-" })).rejects.toThrow(
      /Bütün sayfalar/,
    );
    await expect(run({ action: "extract_pages", path: "r.pdf" })).rejects.toThrow(/pages gerekli/);
  });

  it.runIf(FONT)("watermark: Türkçe metin gömülü yazı tipiyle basılır ve okunur", async () => {
    writeFileSync(join(dir, "r.pdf"), await makePdf(2));
    const { text } = await run({
      action: "watermark",
      path: "r.pdf",
      text: "Şirket İçi Gizli",
      opacity: 0.3,
      angle: 30,
      pages: "2",
    });
    expect(text).toContain("1 sayfaya filigran");
    const out = join(dir, "r-watermarked.pdf");
    // Yazı tipi gömülü (TrueType program akışı), standart 14 yazı tipine düşülmemiş.
    const saved = await PDFDocument.load(readFileSync(out));
    const embedded = saved.context
      .enumerateIndirectObjects()
      .some(([, obj]) => obj instanceof PDFDict && obj.has(PDFName.of("FontFile2")));
    expect(embedded).toBe(true);
    const parts = await readPdfContent(out, { vision: false });
    const pages = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(pages).toContain("Şirket İçi Gizli");
    // Yalnız 2. sayfa: metin 1. sayfada bir kez, 2. sayfada filigranla birlikte geçer.
    expect(pages.split("Şirket İçi Gizli").length - 1).toBe(1);
  });

  it("watermark: yazı tipi yoksa Türkçe metin açık hata verir, ASCII Helvetica'yla basılır", async () => {
    writeFileSync(join(dir, "r.pdf"), await makePdf(1));
    const tool = pdfEditTool({ cwd: dir });
    await expect(
      tool.execute(
        "t1",
        { action: "watermark", path: "r.pdf", text: "Gizlidir şüphesiz" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Unicode yazı tipi/);
    await tool.execute(
      "t2",
      { action: "watermark", path: "r.pdf", text: "TASLAK" },
      undefined,
      undefined,
      {} as never,
    );
    expect(await pageText(join(dir, "r-watermarked.pdf"))).toContain("TASLAK");
  });

  it.runIf(FONT)("fill_form: alanları listeler, Türkçe değeri yazar ve geri okur", async () => {
    writeFileSync(join(dir, "f.pdf"), await makeForm());
    const list = await run({ action: "list_fields", path: "f.pdf" });
    expect(list.text).toContain("ad_soyad [text]");
    expect(list.text).toContain("sehir [dropdown]");
    expect(list.text).toContain("(Ankara | Izmir)");
    expect(list.text).toContain("tur [radio]");
    expect(existsSync(join(dir, "f-filled.pdf"))).toBe(false);

    const value = "Çağrı Şükrü İlgün ğıöü";
    await run({
      action: "fill_form",
      path: "f.pdf",
      fields: [
        { name: "ad_soyad", value },
        { name: "onay", value: true },
        { name: "sehir", value: "ankara" },
        { name: "tur", value: "kurumsal" },
      ],
    });
    const doc = await PDFDocument.load(readFileSync(join(dir, "f-filled.pdf")));
    const form = doc.getForm();
    expect(form.getTextField("ad_soyad").getText()).toBe(value);
    expect(form.getCheckBox("onay").isChecked()).toBe(true);
    expect(form.getDropdown("sehir").getSelected()).toEqual(["Ankara"]);
    expect(form.getRadioGroup("tur").getSelected()).toBe("kurumsal");

    await run({
      action: "fill_form",
      path: "f.pdf",
      output: "duz",
      flatten: true,
      fields: [{ name: "ad_soyad", value }],
    });
    const flat = join(dir, "duz.pdf");
    expect((await PDFDocument.load(readFileSync(flat))).getForm().getFields()).toHaveLength(0);
    expect(await pageText(flat)).toContain(value);
  });

  it.runIf(FONT)("fill_form: bilinmeyen alan ve seçenek açık hata verir", async () => {
    writeFileSync(join(dir, "f.pdf"), await makeForm());
    await expect(
      run({ action: "fill_form", path: "f.pdf", fields: [{ name: "yok", value: "x" }] }),
    ).rejects.toThrow(/"yok" adlı alan yok. Alanlar: ad_soyad/);
    await expect(
      run({ action: "fill_form", path: "f.pdf", fields: [{ name: "sehir", value: "Bursa" }] }),
    ).rejects.toThrow(/Seçenekler: Ankara, Izmir/);
    expect(existsSync(join(dir, "f-filled.pdf"))).toBe(false);
  });

  it("şifreli PDF açık Türkçe hata verir, dosya yazılmaz", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 2, R: 3 });
    writeFileSync(join(dir, "s.pdf"), await doc.save({ useObjectStreams: false }));
    await expect(run({ action: "rotate", path: "s.pdf" })).rejects.toThrow(
      /PDF şifreli ya da parola korumalı/,
    );
    expect(existsSync(join(dir, "s-rotated.pdf"))).toBe(false);
  });

  it("eksik dosya ve PDF olmayan girdi", async () => {
    await expect(run({ action: "rotate", path: "yok.pdf" })).rejects.toThrow(/PDF bulunamadı/);
    writeFileSync(join(dir, "a.txt"), "x");
    await expect(run({ action: "rotate", path: "a.txt" })).rejects.toThrow(/yalnız .pdf/);
    await expect(run({ action: "merge", path: "a.pdf" })).rejects.toThrow(/en az bir PDF/);
  });
});
