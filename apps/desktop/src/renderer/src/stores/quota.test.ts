import type { ProviderQuota } from "@codezal/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ invoke: vi.fn(), on: () => () => {} }));

import { invoke } from "../api";
import { useQuota } from "./quota";

function quota(provider: string, fetchedAt = 1): ProviderQuota {
  return { provider, state: "ok", windows: [], fetchedAt };
}

describe("kota store'u", () => {
  it("tek sağlayıcı tazelenince diğerlerinin kaydı korunur", async () => {
    useQuota.setState({ items: [quota("commandcode"), quota("deepseek")] });
    vi.mocked(invoke).mockResolvedValueOnce([quota("deepseek", 2)]);
    await useQuota.getState().refresh("deepseek");
    const items = useQuota.getState().items;
    expect(items.map((q) => q.provider).sort()).toEqual(["commandcode", "deepseek"]);
    expect(items.find((q) => q.provider === "deepseek")?.fetchedAt).toBe(2);
  });

  it("sağlayıcı verilmeden tazelenince liste yanıtla değişir", async () => {
    useQuota.setState({ items: [quota("commandcode"), quota("deepseek")] });
    vi.mocked(invoke).mockResolvedValueOnce([quota("xai")]);
    await useQuota.getState().refresh();
    expect(useQuota.getState().items.map((q) => q.provider)).toEqual(["xai"]);
  });
});
