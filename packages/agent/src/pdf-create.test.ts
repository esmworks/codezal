import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countPdfPages,
  type PdfRenderInput,
  pdfCreateTool,
  resolvePdfPath,
  withBaseHref,
} from "./pdf-create.js";

describe("resolvePdfPath", () => {
  it("göreli ad çıktı klasörüne, o yoksa çalışma klasörüne gider; .pdf eklenir", () => {
    expect(resolvePdfPath("rapor", "/cwd", "/out")).toBe("/out/rapor.pdf");
    expect(resolvePdfPath("alt/rapor.PDF", "/cwd", "/out")).toBe("/out/alt/rapor.PDF");
    expect(resolvePdfPath("rapor.pdf", "/cwd")).toBe("/cwd/rapor.pdf");
  });

  it("mutlak yol olduğu gibi kalır", () => {
    expect(resolvePdfPath("/tmp/x/teklif.pdf", "/cwd", "/out")).toBe("/tmp/x/teklif.pdf");
  });
});

describe("withBaseHref", () => {
  it("head'in hemen ardına ekler", () => {
    expect(withBaseHref("<html><head><title>a</title></head><body/></html>", "file:///o/")).toBe(
      '<html><head><base href="file:///o/"><title>a</title></head><body/></html>',
    );
  });

  it("head yoksa başa koyar, var olan base'e dokunmaz", () => {
    expect(withBaseHref("<p>x</p>", "file:///o/")).toBe('<base href="file:///o/"><p>x</p>');
    const own = '<head><base href="https://x/"></head>';
    expect(withBaseHref(own, "file:///o/")).toBe(own);
  });
});

describe("countPdfPages", () => {
  it("/Type /Page nesnelerini sayar, /Pages ağacını saymaz", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type /Pages /Kids[]>>\n2 0 obj<</Type /Page>>\n3 0 obj<</Type/Page>>\n",
    );
    expect(countPdfPages(pdf)).toBe(2);
    expect(countPdfPages(Buffer.from("bos"))).toBe(0);
  });
});

describe("pdf_create aracı", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cz-pdf-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("HTML'i çevirir, dosyayı yazar, yol ve sayfa sayısını bildirir", async () => {
    const calls: PdfRenderInput[] = [];
    const render = async (input: PdfRenderInput) => {
      calls.push(input);
      return Buffer.from("%PDF-1.4\n<</Type /Page>>\n<</Type /Page>>\n");
    };
    const tool = pdfCreateTool(render, { cwd: "/cwd", outputsDir: dir });
    const r = await tool.execute(
      "t1",
      { path: "alt/rapor", html: "<h1>Merhaba</h1>" },
      undefined,
      undefined,
      {} as never,
    );
    const path = join(dir, "alt", "rapor.pdf");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("%PDF");
    expect(calls[0]).toEqual({
      html: "<h1>Merhaba</h1>",
      baseDir: join(dir, "alt"),
      pageSize: "A4",
      landscape: false,
    });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    expect(text).toContain(path);
    expect(text).toContain("2 sayfa");
    expect(r.details).toMatchObject({ path, pages: 2 });
  });

  it("çevirici hata verirse dosya yazılmaz, hata gerekçeyle döner", async () => {
    const tool = pdfCreateTool(
      async () => {
        throw new Error("zaman aşımı");
      },
      { cwd: dir },
    );
    await expect(
      tool.execute("t1", { path: "x", html: "<p>a</p>" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/zaman aşımı/);
    expect(existsSync(join(dir, "x.pdf"))).toBe(false);
  });

  it("boş HTML reddedilir", async () => {
    const tool = pdfCreateTool(async () => Buffer.alloc(0), { cwd: dir });
    await expect(
      tool.execute("t1", { path: "x", html: "   " }, undefined, undefined, {} as never),
    ).rejects.toThrow(/HTML/);
  });
});
