import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ au: undefined as unknown }));

vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => "1.0.0" } }));
vi.mock("./ipc.js", () => ({ broadcast: vi.fn() }));
vi.mock("./log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// electron-updater CJS'dir; updater.ts `default.autoUpdater` üzerinden okur.
vi.mock("electron-updater", () => {
  const mod = {
    get autoUpdater() {
      return h.au;
    },
  };
  return { default: mod };
});

/** electron-updater taklidi: denetim `checking-for-update` yayar, sonucu test belirler. */
class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  logger: unknown = undefined;
  checkForUpdates = vi.fn(async () => {
    this.emit("checking-for-update");
    this.emit("update-not-available", { version: "1.0.0" });
  });
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

const MINUTES_15 = 15 * 60 * 1000;
let au: FakeUpdater;

async function boot() {
  vi.resetModules();
  au = new FakeUpdater();
  h.au = au;
  const mod = await import("./updater");
  mod.startUpdater(true);
  // Dinleyiciler tembel yüklemeden sonra bağlanır; ilk denetim hemen koşar.
  await vi.waitFor(() => expect(au.checkForUpdates).toHaveBeenCalledTimes(1));
  return mod;
}

/** Yeni sürüm bulunur, indirilir ve kuruluma hazır olur. */
function downloadNewVersion() {
  au.emit("update-available", { version: "1.1.0", releaseNotes: "Yenilikler" });
  au.emit("download-progress", { percent: 40, transferred: 4, total: 10 });
  au.emit("update-downloaded", { version: "1.1.0", releaseNotes: "Yenilikler" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("updater durum makinesi", () => {
  it("güncelleme hazırken periyodik denetim atlanır, 'Yeniden başlat' çalışmaya devam eder", async () => {
    const mod = await boot();
    downloadNewVersion();
    expect(mod.updateStatus().state).toBe("ready");

    await vi.advanceTimersByTimeAsync(MINUTES_15 + 1);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mod.updateStatus().state).toBe("ready");
    expect(mod.updateStatus().version).toBe("1.1.0");

    mod.installUpdate();
    await vi.waitFor(() => expect(au.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it("hazır ya da indirilirken gelen denetim olayları durumu geriletmez", async () => {
    const mod = await boot();
    au.emit("update-available", { version: "1.1.0" });
    au.emit("download-progress", { percent: 10, transferred: 1, total: 10 });
    expect(mod.updateStatus().state).toBe("downloading");
    au.emit("checking-for-update");
    au.emit("update-available", { version: "1.1.0" });
    au.emit("update-not-available", { version: "1.0.0" });
    expect(mod.updateStatus().state).toBe("downloading");
    expect(mod.updateStatus().percent).toBe(10);

    au.emit("update-downloaded", { version: "1.1.0" });
    au.emit("checking-for-update");
    au.emit("update-available", { version: "1.1.0" });
    expect(mod.updateStatus().state).toBe("ready");
  });

  it("indirme sürerken elle denetim de atlanır", async () => {
    const mod = await boot();
    au.emit("update-available", { version: "1.1.0" });
    au.emit("download-progress", { percent: 50, transferred: 5, total: 10 });
    const status = await mod.checkForUpdates();
    expect(status.state).toBe("downloading");
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("indirme sürerken periyodik denetim atlanır", async () => {
    const mod = await boot();
    au.emit("update-available", { version: "1.1.0" });
    au.emit("download-progress", { percent: 50, transferred: 5, total: 10 });
    await vi.advanceTimersByTimeAsync(MINUTES_15 + 1);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mod.updateStatus().state).toBe("downloading");
  });

  it("indirme hatası sürüm bilgisini korur", async () => {
    const mod = await boot();
    au.emit("update-available", { version: "1.1.0" });
    au.emit("download-progress", { percent: 50, transferred: 5, total: 10 });
    au.emit("error", new Error("bağlantı koptu"));
    expect(mod.updateStatus().state).toBe("error");
    expect(mod.updateStatus().version).toBe("1.1.0");
  });

  it("otomatik indirme ilk ilerlemeden önce düşerse de indirme hatası sayılır", async () => {
    const mod = await boot();
    au.emit("update-available", { version: "1.1.0" });
    au.emit("error", new Error("imza doğrulanamadı"));
    expect(mod.updateStatus().state).toBe("error");
    expect(mod.updateStatus().version).toBe("1.1.0");
  });

  it("denetim hatası mevcut sürüme döner", async () => {
    const mod = await boot();
    au.emit("checking-for-update");
    au.emit("error", new Error("DNS yok"));
    expect(mod.updateStatus().state).toBe("error");
    expect(mod.updateStatus().version).toBe("1.0.0");
  });
});
