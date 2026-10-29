import { dict, type Locale } from "@codezal/i18n";
import {
  type Api,
  type AssistantMessage,
  type Context,
  contentText,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";

/** Sağlayıcının yerleşik aramada yapabileceği en fazla arama sayısı. */
const DEFAULT_MAX_USES = 8;
/** Modele dönen kaynak sınırı: uzun bağlantı listesi bağlamı yer, sorgu başına özet yeter. */
const MAX_SOURCES = 20;
/** Özet için token sınırı: araç rapor değil kaynak toplar, uzun yanıt maliyeti boşa çıkarır. */
const MAX_SUMMARY_TOKENS = 4_096;
/**
 * Yerleşik arama isteğinin zaman aşımı. Sağlayıcı aramada sayfaları kendi okur ve yanıtı
 * yazar; DuckDuckGo'nun tek isteğinden belirgin biçimde uzun sürer.
 */
export const NATIVE_TIMEOUT_MS = 60_000;

export interface NativeSource {
  title?: string;
  url: string;
}

/** Yerleşik arama aracını taşımayan sağlayıcının istek gövdesine eklenecek araç tanımı. */
export interface NativeSearchSpec {
  tool: Record<string, unknown>;
}

/**
 * Tek seferlik model çağrısı: `ModelRegistry.complete` bu sözleşmeyi yapısal olarak karşılar,
 * testler ise ağa çıkmadan sahte bir tamamlayıcı verebilir.
 */
export interface NativeSearchCompleter {
  complete(model: Model<Api>, context: Context, options?: StreamOptions): Promise<AssistantMessage>;
}

export interface NativeWebSearchInput {
  completer: NativeSearchCompleter;
  model: Model<Api>;
  query: string;
  lang: Locale;
  count?: number;
  signal?: AbortSignal;
}

export interface NativeWebSearchResult {
  summary: string;
  sources: NativeSource[];
}

/**
 * Sağlayıcı API'sinin yerleşik arama aracı. Pi SDK yalnızca istemci tarafı araçları modelliyor;
 * sunucu tarafı arama aracını istek gövdesine biz ekliyoruz (bkz. `injectNativeSearch`).
 * Desteklemeyen API'de undefined döner ve araç DuckDuckGo yoluna düşer.
 */
export function nativeSearchSpec(
  model: Model<Api>,
  maxUses: number = DEFAULT_MAX_USES,
): NativeSearchSpec | undefined {
  switch (model.api) {
    case "anthropic-messages":
      // Anthropic'in web arama aracı: aramayı sağlayıcı yapar, `max_uses` üst sınırı koyar.
      return { tool: { type: "web_search_20250305", name: "web_search", max_uses: maxUses } };
    case "openai-responses":
    case "azure-openai-responses":
      return { tool: { type: "web_search" } };
    case "google-generative-ai":
    case "google-vertex":
      return { tool: { google_search: {} } };
    default:
      return undefined;
  }
}

/**
 * İstek gövdesine yerleşik arama aracını ekler. Pi SDK araç listesini yalnızca istemci
 * araçlarından kurar ve gövdeyi göndermeden önceki son kanca `onPayload`'dır.
 */
export function injectNativeSearch(payload: unknown, spec: NativeSearchSpec): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const body = payload as Record<string, unknown>;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return { ...body, tools: [...tools, spec.tool] };
}

/**
 * Yanıt metnindeki markdown bağlantıları kaynak sayar. Sağlayıcı atıfları ayrı alanlarda
 * gelse de Pi SDK metin dışındaki alanları modele taşımıyor; bu yüzden özet metni tek kaynak.
 */
export function sourcesFromText(text: string): NativeSource[] {
  const out: NativeSource[] = [];
  const seen = new Set<string>();
  // Görsel bağlantıları (`![...](...)`) kaynak değildir; etiketsiz bağlantı adresle listelenir.
  for (const match of text.matchAll(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (match.index !== undefined && text[match.index - 1] === "!") continue;
    const url = match[2]?.trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = match[1]?.trim();
    out.push({ url, ...(title ? { title } : {}) });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/**
 * Sağlayıcının yerleşik aramasıyla iç model isteği: araç kendisi arama yapmaz, arama yeteneği
 * olan modele tek bir istek atıp özeti ve kaynakları normalize eder (ZCode'un WebSearch
 * sistemi). Kaynaksız ya da boş özet arama sonucu sayılmaz: sağlayıcı yerleşik aracı yok
 * saydıysa model kendi bilgisinden yanıtlar ve DuckDuckGo sonuçları daha doğru olur.
 */
export async function runNativeWebSearch(
  input: NativeWebSearchInput,
): Promise<NativeWebSearchResult | null> {
  const spec = nativeSearchSpec(input.model, input.count ?? DEFAULT_MAX_USES);
  if (!spec) return null;
  const d = dict(input.lang);
  const message = await input.completer.complete(
    input.model,
    {
      systemPrompt: d.prompt.webSearchNativeSystem,
      messages: [
        {
          role: "user",
          content: d.prompt.webSearchNativeUser.replace("{{query}}", () => input.query),
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: MAX_SUMMARY_TOKENS,
      onPayload: (payload) => injectNativeSearch(payload, spec),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const summary = contentText(message.content).trim();
  const sources = sourcesFromText(summary);
  if (!summary || sources.length === 0) return null;
  return { summary, sources };
}
