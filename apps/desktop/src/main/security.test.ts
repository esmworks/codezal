import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Electron taklidi: `app.on` ve oturum izin işleyicileri yakalanır; `web-contents-created`
 * olayına sahte bir webContents verilip kurulan dinleyiciler doğrudan çağrılır.
 */
const h = vi.hoisted(() => ({
  appOn: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: h.appOn },
  session: {
    defaultSession: {
      setPermissionRequestHandler: h.setPermissionRequestHandler,
      setPermissionCheckHandler: h.setPermissionCheckHandler,
    },
  },
}));
vi.mock("./log.js", () => ({ log: { warn: h.warn } }));

const { hardenWebContents } = await import("./security");

type Listener = (...args: unknown[]) => void;
type OpenHandler = (d: { url: string }) => { action: string };

interface FakeContents {
  listeners: Map<string, Listener>;
  openHandler: OpenHandler | null;
  on: (name: string, fn: Listener) => void;
  setWindowOpenHandler: (fn: OpenHandler) => void;
  getType: () => string;
}

function fakeContents(type: string): FakeContents {
  const c: FakeContents = {
    listeners: new Map(),
    openHandler: null,
    on: (name, fn) => {
      c.listeners.set(name, fn);
    },
    setWindowOpenHandler: (fn) => {
      c.openHandler = fn;
    },
    getType: () => type,
  };
  return c;
}

function fakeEvent() {
  return { preventDefault: vi.fn() };
}

/** Sertleştirmeyi kurar ve verilen türde bir webContents yaratılmış gibi davranır. */
function setup(type = "window") {
  const openLink = vi.fn();
  hardenWebContents(openLink);
  const created = h.appOn.mock.calls.find((c) => c[0] === "web-contents-created")?.[1] as
    | ((e: unknown, c: FakeContents) => void)
    | undefined;
  if (!created) throw new Error("web-contents-created dinleyicisi yok");
  const contents = fakeContents(type);
  created({}, contents);
  const listener = (name: string): Listener => {
    const fn = contents.listeners.get(name);
    if (!fn) throw new Error(`dinleyici yok: ${name}`);
    return fn;
  };
  return { openLink, contents, listener };
}

/** Uygulamanın kendi belgesi: `security.ts` ile aynı klasörden `../renderer/index.html`. */
const OWN = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const OWN_URL = pathToFileURL(OWN).href;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("izin istekleri", () => {
  it("yalnız pano yazma ve tam ekran verilir; kamera, mikrofon, konum vb. reddedilir", () => {
    setup();
    const request = h.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      wc: unknown,
      permission: string,
      cb: (ok: boolean) => void,
    ) => void;
    const check = h.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      wc: unknown,
      permission: string,
    ) => boolean;
    const decide = (p: string) => {
      let out: boolean | undefined;
      request(null, p, (ok) => {
        out = ok;
      });
      return out;
    };
    for (const p of ["clipboard-sanitized-write", "fullscreen"]) {
      expect(decide(p)).toBe(true);
      expect(check(null, p)).toBe(true);
    }
    for (const p of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "openExternal",
      "pointerLock",
      "hid",
      "serial",
      "usb",
      "display-capture",
      "",
    ]) {
      expect(decide(p)).toBe(false);
      expect(check(null, p)).toBe(false);
    }
  });
});

describe("yeni pencere açma", () => {
  it("http(s) bağlantısı açıcıya verilir, pencere her durumda reddedilir", () => {
    const { openLink, contents } = setup();
    const open = contents.openHandler;
    if (!open) throw new Error("açma işleyicisi yok");
    expect(open({ url: "https://ornek.com/a" })).toEqual({ action: "deny" });
    expect(open({ url: "HTTP://ornek.com" })).toEqual({ action: "deny" });
    expect(openLink.mock.calls.map((c) => c[0])).toEqual([
      "https://ornek.com/a",
      "HTTP://ornek.com",
    ]);
  });

  it("file:, javascript:, data: ve özel şemalar açıcıya bile gitmez", () => {
    const { openLink, contents } = setup();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "codezal-file://x",
      "smb://sunucu/paylasim",
      " https://ornek.com",
    ])
      expect(contents.openHandler?.({ url })).toEqual({ action: "deny" });
    expect(openLink).not.toHaveBeenCalled();
  });

  it("webview içeriği için de açma işleyicisi kurulur", () => {
    const { contents } = setup("webview");
    expect(contents.openHandler).not.toBeNull();
  });
});

