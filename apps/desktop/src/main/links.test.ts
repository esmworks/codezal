import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.fn(async (_url: string) => undefined);
vi.mock("electron", () => ({ shell: { openExternal } }));
vi.mock("./ipc.js", () => ({ broadcast: vi.fn() }));

const { isLocalUrl, isSafeExternalUrl, linkTargetFor, openExternalSafe, openLink } = await import(
  "./links.js"
);

describe("isLocalUrl", () => {
  it("yerel adresleri tanır", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:3000/a",
      "http://app.localhost:8080",
      "https://mac-mini.local/panel",
      "http://[::1]:4000",
    ])
      expect(isLocalUrl(url), url).toBe(true);
  });

  it("genel adresleri yerel saymaz", () => {
    for (const url of ["https://ornek.com", "https://localhost.ornek.com", "http://10.0.0.5"])
      expect(isLocalUrl(url), url).toBe(false);
  });

  it("bozuk adreste yerel demez", () => {
    expect(isLocalUrl("bu bir adres değil")).toBe(false);
  });
});

describe("linkTargetFor", () => {
  const s = { linkTarget: "system", localLinkTarget: "app" } as Parameters<typeof linkTargetFor>[1];

  it("yerel adres için yerel ayarı, diğerleri için web ayarını kullanır", () => {
    expect(linkTargetFor("http://localhost:3000", s)).toBe("app");
    expect(linkTargetFor("https://ornek.com", s)).toBe("system");
  });
});

describe("isSafeExternalUrl", () => {
  it("https adresini kabul eder", () => {
    expect(isSafeExternalUrl("https://github.com/login/device")).toBe(true);
  });

  it("http'yi yalnız loopback'te kabul eder", () => {
    expect(isSafeExternalUrl("http://127.0.0.1:1455/callback")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:8080/auth")).toBe(true);
    expect(isSafeExternalUrl("http://[::1]:9000/")).toBe(true);
    expect(isSafeExternalUrl("http://ornek.com/auth")).toBe(false);
    expect(isSafeExternalUrl("http://127.0.0.1.evil.com/")).toBe(false);
    expect(isSafeExternalUrl("http://yazici.local/")).toBe(false);
  });

  it("allowHttp ile genel http adresine izin verir", () => {
    expect(isSafeExternalUrl("http://ornek.com", { allowHttp: true })).toBe(true);
  });

  it("dosya, özel şema ve bozuk adresi reddeder", () => {
    for (const url of [
      "file:///etc/passwd",
      "smb://sunucu/paylasim",
      "ms-msdt:/id PCWDiagnostic",
      "javascript:alert(1)",
      "vscode://file/tmp/a",
      "data:text/html,<b>x</b>",
      "bu bir adres değil",
    ]) {
      expect(isSafeExternalUrl(url, { allowHttp: true }), url).toBe(false);
    }
  });
});

describe("openExternalSafe", () => {
  beforeEach(() => openExternal.mockClear());

  it("güvenli adresi sisteme verir", async () => {
    expect(await openExternalSafe("https://ornek.com")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://ornek.com");
  });

  it("güvensiz adresi açmaz", async () => {
    expect(await openExternalSafe("file:///Applications/Calculator.app")).toBe(false);
    expect(await openExternalSafe("http://ornek.com")).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("openLink sistem tarayıcısına yalnız http(s) verir", async () => {
    const s = { linkTarget: "system", localLinkTarget: "system" } as Parameters<typeof openLink>[1];
    openLink("http://ornek.com", s);
    openLink("file:///etc/hosts", s);
    await Promise.resolve();
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual(["http://ornek.com"]);
  });
});
