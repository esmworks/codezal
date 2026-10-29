import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchTool } from "./web-search.js";
import {
  BRAVE_SEARCH_URL,
  buildBraveRequest,
  buildSearxngRequest,
  normalizeSearxngUrl,
  parseBrave,
  parseSearxng,
  SearchProviderError,
  searchBrave,
  searchSearxng,
} from "./web-search-providers.js";

/** Çağrıları kaydeden sahte `fetch`; her çağrıda verilen yanıtı döner. */
function fakeFetch(respond: (url: string) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(url);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("SearXNG", () => {
  it("adresi normalize eder: sondaki eğik çizgi ve /search atılır", () => {
    expect(normalizeSearxngUrl(" https://searx.ornek.dev/ ")).toBe("https://searx.ornek.dev");
    expect(normalizeSearxngUrl("https://searx.ornek.dev/search?q=x")).toBe(
      "https://searx.ornek.dev",
    );
    expect(normalizeSearxngUrl("http://127.0.0.1:8888/searx/")).toBe("http://127.0.0.1:8888/searx");
  });

  it("boş ya da http(s) dışı adresi anlaşılır hatayla reddeder", () => {
    expect(() => normalizeSearxngUrl("", "tr")).toThrow(/SearXNG adresi girilmemiş/);
    expect(() => normalizeSearxngUrl("file:///etc/passwd", "tr")).toThrow(/geçersiz/);
    expect(() => normalizeSearxngUrl("searx", "tr")).toThrow(SearchProviderError);
  });

  it("isteği q ve format=json ile kurar", () => {
    const req = buildSearxngRequest("https://searx.ornek.dev/", "pi sdk & codezal");
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://searx.ornek.dev/search");
    expect(url.searchParams.get("q")).toBe("pi sdk & codezal");
    expect(url.searchParams.get("format")).toBe("json");
    expect(req.headers.accept).toBe("application/json");
  });

  it("sonuçları ayrıştırır; adressiz ve http dışı satırları atar", () => {
    const results = parseSearxng({
      results: [
        { title: "Birinci", url: "https://a.dev/1", content: "Özet <b>bir</b>" },
        { title: "Adressiz", content: "x" },
        { title: "Betik", url: "javascript:alert(1)" },
        { url: "https://a.dev/2" },
      ],
    });
    expect(results).toEqual([
      { title: "Birinci", url: "https://a.dev/1", snippet: "Özet bir" },
      { title: "https://a.dev/2", url: "https://a.dev/2", snippet: "" },
    ]);
    expect(parseSearxng({})).toEqual([]);
    expect(parseSearxng(null)).toEqual([]);
  });

  it("sonuç sayısını sınırlar", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      title: `S${i}`,
      url: `https://a.dev/${i}`,
    }));
    const { impl, calls } = fakeFetch(() => json({ results: rows }));
    const out = await searchSearxng("https://searx.ornek.dev", "q", { count: 3, fetch: impl });
    expect(out.map((r) => r.title)).toEqual(["S0", "S1", "S2"]);
    expect(calls[0]?.url).toBe("https://searx.ornek.dev/search?q=q&format=json");
  });

  it("JSON kapalı örnekte (403 ya da HTML yanıt) açık Türkçe hata verir", async () => {
    const forbidden = fakeFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(
      searchSearxng("https://searx.ornek.dev", "q", {
        count: 5,
        lang: "tr",
        fetch: forbidden.impl,
      }),
    ).rejects.toThrow(/JSON yanıtı vermiyor/);
    const html = fakeFetch(() => new Response("<!doctype html><html></html>", { status: 200 }));
    await expect(
      searchSearxng("https://searx.ornek.dev", "q", { count: 5, lang: "tr", fetch: html.impl }),
    ).rejects.toThrow(/search\.formats/);
  });

  it("diğer HTTP hatalarında durum kodunu yazar", async () => {
    const { impl } = fakeFetch(() => new Response("", { status: 502 }));
    await expect(
      searchSearxng("https://searx.ornek.dev", "q", { count: 5, lang: "tr", fetch: impl }),
    ).rejects.toThrow("SearXNG isteği başarısız oldu (502).");
  });
});

