import type { Api, AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatNativeResults, webSearchTool } from "./web-search.js";
import {
  injectNativeSearch,
  type NativeSearchCompleter,
  nativeSearchSpec,
  runNativeWebSearch,
  sourcesFromText,
} from "./web-search-native.js";

function model(api: Api): Model<Api> {
  return {
    id: "test-model",
    name: "Test",
    api,
    provider: "test",
    baseUrl: "https://ornek.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 1_000,
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function fakeCompleter(reply: string) {
  const captured: { context: Context | undefined; options: StreamOptions | undefined } = {
    context: undefined,
    options: undefined,
  };
  const completer: NativeSearchCompleter = {
    complete: async (_model, context, options) => {
      captured.context = context;
      captured.options = options;
      return assistantMessage(reply);
    },
  };
  return { completer, captured };
}

const SUMMARY = "Kısa özet [Kaynak](https://a.dev/1) ve [İkinci](https://b.dev/2).";

describe("yerleşik web arama tanımı", () => {
  it("sağlayıcı API'sine göre yerleşik arama aracını verir", () => {
    expect(nativeSearchSpec(model("anthropic-messages"))?.tool).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 8,
    });
    expect(nativeSearchSpec(model("openai-responses"))?.tool).toEqual({ type: "web_search" });
    expect(nativeSearchSpec(model("azure-openai-responses"))?.tool).toEqual({
      type: "web_search",
    });
    expect(nativeSearchSpec(model("google-generative-ai"))?.tool).toEqual({ google_search: {} });
    expect(nativeSearchSpec(model("google-vertex"))?.tool).toEqual({ google_search: {} });
  });

  it("arama sayısını sağlayıcı aracına taşır", () => {
    expect(nativeSearchSpec(model("anthropic-messages"), 3)?.tool).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    });
  });

  it("yerleşik araması olmayan API'de tanım vermez", () => {
    for (const api of ["openai-completions", "bedrock-converse-stream", "mistral-conversations"]) {
      expect(nativeSearchSpec(model(api))).toBeUndefined();
    }
  });
});

describe("isteğe yerleşik arama ekleme", () => {
  const spec = { tool: { type: "web_search" } };

  it("var olan istemci araçlarını korur", () => {
    expect(injectNativeSearch({ tools: [{ name: "read" }] }, spec)).toEqual({
      tools: [{ name: "read" }, { type: "web_search" }],
    });
  });

  it("araç listesi yokken yerleşik aramayla kurar", () => {
    expect(injectNativeSearch({ model: "x" }, spec)).toEqual({
      model: "x",
      tools: [{ type: "web_search" }],
    });
  });

  it("gövde nesne değilse dokunmaz", () => {
    expect(injectNativeSearch(null, spec)).toBeNull();
  });
});

describe("özet metninden kaynak çıkarma", () => {
  it("markdown bağlantılarını kaynak sayar, görseli ve tekrarı atlar", () => {
    const text = [
      "Özet [Bir](https://a.dev/1) ve [İki](https://b.dev/2).",
      "![görsel](https://c.dev/g.png)",
      "Aynı adres: [Bir daha](https://A.dev/1).",
    ].join("\n");
    expect(sourcesFromText(text)).toEqual([
      { url: "https://a.dev/1", title: "Bir" },
      { url: "https://b.dev/2", title: "İki" },
    ]);
  });

  it("başlıksız bağlantıyı adresle kaynak sayar", () => {
    expect(sourcesFromText("<https://a.dev/1> ve [](https://b.dev/2)")).toEqual([
      { url: "https://b.dev/2" },
    ]);
  });
});

