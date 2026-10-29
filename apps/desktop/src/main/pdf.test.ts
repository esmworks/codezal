import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PdfRenderInput } from "@codezal/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `BrowserWindow` taklidi: yapıcı seçenekleri, yüklenen dosyanın o anki içeriği ve `printToPDF`
 * seçenekleri kaydedilir. Geçici klasör `finally` içinde silindiği için HTML yükleme anında okunur.
 */
const h = vi.hoisted(() => ({
  options: [] as unknown[],
  loaded: [] as Array<{ file: string; html: string }>,
  printOptions: [] as unknown[],
  destroyed: 0,
  load: null as null | ((file: string) => Promise<void>),
  print: null as null | (() => Promise<Buffer>),
  filter: null as null | FilterFn,
  partitions: [] as string[],
  nextId: 1,
  navigateBlocked: 0,
}));

type FilterFn = (
  details: { url: string; resourceType: string; webContentsId?: number },
  callback: (r: { cancel: boolean }) => void,
) => void;

vi.mock("electron", () => {
  const pdfSession = {
    webRequest: {
      onBeforeRequest: (fn: FilterFn) => {
        h.filter = fn;
      },
    },
  };
  const session = {
    fromPartition: (name: string) => {
      h.partitions.push(name);
      return pdfSession;
    },
  };
  class BrowserWindow {
    webContents = {
      id: h.nextId++,
      on: (name: string, fn: (e: { preventDefault: () => void }) => void) => {
        if (name === "will-navigate") fn({ preventDefault: () => h.navigateBlocked++ });
      },
      printToPDF: async (o: unknown) => {
        h.printOptions.push(o);
        return h.print ? h.print() : Buffer.from("%PDF-1.7 sahte");
      },
    };
    constructor(o: unknown) {
      h.options.push(o);
    }
    async loadFile(file: string): Promise<void> {
      const fs = await import("node:fs");
      h.loaded.push({ file, html: fs.readFileSync(file, "utf8") });
      if (h.load) await h.load(file);
    }
    destroy() {
      h.destroyed++;
    }
  }
  return { BrowserWindow, session };
});

const { isPdfRequestAllowed, renderPdf } = await import("./pdf");

function input(over: Partial<PdfRenderInput> = {}): PdfRenderInput {
  return {
    html: "<html><head><title>x</title></head><body><p>Merhaba</p></body></html>",
    baseDir: "/Users/ben/Proje",
    pageSize: "A4",
    landscape: false,
    ...over,
  };
}

function lastLoaded(): { file: string; html: string } {
  const l = h.loaded.at(-1);
  if (!l) throw new Error("yüklenen dosya yok");
  return l;
}

beforeEach(() => {
  h.options.length = 0;
  h.loaded.length = 0;
  h.printOptions.length = 0;
  h.destroyed = 0;
  h.load = null;
  h.print = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("renderPdf", () => {
  it("gizli pencere betiksiz, sandbox'lı ve Node'suz açılır", async () => {
    await renderPdf(input());
    expect(h.options).toEqual([
      {
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
          webSecurity: true,
          session: expect.anything(),
        },
      },
    ]);
    expect(h.partitions.every((p) => p === "codezal-pdf")).toBe(true);
    // Betiksiz `<meta http-equiv="refresh">` gezinmesi de durdurulur.
    expect(h.navigateBlocked).toBeGreaterThan(0);
  });

  it("HTML geçici klasördeki belge.html'e <head> hemen ardına taban adresiyle yazılır", async () => {
    await renderPdf(input());
    const { file, html } = lastLoaded();
    expect(file.startsWith(join(tmpdir(), "codezal-pdf-"))).toBe(true);
    expect(file.endsWith(`${sep}belge.html`)).toBe(true);
    expect(html).toBe(
      '<html><head><base href="file:///Users/ben/Proje/"><title>x</title></head><body><p>Merhaba</p></body></html>',
    );
  });

  it("taban klasör sonuna ayraç eklenir (yinelenmez); boşluk ve Türkçe karakter kodlanır", async () => {
    await renderPdf(input({ baseDir: `/Users/ben/Çıktılar klasörü${sep}` }));
    const base = /<base href="([^"]+)">/.exec(lastLoaded().html)?.[1];
    expect(base).toBe(pathToFileURL(`/Users/ben/Çıktılar klasörü${sep}`).href);
    expect(base?.endsWith("/")).toBe(true);
    expect(base).not.toContain("//Çık");
    expect(base).toContain("%20");
  });

  it("belge kendi <base> etiketini verdiyse dokunulmaz; <head> yoksa başa eklenir", async () => {
    await renderPdf(input({ html: '<head><base href="https://ornek.com/"></head><p>a</p>' }));
    expect(lastLoaded().html).toBe('<head><base href="https://ornek.com/"></head><p>a</p>');
    await renderPdf(input({ html: "<p>başsız</p>" }));
    expect(lastLoaded().html).toBe('<base href="file:///Users/ben/Proje/"><p>başsız</p>');
  });

  it("baskı seçenekleri girdiden gelir; arka plan basılır, CSS sayfa ölçüsü önceliklidir", async () => {
    await renderPdf(input({ pageSize: "Letter", landscape: true }));
    expect(h.printOptions).toEqual([
      { pageSize: "Letter", landscape: true, printBackground: true, preferCSSPageSize: true },
    ]);
  });

  it("PDF baytları kopyasız Uint8Array görünümü olarak döner (ofsetli tampon dahil)", async () => {
    const pool = Buffer.from("xxxx%PDF-içerikyyyy");
    h.print = async () => pool.subarray(4, pool.length - 4);
    const out = await renderPdf(input());
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out).toString()).toBe("%PDF-içerik");
    expect(out.buffer).toBe(pool.buffer);
  });

  it("başarıda pencere kapanır ve geçici klasör silinir", async () => {
    await renderPdf(input());
    expect(h.destroyed).toBe(1);
    expect(existsSync(dirname(lastLoaded().file))).toBe(false);
  });

  it("printToPDF hatası yükselir; pencere yine kapanır, geçici klasör yine silinir", async () => {
    h.print = async () => {
      throw new Error("yazdırma başarısız");
    };
    await expect(renderPdf(input())).rejects.toThrow("yazdırma başarısız");
    expect(h.destroyed).toBe(1);
    expect(existsSync(dirname(lastLoaded().file))).toBe(false);
  });

  it("yükleme hatası (ör. ERR_FAILED) yükselir ve temizlik yapılır", async () => {
    h.load = async () => {
      throw new Error("ERR_FAILED (-2) loading");
    };
    await expect(renderPdf(input())).rejects.toThrow("ERR_FAILED");
    expect(h.printOptions).toHaveLength(0);
    expect(h.destroyed).toBe(1);
    expect(existsSync(dirname(lastLoaded().file))).toBe(false);
  });

  it("yükleme 20 sn'de bitmezse sayfa eksik kaynakla yine basılır (tur asılı kalmaz)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    h.load = () => new Promise<void>(() => {});
    const done = renderPdf(input());
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.printOptions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeInstanceOf(Uint8Array);
    expect(h.printOptions).toHaveLength(1);
    expect(h.destroyed).toBe(1);
  });

  it("göreli görsel yolu PDF klasörüne göre çözülür", async () => {
    await renderPdf(input({ html: '<head></head><img src="gorseller/logo.png">' }));
    const base = /<base href="([^"]+)">/.exec(lastLoaded().html)?.[1] ?? "";
    expect(new URL("gorseller/logo.png", base).href).toBe(
      "file:///Users/ben/Proje/gorseller/logo.png",
    );
  });
});