describe("webview ekleme", () => {
  it("webPreferences sertleştirilir: preload silinir, Node kapalı, yalıtım ve sandbox açık", () => {
    const { listener } = setup();
    const prefs: Record<string, unknown> = {
      preload: "/kotu/preload.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
    };
    const e = fakeEvent();
    listener("will-attach-webview")(e, prefs, { src: "https://ornek.com" });
    expect(prefs).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
    expect("preload" in prefs).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["https://ornek.com", "http://localhost:3000", "about:blank", ""])(
    "izinli kaynak kabul edilir: %s",
    (src) => {
      const { listener } = setup();
      const e = fakeEvent();
      listener("will-attach-webview")(e, {}, { src });
      expect(e.preventDefault).not.toHaveBeenCalled();
    },
  );

  it.each([
    "file:///Users/ben/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,x",
    "codezal-file://x",
    "chrome://settings",
  ])("izinsiz kaynak engellenir ve günlüğe yazılır: %s", (src) => {
    const { listener } = setup();
    const e = fakeEvent();
    listener("will-attach-webview")(e, {}, { src });
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith("security", `webview engellendi: ${src}`);
  });
});

describe("ana pencere yönlendirmesi (paket)", () => {
  it("yalnız pencere türünde kurulur; webview kendi içinde gezinebilir", () => {
    expect(setup("webview").contents.listeners.has("will-navigate")).toBe(false);
    expect(setup("window").contents.listeners.has("will-navigate")).toBe(true);
  });

  it("uygulamanın kendi belgesi, parça ve sorgu ekleriyle birlikte kabul edilir", () => {
    const { listener } = setup();
    for (const url of [OWN_URL, `${OWN_URL}#/ayarlar`, `${OWN_URL}?x=1`]) {
      const e = fakeEvent();
      listener("will-navigate")(e, url);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("başka bir yerel HTML, uzak adres ve bozuk adres engellenir", () => {
    const { listener } = setup();
    const other = pathToFileURL(fileURLToPath(new URL("../renderer/kotu.html", import.meta.url)));
    for (const url of [
      other.href,
      "file:///tmp/indirilen.html",
      "https://ornek.com",
      "http://localhost:5173",
      "bozuk adres",
    ]) {
      const e = fakeEvent();
      listener("will-navigate")(e, url);
      expect(e.preventDefault).toHaveBeenCalledOnce();
      expect(h.warn).toHaveBeenCalledWith("security", `yönlendirme engellendi: ${url}`);
    }
  });
});

describe("ana pencere yönlendirmesi (geliştirme)", () => {
  it("yalnız geliştirme sunucusuyla birebir aynı köken kabul edilir", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    const { listener } = setup();
    const decide = (url: string) => {
      const e = fakeEvent();
      listener("will-navigate")(e, url);
      return e.preventDefault.mock.calls.length === 0;
    };
    expect(decide("http://localhost:5173/")).toBe(true);
    expect(decide("http://localhost:5173/#/sohbet?id=1")).toBe(true);
    // Önek taşıyan ama farklı köken olan adresler.
    expect(decide("http://localhost:5173.evil.com/")).toBe(false);
    expect(decide("http://localhost:51730/")).toBe(false);
    expect(decide("https://localhost:5173/")).toBe(false);
    expect(decide("http://127.0.0.1:5173/")).toBe(false);
    // Geliştirmede paket belgesi de kabul edilmez.
    expect(decide(OWN_URL)).toBe(false);
    expect(decide("bozuk")).toBe(false);
  });
});

describe("içerik güvenlik politikası (CSP)", () => {
  /**
   * CSP `security.ts`'de başlık olarak değil, renderer `index.html` içinde meta etiketiyle verilir;
   * burada yalnız okunup temel yönergeleri doğrulanır.
   */
  function csp(): Map<string, string[]> {
    const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    if (!content) throw new Error("CSP meta etiketi yok");
    return new Map(
      content
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((p) => p[0])
        .map(([name = "", ...values]) => [name, values]),
    );
  }

  it("varsayılan ve betik kaynağı yalnız 'self'; satır içi/eval betik yok", () => {
    const p = csp();
    expect(p.get("default-src")).toEqual(["'self'"]);
    expect(p.get("script-src")).toEqual(["'self'"]);
    for (const values of p.values()) {
      expect(values).not.toContain("'unsafe-eval'");
      expect(values).not.toContain("*");
    }
    expect(p.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("çerçeve yalnız yerel dosya protokolünden; uzak kaynak izni yok", () => {
    const p = csp();
    expect(p.get("frame-src")).toEqual(["codezal-file:"]);
    for (const values of p.values()) for (const v of values) expect(v).not.toMatch(/^https?:/);
  });
});
