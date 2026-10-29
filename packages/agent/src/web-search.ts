import type { SearchBackend, WebSearchProvider } from "@codezal/contracts";
import { dict, type Locale, SOURCE_LOCALE } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapUntrusted } from "./untrusted.js";
import { extractPage, pickSummaryModel, type WebFetchOptions } from "./web-fetch.js";
import {
  NATIVE_TIMEOUT_MS,
  type NativeWebSearchResult,
  runNativeWebSearch,
} from "./web-search-native.js";
import { searchBrave, searchSearxng } from "./web-search-providers.js";

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 8;
/**
 * DuckDuckGo uç noktası. Tip kontrattan türetilir: sonuç `details.endpoint` olarak saklanır ve
 * kartta etiket olarak görünür, değerler tek yerde tanımlı kalsın.
 */
type DuckDuckGoEndpoint = Extract<SearchBackend, "html" | "lite">;
// Hız sınırı saniyeler sürer: tek denemede vazgeçilirse model sorguyu değiştirip yeniden
// deniyor ve sınırı besliyor. İki kısa bekleme çoğu durumda yetiyor.
const RETRY_DELAYS_MS = [1_500, 4_000];
// DuckDuckGo tarayıcı dışı istemcileri zaman zaman engeller; tarayıcı kimliği daha güvenilir.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** Geçici engel: bot doğrulama sayfası ya da 429/403 yanıtı. Beklenince geçer. */
export class SearchRateLimitError extends Error {}

/** Bekleme; tur durdurulunca iptal sinyaliyle hemen döner. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Etiketleri atar (özetlerde yalnızca `<b>` vurgusu var, boşluk eklenmez), varlıkları çözer. */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo'nun `//duckduckgo.com/l/?uddg=…` yönlendirmesini gerçek adrese çözer. */
export function resolveResultUrl(href: string): string {
  const raw = stripTags(href);
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return raw;
    }
  }
  return raw.startsWith("//") ? `https:${raw}` : raw;
}

/** `html.duckduckgo.com` sayfası: her sonuç `result__a` (başlık) ve `result__snippet` taşır. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const blocks = html.split(/<div class="result\s/).slice(1);
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link?.[1] || !link[2]) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    out.push({
      title: stripTags(link[2]),
      url: resolveResultUrl(link[1]),
      snippet: stripTags(snippet?.[1] ?? ""),
    });
  }
  return out;
}

/** `lite.duckduckgo.com` sayfası: `result-link` bağlantısı, ardından `result-snippet` hücresi. */
export function parseDuckDuckGoLite(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const re =
    /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>)?/g;
  for (const m of html.matchAll(re)) {
    if (!m[1] || !m[2]) continue;
    out.push({
      title: stripTags(m[2]),
      url: resolveResultUrl(m[1]),
      snippet: stripTags(m[3] ?? ""),
    });
  }
  return out;
}

/** DuckDuckGo'nun bot doğrulama sayfası: sonuç yerine "anomaly" betiği döner. */
export function looksBlocked(html: string): boolean {
  return /anomaly-modal|anomaly\.js|If this persists, please let us know/i.test(html);
}

/** Sonuçları modele okunur, numaralı liste olarak verir. */
export function formatResults(results: WebSearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");
}

/**
 * Yerleşik arama sonucunu modele verir: sağlayıcı aramayı ve sayfa okumayı kendi yaptığı
 * için sonuç tek tek adres değil, kaynaklara dayanan bir özet olur. Kaynak bağlantıları
 * yanıtın sonunda listelenir ve model bunları kullanıcıya aktarmaya yönlendirilir.
 */
export function formatNativeResults(
  result: NativeWebSearchResult,
  query: string,
  lang: Locale,
): string {
  const d = dict(lang);
  const p = d.prompt;
  // Özet sağlayıcının okuduğu sayfalardan üretilir; sayfalardaki talimat özete taşınabildiği için
  // özet ve kaynaklar da güvenilmez blokta verilir.
  const body = [
    p.webSearchNativeSummary,
    result.summary,
    "",
    p.webSearchNativeSources,
    ...result.sources.map((s) => `- [${s.title ?? s.url}](${s.url})`),
  ].join("\n");
  return [
    p.webSearchNativeResult.replace("{{query}}", () => query),
    "",
    wrapUntrusted(`web_search: ${query}`, body, lang),
    "",
    p.webSearchNativeReminder,
  ]
    .join("\n")
    .trim();
}

/**
 * Yerleşik (sağlayıcı tarafı) arama denemesi. Model ya da kayıt yoksa, sağlayıcı yerleşik
 * aramayı desteklemiyorsa ve istek başarısız olursa `undefined` döner; çağıran DuckDuckGo'ya
 * düşer. Tur durdurulduysa hata yukarı verilir: kullanıcı iptal ettiği turda yeni bir ağ
 * isteği başlatılmaz.
 */
