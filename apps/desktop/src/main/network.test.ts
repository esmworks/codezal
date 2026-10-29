import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isOnline = vi.hoisted(() => vi.fn(() => true));
const resumeHandlers = vi.hoisted(() => [] as Array<() => void>);

vi.mock("electron", () => ({
  net: { isOnline: () => isOnline() },
  powerMonitor: {
    on: (event: string, handler: () => void) => {
      if (event === "resume") resumeHandlers.push(handler);
    },
    removeListener: (event: string, handler: () => void) => {
      if (event !== "resume") return;
      const index = resumeHandlers.indexOf(handler);
      if (index >= 0) resumeHandlers.splice(index, 1);
    },
  },
}));

const { isOnlineTransition, startNetworkWatch } = await import("./network");

beforeEach(() => {
  vi.useFakeTimers();
  isOnline.mockReset();
  isOnline.mockReturnValue(true);
  resumeHandlers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isOnlineTransition", () => {
  it("yalnız çevrimdışı → çevrimiçi geçişini bildirir", () => {
    expect(isOnlineTransition(false, true)).toBe(true);
    expect(isOnlineTransition(true, true)).toBe(false);
    expect(isOnlineTransition(true, false)).toBe(false);
    expect(isOnlineTransition(undefined, true)).toBe(false);
  });
});

describe("startNetworkWatch", () => {
  it("başlangıçta tetiklemez; geçişte ve resume'da tetikler; durdurunca susar", () => {
    const reconnect = vi.fn();
    const stop = startNetworkWatch(reconnect, 1_000);
    expect(reconnect).not.toHaveBeenCalled();

    isOnline.mockReturnValue(false);
    vi.advanceTimersByTime(1_000); // çevrimiçi → çevrimdışı: tetik yok
    expect(reconnect).not.toHaveBeenCalled();

    isOnline.mockReturnValue(true);
    vi.advanceTimersByTime(1_000); // çevrimdışı → çevrimiçi: tetik
    expect(reconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000); // çevrimiçi → çevrimiçi: tetik yok
    expect(reconnect).toHaveBeenCalledTimes(1);

    for (const handler of [...resumeHandlers]) handler();
    expect(reconnect).toHaveBeenCalledTimes(2);

    stop();
    for (const handler of [...resumeHandlers]) handler();
    expect(reconnect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });
});