/**
 * Regresyon: model HTML'e `<iframe src="file:///…/.ssh/id_rsa">` ya da `<object>` koyunca dosyanın
 * metni PDF'e basılıyordu (gerçek Electron 44'te pdfjs ile metin çıkarılarak görüldü).
 */
describe("isPdfRequestAllowed", () => {
  const scope = { file: "/tmp/codezal-pdf-x/belge.html", baseDir: "/Users/ben/Proje" };

  it("ana çerçeve yalnız geçici HTML'dir; yönlendirilen yerel dosya yüklenmez", () => {
    expect(isPdfRequestAllowed("file:///tmp/codezal-pdf-x/belge.html", "mainFrame", scope)).toBe(
      true,
    );
    expect(isPdfRequestAllowed("file:///Users/ben/.ssh/id_rsa", "mainFrame", scope)).toBe(false);
    expect(isPdfRequestAllowed("https://ornek.com/", "mainFrame", scope)).toBe(false);
  });

  it("iç çerçeve ve gömülü nesne hiçbir kaynaktan yüklenmez", () => {
    for (const url of [
      "file:///Users/ben/.ssh/id_rsa",
      "file:///Users/ben/Proje/not.txt",
      "https://ornek.com/",
    ]) {
      expect(isPdfRequestAllowed(url, "subFrame", scope), url).toBe(false);
      expect(isPdfRequestAllowed(url, "object", scope), url).toBe(false);
    }
  });

  it("yerel kaynak yalnız PDF klasöründen gelir; `..` ve benzer önekli klasör dışarıda kalır", () => {
    expect(isPdfRequestAllowed("file:///Users/ben/Proje/logo.png", "image", scope)).toBe(true);
    expect(isPdfRequestAllowed("file:///Users/ben/Proje/a/b.woff2", "font", scope)).toBe(true);
    expect(isPdfRequestAllowed("file:///Users/ben/Proje/../x.png", "image", scope)).toBe(false);
    expect(isPdfRequestAllowed("file:///Users/ben/Proje2/x.png", "image", scope)).toBe(false);
    expect(isPdfRequestAllowed("file:///etc/passwd", "stylesheet", scope)).toBe(false);
  });

  it("uzak ve data: kaynaklar serbest, başka şemalar kapalı", () => {
    expect(isPdfRequestAllowed("https://cdn.ornek.com/a.png", "image", scope)).toBe(true);
    expect(isPdfRequestAllowed("http://ornek.com/a.css", "stylesheet", scope)).toBe(true);
    expect(isPdfRequestAllowed("data:image/png;base64,AAAA", "image", scope)).toBe(true);
    expect(isPdfRequestAllowed("codezal-file:///Users/ben/x.png", "image", scope)).toBe(false);
  });

  it("süzgeç isteği yapan pencerenin kapsamını kullanır; pencere kapanınca kapsam kalkar", async () => {
    let seen: { cancel: boolean } | undefined;
    h.load = async () => {
      const id = h.nextId - 1;
      h.filter?.(
        { url: "file:///Users/ben/Proje/logo.png", resourceType: "image", webContentsId: id },
        (r) => {
          seen = r;
        },
      );
    };
    await renderPdf(input());
    expect(seen).toEqual({ cancel: false });
    // Kapanan pencerenin kimliğiyle gelen geç istek artık reddedilir.
    h.filter?.(
      {
        url: "file:///Users/ben/Proje/logo.png",
        resourceType: "image",
        webContentsId: h.nextId - 1,
      },
      (r) => {
        seen = r;
      },
    );
    expect(seen).toEqual({ cancel: true });
  });
});