async function tryNativeSearch(
  ctx: ExtensionContext | undefined,
  query: string,
  count: number | undefined,
  signal: AbortSignal | undefined,
  lang: Locale,
): Promise<NativeWebSearchResult | undefined> {
  const model = ctx?.model;
  const completer = ctx?.modelRegistry;
  if (!model || !completer) return undefined;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), NATIVE_TIMEOUT_MS);
  try {
    const result = await runNativeWebSearch({
      completer,
      model,
      query,
      lang,
      ...(count !== undefined ? { count } : {}),
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
    return result ?? undefined;
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
  });
  // 429 hız sınırı, 403 bot doğrulaması: ikisi de kalıcı hata değil, beklenip yeniden denenir.
  if (res.status === 429 || res.status === 403) {
    throw new SearchRateLimitError(`${res.status} ${res.statusText}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/** Tek deneme: önce `html.`, engellenir ya da boş dönerse `lite.`. */
async function attemptSearch(
  params: URLSearchParams,
  count: number,
  signal: AbortSignal | undefined,
): Promise<{ results: WebSearchResult[]; endpoint: DuckDuckGoEndpoint }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    let blocked = false;
    const html = await fetchText(`https://html.duckduckgo.com/html/?${params}`, ac.signal);
    if (looksBlocked(html)) blocked = true;
    else {
      const results = parseDuckDuckGoHtml(html);
      if (results.length > 0) return { results: results.slice(0, count), endpoint: "html" };
    }
    const lite = await fetchText(`https://lite.duckduckgo.com/lite/?${params}`, ac.signal);
    if (looksBlocked(lite)) throw new SearchRateLimitError("anomaly");
    const results = parseDuckDuckGoLite(lite);
    if (results.length === 0 && blocked) throw new SearchRateLimitError("anomaly");
    return { results: results.slice(0, count), endpoint: "lite" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Hız sınırına takılan denemeyi kısa aralıklarla yineler. Sınır dışındaki hatalar (ağ, zaman
 * aşımı) olduğu gibi çıkar. Sonunda hâlâ sınırdaysa modele ham "429" değil, ne yapması
 * gerektiğini söyleyen mesaj gider. `sleep` yalnızca testte gerçek beklemeyi atlamak için.
 */
export async function withRateLimitRetry<T>(
  attempt: () => Promise<T>,
  blockedMessage: string,
  options: {
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? delay;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof SearchRateLimitError)) throw err;
      const wait = RETRY_DELAYS_MS[i];
      if (wait === undefined || options.signal?.aborted) {
        throw new SearchRateLimitError(blockedMessage);
      }
      await sleep(wait, options.signal);
    }
  }
}

/**
 * DuckDuckGo HTML uç noktasında arama; anahtar ve paket gerektirmez. Hız sınırına takılırsa
 * kısa aralıklarla yeniden dener, sonunda anlaşılır hata verir.
 */
export async function searchDuckDuckGo(
  query: string,
  options: { count?: number; region?: string; lang?: Locale; signal?: AbortSignal } = {},
): Promise<{ results: WebSearchResult[]; endpoint: DuckDuckGoEndpoint }> {
  const d = dict(options.lang ?? SOURCE_LOCALE);
  const count = Math.min(MAX_RESULTS, Math.max(1, options.count ?? DEFAULT_RESULTS));
  const params = new URLSearchParams({ q: query });
  if (options.region) params.set("kl", options.region);
  return withRateLimitRetry(
    () => attemptSearch(params, count, options.signal),
    d.errors.searchBlocked,
    options.signal ? { signal: options.signal } : {},
  );
}

/**
 * Asistan için web arama aracı: DuckDuckGo üzerinden başlık, adres ve özet listesi döner.
 * Sayfa içeriği için model ardından `web_fetch` çağırır. Dil, araç açıklamasını seçer.
 */
/**
 * Arama aracının seçenekleri; `quarantine` `web_fetch` ile aynı: gözetimsiz görev koşusunda
 * sonuçlar ana ajana verilmez, araçsız ayrı bir model çağrısıyla özetlenir.
 */
export type WebSearchOptions = Pick<WebFetchOptions, "quarantine" | "summaryModel"> & {
  /** Ayarlar > Bağlantı > Web araması; her çağrıda canlı okunur. Verilmezse `auto`. */
  provider?: () => { provider: WebSearchProvider; searxngUrl: string };
  /** Brave anahtarı main'deki havuzdan okunur; değer araç sonucuna ya da modele girmez. */
  braveKey?: () => Promise<string | undefined>;
};

/** Açık sağlayıcının adı; geri düşüş notunda geçer. */
const PROVIDER_NAMES = { searxng: "SearXNG", brave: "Brave" } as const;

export function webSearchTool(lang: Locale = "tr", options: WebSearchOptions = {}) {
  const d = dict(lang);
  return defineTool({
    name: "web_search",
    label: "Web",
    description: d.prompt.webSearchDesc,
    promptSnippet: d.prompt.webSearchSnippet,
    parameters: Type.Object({
      query: Type.String({ description: d.prompt.webSearchQuery }),
      count: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: d.prompt.webSearchCount }),
      ),
      region: Type.Optional(Type.String({ description: d.prompt.webSearchRegion })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) throw new Error(d.errors.searchEmptyQuery);
      // Model yerleşik aramayı destekliyorsa arama sağlayıcıda yapılır; aksi halde ya da
      // yerleşik arama sonuçsuz kalırsa DuckDuckGo yolu izlenir.
      // Gözetimsiz görevde ham sonuç (yerleşik aramanın özeti de sağlayıcının okuduğu sayfalardan
      // gelir) ana ajana verilmez; ayrı model yalnız sorguyla ilgili bulguları ve kaynakları yazar.
      const quarantined = options.quarantine?.() === true;
      const deliver = async (raw: string, source: string) => {
        if (!quarantined) return raw;
        const summary = await extractPage(
          {
            completer: ctx?.modelRegistry,
            model: pickSummaryModel(ctx, options.summaryModel?.()),
            url: source,
            page: raw,
            prompt: d.prompt.webSearchExtractPrompt.replace("{{query}}", () => query),
            signal,
          },
          lang,
        );
        return `${d.prompt.webSearchExtracted}\n\n${wrapUntrusted(source, summary, lang)}`;
      };
      // Sonuç listesi (DuckDuckGo ya da açık sağlayıcı) aynı biçimde modele verilir.
      const listResult = async (
        results: WebSearchResult[],
        endpoint: SearchBackend,
        sourceName: string,
        note?: string,
      ) => {
        const source = `${sourceName}: ${query}`;
        const body =
          results.length === 0
            ? d.prompt.webSearchNoResults.replace("{{query}}", query)
            : quarantined
              ? await deliver(formatResults(results), source)
              : wrapUntrusted(source, formatResults(results), lang);
        return {
          content: [{ type: "text" as const, text: note ? `${note}\n\n${body}` : body }],
          details: { query, endpoint, results, ...(quarantined ? { quarantined } : {}) },
        };
      };
      const choice = options.provider?.() ?? { provider: "auto", searxngUrl: "" };
      const count = Math.min(MAX_RESULTS, Math.max(1, params.count ?? DEFAULT_RESULTS));
      // Açık sağlayıcı başarısızsa (adres/anahtar eksik, JSON kapalı, ağ) DuckDuckGo'ya düşülür ve
      // model nedenini sonucun başındaki nottan okur. Tur iptal edildiyse yeni istek açılmaz.
      let note: string | undefined;
      if (choice.provider === "searxng" || choice.provider === "brave") {
        const name = PROVIDER_NAMES[choice.provider];
        const providerOptions = { count, lang, ...(signal ? { signal } : {}) };
        try {
          const results =
            choice.provider === "searxng"
              ? await searchSearxng(choice.searxngUrl, query, providerOptions)
              : await searchBrave(await options.braveKey?.(), query, providerOptions);
          return await listResult(results, choice.provider, choice.provider);
        } catch (err) {
          if (signal?.aborted) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          note = d.prompt.webSearchFallbackNote
            .replace("{{provider}}", () => name)
            .replace("{{reason}}", () => reason);
        }
      }
      // Yerleşik arama yalnız `auto`da denenir; açık seçim modelin sağlayıcısını atlar.
      const native =
        choice.provider === "auto"
          ? await tryNativeSearch(ctx, query, params.count, signal, lang)
          : undefined;
      if (native) {
        return {
          content: [
            {
              type: "text",
              text: await deliver(formatNativeResults(native, query, lang), `web_search: ${query}`),
            },
          ],
          details: {
            query,
            endpoint: "native",
            sources: native.sources,
            ...(quarantined ? { quarantined } : {}),
          },
        };
      }
      const { results, endpoint } = await searchDuckDuckGo(query, {
        ...(params.count !== undefined ? { count: params.count } : {}),
        ...(params.region ? { region: params.region } : {}),
        lang,
        ...(signal ? { signal } : {}),
      });
      return listResult(results, endpoint, "duckduckgo", note);
    },
  });
}
