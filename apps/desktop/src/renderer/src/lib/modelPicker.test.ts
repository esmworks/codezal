import type { CatalogModel, ProviderInfo } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  flatModels,
  initialSelection,
  matchesModel,
  modelGroups,
  providerEntries,
  summaryCallCost,
  summaryModelsByCost,
} from "./modelPicker";

const model = (provider: string, id: string, available = true): CatalogModel => ({
  provider,
  id,
  name: id,
  reasoning: false,
  vision: false,
  contextWindow: 128_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0 },
  available,
});
const provider = (id: string, name: string, connected: boolean): ProviderInfo => ({
  id,
  name,
  connected,
  authKinds: ["api_key"],
  modelCount: 2,
  keys: [],
});

const providers = [
  provider("opencode-go", "OpenCode Go", true),
  provider("anthropic", "Anthropic", false),
];
const catalog = [
  model("opencode-go", "qwen3.8-flash"),
  model("opencode-go", "kimi-k3"),
  model("opencode-go", "gizli", false),
  model("anthropic", "claude-opus-5"),
];

describe("modelGroups", () => {
  it("yalnızca bağlı sağlayıcıların kullanılabilir modellerini gruplar", () => {
    const g = modelGroups(catalog, providers, [], "");
    expect(g.map((x) => x.title)).toEqual(["OpenCode Go"]);
    expect(g[0]?.models.map((m) => m.id)).toEqual(["qwen3.8-flash", "kimi-k3"]);
  });

  it("son kullanılanları öne alır ve sorguya göre süzer", () => {
    const g = modelGroups(catalog, providers, [{ provider: "opencode-go", id: "kimi-k3" }], "");
    expect(g.map((x) => x.title)).toEqual([undefined, "OpenCode Go"]);
    expect(flatModels(g).map((m) => m.id)).toEqual(["kimi-k3", "qwen3.8-flash", "kimi-k3"]);
    expect(modelGroups(catalog, providers, [], "qwen 3.8").map((x) => x.models.length)).toEqual([
      1,
    ]);
    expect(modelGroups(catalog, providers, [], "yok")).toEqual([]);
  });

  it("arama tire ve büyük harf duyarsız, sağlayıcı adıyla da eşleşir", () => {
    expect(matchesModel(model("x", "deepseek-v4-pro"), "DeepSeek", "V4PRO")).toBe(true);
    expect(matchesModel(model("x", "glm-5.3"), "OpenCode Go", "opencode")).toBe(true);
  });
});

describe("providerEntries", () => {
  it("bağlı sağlayıcıyı modeli olmasa da listeler, bağlı olmayanı listelemez", () => {
    const extra = [provider("bos", "Boş Sağlayıcı", true)];
    const e = providerEntries(catalog, [...providers, ...extra], []);
    expect(e.map((x) => x.key)).toEqual(["opencode-go", "bos"]);
    expect(e[1]?.models).toEqual([]);
  });

  it("son kullanılanları en başa alır", () => {
    const e = providerEntries(catalog, providers, [{ provider: "opencode-go", id: "kimi-k3" }]);
    expect(e.map((x) => x.key)).toEqual(["recent", "opencode-go"]);
    expect(e[0]?.models.map((m) => m.id)).toEqual(["kimi-k3"]);
  });
});

describe("initialSelection", () => {
  const entries = providerEntries(catalog, providers, [{ provider: "opencode-go", id: "kimi-k3" }]);

  it("geçerli modelin sağlayıcısında ve satırında konumlanır", () => {
    expect(initialSelection(entries, { provider: "opencode-go", id: "kimi-k3" })).toEqual({
      group: 1,
      model: 1,
    });
  });

  it("model yoksa ya da sağlayıcı listede değilse ilk satıra düşer", () => {
    expect(initialSelection(entries, null)).toEqual({ group: 0, model: 0 });
    expect(initialSelection(entries, { provider: "yok", id: "x" })).toEqual({ group: 0, model: 0 });
    // Katalogdan kalkmış model: sağlayıcı grubunda kalır, satır başa döner.
    expect(initialSelection(entries, { provider: "opencode-go", id: "silinmis" })).toEqual({
      group: 1,
      model: 0,
    });
  });
});

describe("summaryModelsByCost", () => {
  const priced = (id: string, input: number, output: number, available = true) => ({
    ...model("p", id, available),
    cost: { input, output },
  });

  it("girdi ve çıktı fiyatını tipik özet boyutuyla tartar", () => {
    // Girdisi ucuz ama çıktısı pahalı model, dengeli olandan pahalıya gelir.
    const cikti = priced("ucuz-girdi", 1, 20);
    const denge = priced("dengeli", 2, 4);
    expect(summaryCallCost(cikti)).toBeCloseTo(0.022);
    expect(summaryCallCost(denge)).toBeCloseTo(0.0188);
    expect(summaryCallCost(priced("fiyatsiz", 0, 0))).toBeUndefined();
  });

  it("ucuzdan pahalıya sıralar, fiyatsızı sona, anahtarsızı dışarı alır", () => {
    const list = summaryModelsByCost([
      priced("ucuz-girdi", 1, 20),
      priced("fiyatsiz-1", 0, 0),
      priced("dengeli", 2, 4),
      priced("anahtarsiz", 0.01, 0.01, false),
      priced("fiyatsiz-2", 0, 0),
      priced("en-ucuz", 0.1, 0.4),
    ]);
    expect(list.map((m) => m.id)).toEqual([
      "en-ucuz",
      "dengeli",
      "ucuz-girdi",
      "fiyatsiz-1",
      "fiyatsiz-2",
    ]);
  });
});
