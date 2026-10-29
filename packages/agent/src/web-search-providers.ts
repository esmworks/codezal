import { dict, type Locale, SOURCE_LOCALE } from "@codezal/i18n";
// Döngüsel içe aktarım güvenli: `stripTags` yalnız çağrı anında kullanılır, modül yüklenirken değil.
import { stripTags, type WebSearchResult } from "./web-search.js";

/**
 * Kullanıcının seçtiği açık arama sağlayıcıları (Ayarlar > Bağlantı > Web araması). DuckDuckGo
 * ve yerleşik arama `web-search.ts`te; bu dosya yalnız anahtar ya da adres isteyen sağlayıcılar.
 */

const TIMEOUT_MS = 20_000;
/** Brave `count` üst sınırı 20; araç zaten en çok 10 ister. */
const BRAVE_MAX_COUNT = 20;
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
/**
 * Brave anahtarının `keys.json` havuzundaki ayrılmış kimliği. Pi sağlayıcı kimlikleriyle çakışmasın
 * diye önekli; Pi'nin katalogunda karşılığı olmadığı için sağlayıcı listesinde görünmez.
 */
export const BRAVE_KEY_ID = "codezal-brave-search";

/** Test için `fetch` değiştirilebilir; uygulamada genel `fetch` kullanılır. */
type Fetch = typeof fetch;

export interface ProviderSearchOptions {
  count: number;
  lang?: Locale;
  signal?: AbortSignal;
  fetch?: Fetch;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
}

/** Sağlayıcı hatası; mesaj modele ve geri düşüş notuna olduğu gibi gider (anahtar içermez). */
export class SearchProviderError extends Error {}

function errors(lang: Locale | undefined) {
  return dict(lang ?? SOURCE_LOCALE).errors;
}

/**
 * SearXNG örneğinin kök adresini doğrular: yalnız http(s), sondaki eğik çizgiler atılır. Kullanıcı
 * yanlışlıkla `/search` ile bitirdiyse o da atılır; istek her zaman `<kök>/search` olur.
 */
export function normalizeSearxngUrl(raw: string, lang?: Locale): string {
  const e = errors(lang);
  const trimmed = raw.trim();
  if (!trimmed) throw new SearchProviderError(e.searxngUrlMissing);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SearchProviderError(e.searxngUrlInvalid);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SearchProviderError(e.searxngUrlInvalid);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed
    .toString()
    .replace(/\/+$/, "")
    .replace(/\/search$/, "");
}

export function buildSearxngRequest(
  baseUrl: string,
  query: string,
  lang?: Locale,
): ProviderRequest {
  const params = new URLSearchParams({ q: query, format: "json" });
  return {
    url: `${normalizeSearxngUrl(baseUrl, lang)}/search?${params}`,
    headers: { accept: "application/json" },
  };
}

export function buildBraveRequest(apiKey: string, query: string, count: number): ProviderRequest {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(BRAVE_MAX_COUNT, Math.max(1, count))),
  });
  return {
    url: `${BRAVE_SEARCH_URL}?${params}`,
    headers: { accept: "application/json", "x-subscription-token": apiKey },
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? stripTags(value) : "";
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : undefined;
}

/** SearXNG JSON yanıtı: `results[].{title, url, content}`. Adresi olmayan satır atılır. */
export function parseSearxng(body: unknown): WebSearchResult[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const row = r as { title?: unknown; url?: unknown; content?: unknown };
    const url = httpUrl(row.url);
    if (!url) return [];
    return [{ title: text(row.title) || url, url, snippet: text(row.content) }];
  });
}

/** Brave Search API yanıtı: `web.results[].{title, url, description}` (vurgu `<strong>` ile). */
export function parseBrave(body: unknown): WebSearchResult[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { web?: { results?: unknown } }).web?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const row = r as { title?: unknown; url?: unknown; description?: unknown };
    const url = httpUrl(row.url);
    if (!url) return [];
    return [{ title: text(row.title) || url, url, snippet: text(row.description) }];
  });
}

/** Zaman aşımı + tur iptali birleşik sinyal; dönen `done` zamanlayıcıyı temizler. */
function timed(signal: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  return {
    signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    done: () => clearTimeout(timer),
  };
}

/** Gövdeyi JSON olarak okur; JSON değilse `undefined` (SearXNG JSON kapalıyken HTML döner). */
async function readJson(res: Response): Promise<unknown> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * SearXNG örneğinde arama. Pek çok genel örnek JSON biçimini kapatır (`search.formats` içinde
 * `json` yok): bu durumda 403 ya da HTML sayfası döner; ikisi de anlaşılır tek hataya çevrilir.
 */
export async function searchSearxng(
  baseUrl: string,
  query: string,
  options: ProviderSearchOptions,
): Promise<WebSearchResult[]> {
  const e = errors(options.lang);
  const req = buildSearxngRequest(baseUrl, query, options.lang);
  const doFetch = options.fetch ?? fetch;
  const t = timed(options.signal);
  try {
    const res = await doFetch(req.url, { headers: req.headers, signal: t.signal });
    if (res.status === 403) throw new SearchProviderError(e.searxngJsonDisabled);
    if (!res.ok) {
      throw new SearchProviderError(e.searxngFailed.replace("{{status}}", () => `${res.status}`));
    }
    const body = await readJson(res);
    if (body === undefined) throw new SearchProviderError(e.searxngJsonDisabled);
    return parseSearxng(body).slice(0, options.count);
  } finally {
    t.done();
  }
}

/** Brave Search API'de arama; anahtar `X-Subscription-Token` başlığıyla gider. */
export async function searchBrave(
  apiKey: string | undefined,
  query: string,
  options: ProviderSearchOptions,
): Promise<WebSearchResult[]> {
  const e = errors(options.lang);
  const key = apiKey?.trim();
  if (!key) throw new SearchProviderError(e.braveKeyMissing);
  const req = buildBraveRequest(key, query, options.count);
  const doFetch = options.fetch ?? fetch;
  const t = timed(options.signal);
  try {
    const res = await doFetch(req.url, { headers: req.headers, signal: t.signal });
    if (res.status === 401 || res.status === 403) throw new SearchProviderError(e.braveKeyInvalid);
    if (res.status === 429) throw new SearchProviderError(e.braveRateLimited);
    if (!res.ok) {
      throw new SearchProviderError(e.braveFailed.replace("{{status}}", () => `${res.status}`));
    }
    const body = await readJson(res);
    if (body === undefined) {
      throw new SearchProviderError(e.braveFailed.replace("{{status}}", () => `${res.status}`));
    }
    return parseBrave(body).slice(0, options.count);
  } finally {
    t.done();
  }
}