describe("yerleşik arama isteği", () => {
  it("arama aracını gövdeye ekler, özeti kaynaklarla döndürür", async () => {
    const { completer, captured } = fakeCompleter(SUMMARY);
    const result = await runNativeWebSearch({
      completer,
      model: model("anthropic-messages"),
      query: "codezal web arama",
      lang: "tr",
    });

    expect(result).toEqual({
      summary: SUMMARY,
      sources: [
        { url: "https://a.dev/1", title: "Kaynak" },
        { url: "https://b.dev/2", title: "İkinci" },
      ],
    });
    const first = captured.context?.messages[0];
    expect(typeof first?.content === "string" ? first.content : "").toContain("codezal web arama");
    const payload = await captured.options?.onPayload?.(
      { model: "claude" },
      model("anthropic-messages"),
    );
    expect(payload).toEqual({
      model: "claude",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    });
  });

  it("kaynaksız özeti arama sonucu saymaz", async () => {
    const { completer } = fakeCompleter("Arama yapılmadan yazılmış düz yanıt.");
    const result = await runNativeWebSearch({
      completer,
      model: model("anthropic-messages"),
      query: "codezal",
      lang: "tr",
    });
    expect(result).toBeNull();
  });

  it("yerleşik aramayı desteklemeyen modelde istek atmaz", async () => {
    let calls = 0;
    const completer: NativeSearchCompleter = {
      complete: async () => {
        calls += 1;
        return assistantMessage(SUMMARY);
      },
    };
    const result = await runNativeWebSearch({
      completer,
      model: model("openai-completions"),
      query: "codezal",
      lang: "tr",
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("yerleşik sonuç biçimi", () => {
  it("özeti ve kaynak listesini modele verir", () => {
    const text = formatNativeResults(
      {
        summary: "Bulunanlar özeti.",
        sources: [{ url: "https://a.dev/1", title: "Bir" }, { url: "https://b.dev/2" }],
      },
      "codezal",
      "tr",
    );
    expect(text).toContain('"codezal" için web arama sonuçları');
    expect(text).toContain("Özet:\nBulunanlar özeti.");
    expect(text).toContain(
      "Kaynaklar:\n- [Bir](https://a.dev/1)\n- [https://b.dev/2](https://b.dev/2)",
    );
    expect(text.endsWith("markdown bağlantısı olarak kullan.")).toBe(true);
  });
});

describe("web_search · gözetimsiz görevde özet", () => {
  /** İlk çağrı yerleşik arama, ikincisi özet; her çağrının bağlamı ve seçenekleri kaydedilir. */
  function twoStep(extract: string) {
    const calls: { context: Context; options: StreamOptions | undefined }[] = [];
    const completer: NativeSearchCompleter = {
      complete: async (_model, context, options) => {
        calls.push({ context, options });
        return assistantMessage(calls.length === 1 ? SUMMARY : extract);
      },
    };
    return { calls, ctx: { model: model("anthropic-messages"), modelRegistry: completer } };
  }
  const run = (quarantine: boolean, ctx: unknown) =>
    webSearchTool("tr", { quarantine: () => quarantine }).execute(
      "c1",
      { query: "sabah haberleri" },
      undefined,
      undefined,
      ctx as never,
    );
  const textOf = (r: Awaited<ReturnType<typeof run>>) =>
    r.content[0]?.type === "text" ? r.content[0].text : "";

  it("sonuçlar araçsız ikinci çağrıyla özetlenir; ana ajan ham özeti görmez", async () => {
    const { calls, ctx } = twoStep("- Borsa rekor kırdı ([Kaynak](https://a.dev/1))");
    const out = await run(true, ctx);
    expect(calls).toHaveLength(2);
    // Özet çağrısında ne istemci aracı ne de yerleşik arama gövdesi var.
    expect(calls[1]?.context.tools).toBeUndefined();
    expect(calls[1]?.options?.onPayload).toBeUndefined();
    const user = calls[1]?.context.messages[0];
    expect(typeof user?.content === "string" ? user.content : "").toContain(
      '"sabah haberleri" sorgusuyla ilgili',
    );
    const text = textOf(out);
    expect(text).toContain("arama sonuçları araçsız ayrı bir modelle özetlendi");
    expect(text).toContain("- Borsa rekor kırdı ([Kaynak](https://a.dev/1))");
    expect(text).not.toContain(SUMMARY);
    expect(out.details).toMatchObject({ endpoint: "native", quarantined: true });
  });

  it("özet alınamazsa ham sonuca düşmez, hata verir", async () => {
    const { ctx } = twoStep("");
    await expect(run(true, ctx)).rejects.toThrow(/ayrı bir modelle/);
  });

  it("başında kullanıcı olan oturumda tek çağrı yapılır, sonuç blokta verilir", async () => {
    const { calls, ctx } = twoStep("kullanılmaz");
    const text = textOf(await run(false, ctx));
    expect(calls).toHaveLength(1);
    expect(text).toContain("UNTRUSTED_WEB_CONTENT");
    expect(text).toContain("https://a.dev/1");
  });
});
