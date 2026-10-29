import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { catalogSignature, listCatalog } from "./catalog.js";

function model(id: string, cost: { input: number; output: number }): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

// Katalog için yalnızca iki metot kullanılır; gerisi testte gerekmez.
function runtime(models: Model<"anthropic-messages">[]): ModelRuntime {
  const partial: Pick<ModelRuntime, "getModels" | "getAvailableSnapshot"> = {
    getModels: () => models,
    getAvailableSnapshot: () => [models[0]].filter((m) => m !== undefined),
  };
  return partial as ModelRuntime;
}

describe("listCatalog", () => {
  it("negatif veya eksik fiyatı sıfıra kırpar, kullanılabilirliği işaretler", () => {
    const list = listCatalog(
      runtime([model("a", { input: 3, output: 15 }), model("b", { input: -1, output: -1 })]),
    );
    expect(list.map((m) => m.cost)).toEqual([
      { input: 3, output: 15 },
      { input: 0, output: 0 },
    ]);
    expect(list.map((m) => m.available)).toEqual([true, false]);
    expect(list[0]?.vision).toBe(true);
  });
});

describe("catalogSignature", () => {
  it("sıra değişince aynı, model ya da bağlam değişince farklı", () => {
    const a = model("a", { input: 3, output: 15 });
    const b = model("b", { input: 1, output: 2 });
    expect(catalogSignature(listCatalog(runtime([a, b])))).toBe(
      catalogSignature(listCatalog(runtime([b, a]))),
    );
    expect(catalogSignature(listCatalog(runtime([a])))).not.toBe(
      catalogSignature(listCatalog(runtime([a, b]))),
    );
    const wider = { ...a, contextWindow: 2000 };
    expect(catalogSignature(listCatalog(runtime([wider])))).not.toBe(
      catalogSignature(listCatalog(runtime([a]))),
    );
  });
});
