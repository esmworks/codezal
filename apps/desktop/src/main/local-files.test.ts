import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFileUrl } from "@codezal/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

const { isForeignReferrer, localFileResponse } = await import("./local-files");

describe("localFileResponse", () => {
  const dir = mkdtempSync(join(tmpdir(), "codezal-lf-"));
  writeFileSync(join(dir, "Çıktı 1.pdf"), "%PDF-1.4");
  writeFileSync(join(dir, "sayfa.html"), "<script>1</script>");
  writeFileSync(join(dir, "notlar.md"), "# Not");
  writeFileSync(
    join(dir, "cizim.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  );

  it("PDF'i içerik türüyle servis eder", async () => {
    const res = localFileResponse(localFileUrl(join(dir, "Çıktı 1.pdf")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF-1.4");
  });

  it("Range isteğinde 206 ve yalnızca istenen baytları döner", async () => {
    const res = localFileResponse(localFileUrl(join(dir, "Çıktı 1.pdf")), "bytes=1-3");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1-3/8");
    expect(await res.text()).toBe("PDF");
  });

  it("geçersiz aralığa 416 döner", () => {
    const res = localFileResponse(localFileUrl(join(dir, "Çıktı 1.pdf")), "bytes=99-200");
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */8");
  });

  it("önizlenemeyen türü ve yabancı şemayı reddeder, eksik dosyaya 404 döner", () => {
    expect(localFileResponse(localFileUrl(join(dir, "notlar.md"))).status).toBe(403);
    expect(localFileResponse("file:///etc/hosts").status).toBe(403);
    expect(localFileResponse(localFileUrl(join(dir, "yok.pdf"))).status).toBe(404);
  });

  it("SVG'yi betik çalıştırmayan politika ve nosniff ile servis eder", () => {
    const res = localFileResponse(localFileUrl(join(dir, "cizim.svg")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HTML'i UTF-8 ve betiksiz sandbox politikasıyla servis eder", () => {
    const res = localFileResponse(localFileUrl(join(dir, "sayfa.html")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp.split(";")[0]).toBe("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src codezal-file: data:");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("allow-scripts");
  });

  it("PDF'e SVG politikasını uygulamaz ama nosniff ekler", () => {
    const res = localFileResponse(localFileUrl(join(dir, "Çıktı 1.pdf")));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("isForeignReferrer", () => {
  it("boş, file: ve kendi şemasından gelen istekleri kabul eder", () => {
    expect(isForeignReferrer("")).toBe(false);
    expect(isForeignReferrer("about:client")).toBe(false);
    expect(isForeignReferrer("file:///Applications/Codezal.app/index.html")).toBe(false);
    expect(isForeignReferrer("codezal-file://local/a.pdf")).toBe(false);
  });

  it("geliştirme sunucusunun kendi kökenini kabul eder", () => {
    expect(isForeignReferrer("http://localhost:5173/#/x", "http://localhost:5173")).toBe(false);
  });

  it("gömülü tarayıcıdaki siteden gelen isteği reddeder", () => {
    expect(isForeignReferrer("https://kotu.example/", "http://localhost:5173")).toBe(true);
    expect(isForeignReferrer("http://localhost:5174/", "http://localhost:5173")).toBe(true);
    expect(isForeignReferrer("https://kotu.example/")).toBe(true);
  });
});
