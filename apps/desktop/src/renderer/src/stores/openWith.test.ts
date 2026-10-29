import type { OpenWithApp } from "@codezal/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  patch: vi.fn(async () => undefined),
  error: vi.fn(),
}));

vi.mock("../api", () => ({ invoke: mocks.invoke, on: () => () => {} }));
vi.mock("./toast", () => ({
  toast: { error: mocks.error, info: vi.fn() },
  humanizeError: (error: unknown) => `hata: ${String(error)}`,
}));
vi.mock("./settings", () => ({
  useSettings: { getState: () => ({ patch: mocks.patch }) },
}));

import { useOpenWith } from "./openWith";

const apps: OpenWithApp[] = [
  { id: "finder", name: "Finder", kind: "finder", iconDataUrl: null },
  { id: "cursor", name: "Cursor", kind: "editor", iconDataUrl: null },
];

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.patch.mockClear();
  mocks.error.mockClear();
  useOpenWith.setState({ apps: [] });
});

describe("useOpenWith", () => {
  it("kurulu uygulama listesini main'den alır ve taze listeyi döner", async () => {
    mocks.invoke.mockResolvedValueOnce(apps);
    const fresh = await useOpenWith.getState().load();
    expect(fresh).toEqual(apps);
    expect(useOpenWith.getState().apps).toEqual(apps);
    expect(mocks.invoke).toHaveBeenCalledWith("openWith:list", undefined);
  });

  it("açarken tercihi yazar ve klasörü uygulamaya gönderir", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await useOpenWith.getState().open("cursor", "/tmp/proje");
    expect(mocks.patch).toHaveBeenCalledWith({ openWithApp: "cursor" });
    expect(mocks.invoke).toHaveBeenCalledWith("openWith:open", {
      appId: "cursor",
      path: "/tmp/proje",
    });
  });

  it("açma başarısızsa tercih yine yazılır, hata bildirilir", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("kurulu değil"));
    await useOpenWith.getState().open("cursor", "/tmp/proje");
    expect(mocks.patch).toHaveBeenCalledWith({ openWithApp: "cursor" });
    expect(mocks.error).toHaveBeenCalledWith("hata: Error: kurulu değil");
  });

  it("listeleme hatasında eldeki liste korunur ve hata bildirilir", async () => {
    useOpenWith.setState({ apps });
    mocks.invoke.mockRejectedValueOnce(new Error("yok"));
    const kept = await useOpenWith.getState().load();
    expect(kept).toEqual(apps);
    expect(useOpenWith.getState().apps).toEqual(apps);
    expect(mocks.error).toHaveBeenCalledWith("hata: Error: yok");
  });
});
