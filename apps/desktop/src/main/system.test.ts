import { beforeEach, describe, expect, it, vi } from "vitest";

const blocker = vi.hoisted(() => ({ start: vi.fn(() => 7), stop: vi.fn() }));

vi.mock("electron", () => ({
  app: { setLoginItemSettings: vi.fn(), dock: undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  powerSaveBlocker: blocker,
  Tray: vi.fn(),
}));
vi.mock("./window.js", () => ({ createMainWindow: vi.fn() }));
vi.mock("./paths.js", () => ({ trayIconPath: () => "" }));

const { sessionGone, setKeepAwake, turnEnded, turnStarted } = await import("./system.js");

describe("uyanık tutma", () => {
  beforeEach(() => {
    setKeepAwake(false);
    blocker.start.mockClear();
    blocker.stop.mockClear();
    setKeepAwake(true);
  });

  it("tur başlayınca uyku engellenir, son tur bitince bırakılır", () => {
    turnStarted("a");
    turnStarted("b");
    expect(blocker.start).toHaveBeenCalledTimes(1);
    turnEnded("a");
    expect(blocker.stop).not.toHaveBeenCalled();
    turnEnded("b");
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it("tur sırasında silinen oturum run_end gelmese de engeli bırakır", () => {
    turnStarted("silinen");
    expect(blocker.start).toHaveBeenCalledTimes(1);
    sessionGone("silinen");
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    // Geç gelen run_end sayacı eksiye düşürmez, başka oturumun turunu da etkilemez.
    turnStarted("diger");
    turnEnded("silinen");
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    turnEnded("diger");
    expect(blocker.stop).toHaveBeenCalledTimes(2);
  });

  it("aynı oturumda iç içe turlar sayılır", () => {
    turnStarted("a");
    turnStarted("a");
    turnEnded("a");
    expect(blocker.stop).not.toHaveBeenCalled();
    turnEnded("a");
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });
});