describe("Brave Search", () => {
  it("isteği uç nokta, count ve X-Subscription-Token başlığıyla kurar", () => {
    const req = buildBraveRequest("BSA-gizli", "codezal", 50);
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(BRAVE_SEARCH_URL);
    expect(url.searchParams.get("q")).toBe("codezal");
    // Brave en çok 20 kabul eder.
    expect(url.searchParams.get("count")).toBe("20");
    expect(req.headers["x-subscription-token"]).toBe("BSA-gizli");
    expect(req.headers.accept).toBe("application/json");
    // Anahtar adrese girmez (günlük ve vekil kayıtlarında görünmesin).
    expect(req.url).not.toContain("BSA-gizli");
  });

  it("web.results'u ayrıştırır, <strong> vurgusunu atar", () => {
    const results = parseBrave({
      type: "search",
      web: {
        results: [
          {
            title: "Brave <strong>sonuç</strong>",
            url: "https://b.dev/1",
            description: "a <strong>b</strong>",
          },
          { title: "Adressiz" },
        ],
      },
    });
    expect(results).toEqual([{ title: "Brave sonuç", url: "https://b.dev/1", snippet: "a b" }]);
    expect(parseBrave({ type: "search" })).toEqual([]);
  });

  it("anahtar yoksa istek atmadan hata verir", async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    await expect(
      searchBrave(undefined, "q", { count: 5, lang: "tr", fetch: impl }),
    ).rejects.toThrow(/anahtarı girilmemiş/);
    expect(calls).toHaveLength(0);
  });

  it("başlığı gönderir ve sonuçları döner", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ web: { results: [{ title: "T", url: "https://b.dev/x", description: "D" }] } }),
    );
    const out = await searchBrave(" BSA-1 ", "pi", { count: 4, fetch: impl });
    expect(out).toEqual([{ title: "T", url: "https://b.dev/x", snippet: "D" }]);
    expect(calls[0]?.headers["x-subscription-token"]).toBe("BSA-1");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("count")).toBe("4");
  });

  it("401/429 yanıtlarını anlaşılır hataya çevirir", async () => {
    const denied = fakeFetch(() => new Response("", { status: 401 }));
    await expect(
      searchBrave("k", "q", { count: 5, lang: "tr", fetch: denied.impl }),
    ).rejects.toThrow(/reddedildi/);
    const limited = fakeFetch(() => new Response("", { status: 429 }));
    await expect(
      searchBrave("k", "q", { count: 5, lang: "tr", fetch: limited.impl }),
    ).rejects.toThrow(/hız sınırı/);
  });
});

describe("web_search sağlayıcı seçimi", () => {
  afterEach(() => vi.unstubAllGlobals());

  const DDG_HTML = `<div class="result results_links web-result "><a class="result__a" href="https://d.dev/1">DDG sonucu</a></div>`;

  async function run(tool: ReturnType<typeof webSearchTool>) {
    const result = await tool.execute(
      "id",
      { query: "codezal" },
      undefined,
      undefined,
      undefined as never,
    );
    const first = result.content[0];
    return {
      text: first && first.type === "text" ? first.text : "",
      endpoint: (result.details as { endpoint?: string }).endpoint,
    };
  }

  it("SearXNG başarılıysa sonuç SearXNG'den gelir", async () => {
    const fetchMock = vi.fn(async () =>
      json({ results: [{ title: "Sx", url: "https://s.dev/1" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = webSearchTool("tr", {
      provider: () => ({ provider: "searxng", searxngUrl: "https://searx.ornek.dev" }),
    });
    const out = await run(tool);
    expect(out.endpoint).toBe("searxng");
    expect(out.text).toContain("https://s.dev/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SearXNG başarısızsa DuckDuckGo'ya düşer ve notu başa ekler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("duckduckgo.com")
          ? new Response(DDG_HTML, { status: 200 })
          : new Response("Forbidden", { status: 403 }),
      ),
    );
    const tool = webSearchTool("tr", {
      provider: () => ({ provider: "searxng", searxngUrl: "https://searx.ornek.dev" }),
    });
    const out = await run(tool);
    expect(out.endpoint).toBe("html");
    expect(out.text.startsWith("Not: SearXNG araması başarısız oldu")).toBe(true);
    expect(out.text).toContain("DuckDuckGo");
    expect(out.text).toContain("https://d.dev/1");
  });

  it("Brave anahtarı yoksa DuckDuckGo'ya düşer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(DDG_HTML, { status: 200 })),
    );
    const tool = webSearchTool("tr", {
      provider: () => ({ provider: "brave", searxngUrl: "" }),
      braveKey: async () => undefined,
    });
    const out = await run(tool);
    expect(out.endpoint).toBe("html");
    expect(out.text).toContain("Brave araması başarısız oldu");
  });

  it("duckduckgo seçiminde not eklenmez", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(DDG_HTML, { status: 200 })),
    );
    const tool = webSearchTool("tr", {
      provider: () => ({ provider: "duckduckgo", searxngUrl: "" }),
    });
    const out = await run(tool);
    expect(out.endpoint).toBe("html");
    expect(out.text).not.toContain("Not:");
  });
});
