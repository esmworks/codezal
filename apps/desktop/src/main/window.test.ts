import { describe, expect, it, vi } from "vitest";

const shouldUseDarkColors = vi.fn(() => true);
vi.mock("electron", () => ({
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  nativeTheme: {
    get shouldUseDarkColors() {
      return shouldUseDarkColors();
    },
  },
}));

const { isDarkTheme, parseWindowState, windowOptions } = await import("./window");

describe("windowOptions", () => {
  it("macOS'ta trafik ışıkları için gömülü başlık çubuğu kullanır", () => {
    const o = windowOptions("darwin", true);
    expect(o.titleBarStyle).toBe("hiddenInset");
    expect(o.trafficLightPosition).toEqual({ x: 18, y: 10 });
    expect(o.titleBarOverlay).toBeUndefined();
    // macOS menüsü ekranın üstünde, pencerede yer kaplamaz.
    expect(o.autoHideMenuBar).toBeUndefined();
  });

  it("Windows'ta pencere denetimlerini sisteme çizdirir", () => {
    const o = windowOptions("win32", true);
    expect(o.titleBarStyle).toBe("hidden");
    expect(o.titleBarOverlay).toEqual({ color: "#17191c", symbolColor: "#e7eaed", height: 34 });
    // Menü şeridi içeriğin üstünde yer kaplamasın; Alt ile açılır.
    expect(o.autoHideMenuBar).toBe(true);
  });

  it("açık temada denetim şeridi ve ilk boyama rengi açık olur", () => {
    const o = windowOptions("win32", false);
    expect(o.titleBarOverlay).toEqual({ color: "#ffffff", symbolColor: "#1c2126", height: 34 });
    expect(o.backgroundColor).toBe("#ffffff");
  });

  it("Linux'ta da denetimler çizilir", () => {
    expect(windowOptions("linux", true).titleBarStyle).toBe("hidden");
  });
});

describe("parseWindowState", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

  it("geçerli boyut ve konumu geri yükler", () => {
    expect(
      parseWindowState(
        JSON.stringify({ x: 120, y: 80, width: 1280, height: 800, isMaximized: true }),
        displays,
      ),
    ).toEqual({ x: 120, y: 80, width: 1280, height: 800, isMaximized: true });
  });

  it("ekran dışında kalan konumu ve bozuk kayıtları reddeder", () => {
    expect(
      parseWindowState(
        JSON.stringify({ x: 3000, y: 3000, width: 1280, height: 800, isMaximized: false }),
        displays,
      ),
    ).toBeNull();
    expect(parseWindowState("bozuk", displays)).toBeNull();
  });

  it("minimum boyutun altındaki kayıtları reddeder", () => {
    expect(
      parseWindowState(
        JSON.stringify({ x: 20, y: 20, width: 400, height: 300, isMaximized: false }),
        displays,
      ),
    ).toBeNull();
  });
});

describe("isDarkTheme", () => {
  it("açık ve koyu seçimleri doğrudan uygular", () => {
    expect(isDarkTheme("koyu")).toBe(true);
    expect(isDarkTheme("açık")).toBe(false);
  });

  it("sistem seçiliyken işletim sistemine sorar", () => {
    shouldUseDarkColors.mockReturnValueOnce(false);
    expect(isDarkTheme("sistem")).toBe(false);
    shouldUseDarkColors.mockReturnValueOnce(true);
    expect(isDarkTheme("sistem")).toBe(true);
  });
});
