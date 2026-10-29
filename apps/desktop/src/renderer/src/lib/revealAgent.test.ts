import { beforeEach, describe, expect, it, vi } from "vitest";

// `stores/app.ts` modül yüklenirken tema uygular ve `window.matchMedia` çağırır; koşu deposu da
// yüklenirken IPC olayına abone olur. Test ortamı node olduğu için kullanılan yüzler taklit edilir.
vi.hoisted(() => {
  const matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.assign(globalThis, {
    window: {
      matchMedia,
      codezal: { on: () => () => {}, invoke: () => Promise.resolve() },
    },
    document: { body: { toggleAttribute: () => {} } },
  });
});

import { useApp } from "../stores/app";
import { revealBackground } from "../stores/background";
import { usePanel } from "../stores/panel";
import { revealAgent, revealJobs } from "./revealAgent";

describe("revealAgent", () => {
  beforeEach(() => {
    useApp.setState({ panelOpen: false });
    usePanel.setState({ tabs: [], active: "Tarayıcı", job: null });
  });

  it("koşuyu İşler sekmesinde ayrıntıyla açar ve kapalı paneli görünür yapar", () => {
    revealAgent("s1", "sub-1");
    expect(usePanel.getState().tabs).toEqual(["İşler"]);
    expect(usePanel.getState().active).toBe("İşler");
    expect(usePanel.getState().job).toEqual({ sessionId: "s1", kind: "agent", id: "sub-1" });
    // Asıl hata buydu: openTab sekmeyi seçiyor ama panel kapalıysa hiçbir şey görünmüyordu.
    expect(useApp.getState().panelOpen).toBe(true);
  });

  it("ikinci iş yeni sekme açmaz, ayrıntıyı değiştirir", () => {
    revealAgent("s1", "sub-2");
    revealBackground("s1", "bg-1");
    expect(usePanel.getState().tabs).toEqual(["İşler"]);
    expect(usePanel.getState().job).toEqual({ sessionId: "s1", kind: "bg", id: "bg-1" });
  });

  it("panel zaten açıkken açık kalır", () => {
    useApp.setState({ panelOpen: true });
    revealAgent("s1", "sub-3");
    expect(useApp.getState().panelOpen).toBe(true);
    expect(usePanel.getState().active).toBe("İşler");
  });

  it("başka oturumun ayrıntısı oturum değişince düşer", () => {
    revealAgent("s1", "sub-1");
    usePanel.getState().clearJobExcept("s1");
    expect(usePanel.getState().job?.id).toBe("sub-1");
    usePanel.getState().clearJobExcept("s2");
    expect(usePanel.getState().job).toBeNull();
  });

  it("İşler listesini açar; sekme kapanınca ayrıntı düşer", () => {
    revealAgent("s1", "sub-1");
    revealJobs();
    expect(usePanel.getState().active).toBe("İşler");
    expect(usePanel.getState().job).toBeNull();
    revealAgent("s1", "sub-1");
    usePanel.getState().closeTab("İşler");
    expect(usePanel.getState().job).toBeNull();
    expect(useApp.getState().panelOpen).toBe(true);
  });
});
