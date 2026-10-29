import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_CODE_MODELS, fetchCommandCodeModels, registerCommandCode } from "./commandcode.js";

describe("commandcode sağlayıcısı", () => {
  it("model kimlikleri tekil ve temel alanlar geçerli", () => {
    const ids = COMMAND_CODE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Liste /provider/v1/models çıktısının anlık görüntüsü; sayı düşerse katalog küçülmüş demektir.
    expect(COMMAND_CODE_MODELS.length).toBeGreaterThanOrEqual(60);
    for (const m of COMMAND_CODE_MODELS) {
      expect(m.name.trim(), m.id).not.toBe("");
      expect(m.contextWindow, m.id).toBeGreaterThan(0);
      expect(m.maxTokens, m.id).toBeGreaterThan(0);
      expect(m.input.length, m.id).toBeGreaterThan(0);
      expect(m.cost.input, m.id).toBeGreaterThanOrEqual(0);
      expect(m.cost.output, m.id).toBeGreaterThanOrEqual(0);
      expect(m.cost.cacheRead, m.id).toBeGreaterThanOrEqual(0);
      expect(m.cost.cacheWrite, m.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("Claude modelleri Anthropic ucuna, diğerleri OpenAI ucuna gider", () => {
    for (const m of COMMAND_CODE_MODELS) {
      if (m.id.startsWith("claude")) {
        expect(m.api, m.id).toBe("anthropic-messages");
        expect(m.baseUrl, m.id).toBe("https://api.commandcode.ai/provider");
      } else {
        // Sağlayıcı varsayılanı OpenAI ucu; model düzeyinde ayrıca api verilmez.
        expect(m.api ?? "openai-completions", m.id).toBe("openai-completions");
        expect(m.baseUrl, m.id).toBeUndefined();
        // Command Code istemcisi gövdede max_tokens kullanır; Pi varsayılanı değil.
        const compat = m.compat ?? {};
        expect("maxTokensField" in compat && compat.maxTokensField, m.id).toBe("max_tokens");
      }
    }
    // İki uç ailesi de katalogda temsil edilmeli.
    expect(COMMAND_CODE_MODELS.some((m) => m.id.startsWith("claude"))).toBe(true);
    expect(COMMAND_CODE_MODELS.some((m) => !m.id.startsWith("claude"))).toBe(true);
  });

  it("kayıt tek çağrıda ve sağlayıcı kimliğiyle yapılır", () => {
    const calls: Array<Parameters<ModelRuntime["registerProvider"]>> = [];
    const rt = {
      registerProvider: (...args: Parameters<ModelRuntime["registerProvider"]>) => {
        calls.push(args);
      },
    };
    registerCommandCode(rt);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("commandcode");
    expect(calls[0]?.[1]).toMatchObject({
      name: "Command Code",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      api: "openai-completions",
      models: COMMAND_CODE_MODELS,
    });
  });

  it("kayda verilen canlı liste gömülünün yerine geçer", () => {
    const calls: Array<Parameters<ModelRuntime["registerProvider"]>> = [];
    const live = COMMAND_CODE_MODELS.slice(0, 2);
    registerCommandCode({ registerProvider: (...args) => void calls.push(args) }, live);
    expect(calls[0]?.[1].models).toBe(live);
  });
});

describe("commandcode canlı model listesi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubModels(body: unknown, ok = true): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, json: async () => body })),
    );
  }

  it("bilinen modelde fiyatı korur, yeni modeli uca göre yönlendirip ekler", async () => {
    stubModels({
      data: [
        { id: "gpt-6-sol", name: "GPT-6 Sol", context_length: 2000000 },
        {
          id: "claude-yeni",
          name: "Claude Yeni",
          context_length: 500000,
          supported_endpoints: ["/messages"],
        },
        {
          id: "vendor/yeni",
          context_length: 0,
          supported_endpoints: ["/chat/completions", "/responses"],
        },
        { id: "gpt-6-sol" },
        { name: "kimliksiz" },
      ],
    });
    const models = await fetchCommandCodeModels();
    expect(models?.map((m) => m.id)).toEqual(["gpt-6-sol", "claude-yeni", "vendor/yeni"]);
    const known = COMMAND_CODE_MODELS.find((m) => m.id === "gpt-6-sol");
    expect(models?.[0]).toMatchObject({ cost: known?.cost, input: known?.input });
    expect(models?.[0]?.contextWindow).toBe(2000000);
    expect(models?.[1]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.commandcode.ai/provider",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models?.[2]).toMatchObject({
      name: "vendor/yeni",
      contextWindow: 128000,
      compat: { maxTokensField: "max_tokens" },
    });
    expect(models?.[2]?.api).toBeUndefined();
  });

  it("hata, boş ya da bozuk yanıtta gömülü listede kalınır", async () => {
    stubModels({ data: [] });
    expect(await fetchCommandCodeModels()).toBeUndefined();
    stubModels({ error: "x" });
    expect(await fetchCommandCodeModels()).toBeUndefined();
    stubModels({ data: [{ id: "gpt-6-sol" }] }, false);
    expect(await fetchCommandCodeModels()).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ağ yok");
      }),
    );
    expect(await fetchCommandCodeModels()).toBeUndefined();
  });
});
