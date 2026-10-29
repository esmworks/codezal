import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Command Code (commandcode.ai) sağlayıcısı. Pi'nin yerleşik kataloğunda yok; runtime'a
 * `registerProvider` ile kaydedilir. Böylece Ayarlar > Bağlantı'da diğer sağlayıcılar gibi
 * görünür ve API anahtarı mevcut kimlik havuzundan (keys.json → auth.json) girilir.
 *
 * Uçlar 2026-09-18'de doğrulandı: OpenAI uyumlu `.../provider/v1/chat/completions`, Claude
 * modelleri Anthropic uyumlu `.../provider/v1/messages`. İki uç da Bearer ya da x-api-key
 * kabul eder. Model listesi `GET /provider/v1/models` çıktısından; fiyatlar docs
 * "Pricing & Limits" tablosundan (deal ve DeepSeek off-peak fiyatlarıyla). Liste katalog
 * tazelenirken canlı uçtan güncellenir; Pi sağlayıcıyı yerleşik getirirse bu kayıt kaldırılır.
 */

/** Claude dışı modellerin aktığı OpenAI uyumlu uç. */
const OPENAI_BASE_URL = "https://api.commandcode.ai/provider/v1";

/** Claude modelleri yalnızca Anthropic Messages ucunda sunulur. */
const ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";

/** Pi kayıt şeması `maxTokens` ister; model başına çıktı sınırı katalogda yok, Pi varsayılanı. */
const MAX_TOKENS = 16384;

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type ModelEntry = NonNullable<ProviderConfig["models"]>[number];

/** Milyon token başına USD: girdi, çıktı, önbellek okuma, önbellek yazma. */
type Cost = [input: number, output: number, cacheRead: number, cacheWrite: number];

/**
 * Claude modelleri id ile ayrılır ve Anthropic ucuna yönlenir. Thinking parametreleri model
 * ailesine göre değiştiğinden `reasoning` kapalı; yanlış gövde göndermek istek hatası üretir.
 * Command Code'un kendi istemcisi gövdede `max_tokens` kullanıyor; Pi varsayılanı
 * `max_completion_tokens` olduğundan ağ geçidinin kanıtlanmış alanı açıkça seçilir.
 */
function model(
  id: string,
  name: string,
  contextWindow: number,
  cost: Cost,
  vision = false,
  claude = id.startsWith("claude"),
): ModelEntry {
  return {
    id,
    name,
    ...(claude
      ? { api: "anthropic-messages" as const, baseUrl: ANTHROPIC_BASE_URL }
      : { compat: { maxTokensField: "max_tokens" as const } }),
    reasoning: false,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3] },
    contextWindow,
    maxTokens: MAX_TOKENS,
  };
}

/**
 * `/provider/v1/models` listesi (2026-09-24): 81 model, bağlam penceresi ve docs fiyatıyla.
 * Ağ yokken kullanılan taban; çalışma anında `fetchCommandCodeModels` canlı listeyle günceller.
 * Grok 4.7 liste fiyatıyla (%40 indirim 2026-09-27'de bitiyor).
 */
export const COMMAND_CODE_MODELS: ModelEntry[] = [
  model("claude-sonnet-5", "Claude Sonnet 5", 1000000, [2, 10, 0.2, 2.5], true),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6", 1000000, [3, 15, 0.3, 3.75], true),
  model("claude-fable-5-1", "Claude Fable 5.1", 1000000, [10, 50, 0.25, 12.5], true),
  model("claude-fable-5", "Claude Fable 5", 1000000, [10, 50, 1, 12.5], true),
  model("claude-opus-5-5", "Claude Opus 5.5", 1000000, [4, 20, 0.2, 5], true),
  model("claude-opus-5", "Claude Opus 5", 1000000, [5, 25, 0.5, 6.25], true),
  model("claude-opus-4-8", "Claude Opus 4.8", 1000000, [5, 25, 0.5, 6.25], true),
  model("claude-opus-4-7", "Claude Opus 4.7", 1000000, [5, 25, 0.5, 6.25], true),
  model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200000, [1, 5, 0.1, 1.25], true),
  model("gpt-6-astra", "GPT-6 Astra", 1050000, [10, 50, 1, 12.5], true),
  model("gpt-6-sol", "GPT-6 Sol", 1050000, [2, 10, 0.2, 2.5], true),
  model("gpt-6-luna", "GPT-6 Luna", 1050000, [0.1, 0.5, 0.01, 0.125], true),
  model("gpt-5.6-sol", "GPT-5.6 Sol", 1050000, [5, 30, 0.5, 6.25], true),
  model("gpt-5.6-terra", "GPT-5.6 Terra", 1050000, [2, 12, 0.2, 2.5], true),
  model("gpt-5.6-luna", "GPT-5.6 Luna", 1050000, [0.2, 1.2, 0.02, 0.25], true),
  model("gpt-5.5", "GPT-5.5", 400000, [5, 30, 0.5, 0], true),
  model("gpt-5.4", "GPT-5.4", 400000, [2.5, 15, 0.25, 0], true),
  model("gpt-5.3-codex", "GPT-5.3 Codex", 400000, [2, 8, 0.5, 0], true),
  model("gpt-5.4-mini", "GPT-5.4 Mini", 400000, [0.75, 4.5, 0.075, 0], true),
  model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1000000, [0.66, 1.98, 0.022, 0]),
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1000000, [0.15, 0.6, 0.003, 0]),
  model(
    "deepseek/deepseek-v4-flash-vision-exp",
    "DeepSeek V4 Flash Vision (exp)",
    1000000,
    [0.15, 0.6, 0.003, 0],
    true,
  ),
  model(
    "deepseek/deepseek-v4-flash-fast",
    "DeepSeek V4 Flash Fast",
    1000000,
    [0.28, 0.56, 0.07, 0],
  ),
  model(
    "deepseek/deepseek-v4.1-flash",
    "DeepSeek V4.1 Flash",
    1000000,
    [0.15, 0.6, 0.003, 0],
    true,
  ),
  model("moonshotai/Kimi-K3", "Kimi K3", 1000000, [3, 15, 0.3, 0], true),
  model("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256000, [0.95, 4, 0.19, 0], true),
  model(
    "moonshotai/Kimi-K2.7-Code-Highspeed",
    "Kimi K2.7 Code HighSpeed",
    262000,
    [1.9, 8, 0.38, 0],
    true,
  ),
  model("moonshotai/Kimi-K2.6", "Kimi K2.6", 256000, [0.95, 4, 0.16, 0], true),
  model("moonshotai/Kimi-K2.5", "Kimi K2.5", 256000, [0.6, 3, 0.1, 0], true),
  model("z-ai/glm-5.3-flash", "GLM-5.3 Flash", 1048576, [0.15, 0.5, 0.03, 0]),
  model("z-ai/glm-5.3-flashx", "GLM-5.3 FlashX", 1000000, [0.37, 1.25, 0.075, 0], true),
  model("zai-org/GLM-5.3", "GLM-5.3", 1000000, [1.4, 4.4, 0.26, 0]),
  model("zai-org/GLM-5.2", "GLM-5.2", 1000000, [1.4, 4.4, 0.26, 0]),
  model("zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1000000, [3, 10.25, 0.5, 0]),
  model("zai-org/GLM-5.1", "GLM-5.1", 200000, [1.4, 4.4, 0.26, 0]),
  model("zai-org/GLM-5", "GLM-5", 200000, [1, 3.2, 0.2, 0]),
  model("MiniMaxAI/MiniMax-M3", "MiniMax M3", 1000000, [0.3, 1.2, 0.06, 0], true),
  model("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200000, [0.3, 1.2, 0.06, 0]),
  model("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200000, [0.3, 1.2, 0.03, 0]),
  model("xiaomi/mimo-v2.6-pro", "MiMo V2.6 Pro", 1048576, [0.435, 0.87, 0.0036, 0], true),
  model(
    "xiaomi/mimo-v2.6-pro-ultraspeed",
    "MiMo V2.6 Pro UltraSpeed",
    1048576,
    [4.35, 8.7, 0.036, 0],
    true,
  ),
  model("xiaomi/mimo-v2.6-flash", "MiMo V2.6 Flash", 1048576, [0.14, 0.28, 0.0028, 0], true),
  model("xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1000000, [0.435, 0.87, 0.0036, 0]),
  model("xiaomi/mimo-v2.5", "MiMo V2.5", 1000000, [0.14, 0.28, 0.0028, 0]),
  model("Qwen/Qwen3.8-Omni-Flash", "Qwen 3.8 Omni Flash", 1000000, [0.15, 0.47, 0.016, 0], true),
  model("Qwen/Qwen3.8-Max-0902", "Qwen 3.8 Max 0902", 1000000, [2, 6, 0.25, 0]),
  model("Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1000000, [2, 6, 0.25, 2.5]),
  model("Qwen/Qwen3.8-27B", "Qwen 3.8 27B", 262144, [0.4, 3, 0.04, 0], true),
  model("Qwen/Qwen3.8-Flash", "Qwen 3.8 Flash", 1000000, [0.16, 0.47, 0.016, 0]),
  model("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1000000, [2.5, 7.5, 0.5, 3.13]),
  model("Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1000000, [0.4, 1.6, 0.08, 0.5]),
  model("Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1000000, [0.03, 0.13, 0.006, 0.038]),
  model("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200000, [1.3, 7.8, 0.26, 1.63]),
  model("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200000, [0.5, 3, 0.1, 0]),
  model("meituan/LongCat-2.0", "LongCat 2.0", 1048576, [0.3, 1.2, 0.006, 0]),
  model("stepfun/Step-5-Preview", "Step 5 Preview", 1000000, [1, 2.7, 0.05, 0], true),
  model("stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256000, [0.2, 1.15, 0.04, 0], true),
  model("stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1000000, [0.1, 0.3, 0.02, 0]),
  model("tencent/hy3-paid", "Tencent Hy3", 262144, [0.14, 0.58, 0.035, 0]),
  model("tencent/hy4-preview", "Tencent Hy4 Preview", 1048576, [0.834, 2.501, 0.042, 0]),
  model("google/gemini-3.8-flash", "Gemini 3.8 Flash", 1000000, [1.5, 7.5, 0.15, 0], true),
  model("google/gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, [1.5, 7.5, 0.15, 0.08334], true),
  model("google/gemini-3.6-flash", "Gemini 3.6 Flash", 1000000, [1.5, 7.5, 0.15, 0], true),
  model("google/gemini-3.5-flash", "Gemini 3.5 Flash", 1000000, [1.5, 9, 0.15, 0], true),
  model(
    "google/gemini-3.5-flash-lite",
    "Gemini 3.5 Flash Lite",
    1000000,
    [0.3, 2.5, 0.03, 0],
    true,
  ),
  model(
    "google/gemini-3.1-flash-lite",
    "Gemini 3.1 Flash Lite",
    1000000,
    [0.25, 1.5, 0.03, 0],
    true,
  ),
  model("stealth/space-bunny-alpha", "Space Bunny Alpha", 1000000, [0, 0, 0, 0], true),
  model("sakana/fugu-ultra", "Fugu Ultra", 1000000, [5, 30, 0.5, 0]),
  model("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1000000, [0.6, 2.4, 0.12, 0]),
  model("thinkingmachines/inkling", "Inkling", 256000, [1, 4.05, 0.17, 0], true),
  model("thinkingmachines/inkling-small", "Inkling Small", 1000000, [0.5, 1.2, 0.1, 0], true),
  model("poolside/laguna-s-2.1-free", "Laguna S 2.1", 256000, [0, 0, 0, 0]),
  model("inclusionai/ling-3.0-flash-sante:free", "Ling 3.0 Flash Sante", 262144, [0, 0, 0, 0]),
  model("meta/muse-spark-1.1", "Muse Spark 1.1", 1048576, [1.25, 4.25, 0.15, 0]),
  model("meta/muse-spark-1.2", "Muse Spark 1.2", 1048576, [1.25, 4.25, 0.15, 0]),
  model(
    "meta/muse-spark-1.2-contributor",
    "Muse Spark 1.2 Contributor",
    1048576,
    [0.1, 0.2, 0.002, 0],
  ),
  model("meta/muse-spark-1.3", "Muse Spark 1.3", 1048576, [1.25, 4.25, 0.15, 0], true),
  model(
    "meta/muse-spark-1.3-contributor",
    "Muse Spark 1.3 Contributor",
    1048576,
    [0.1, 0.2, 0.002, 0],
    true,
  ),
  model("xai/grok-4.5", "Grok 4.5", 500000, [2, 6, 0.5, 0], true),
  model("xai/grok-4.6", "Grok 4.6", 500000, [2, 6, 0.5, 0], true),
  model("xai/grok-4.7", "Grok 4.7", 500000, [2, 6, 0.5, 0], true),
];

/** `/provider/v1/models` satırı; yalnız kullanılan alanlar. */
type RemoteModel = {
  id: string;
  name?: string;
  context_length?: number;
  supported_endpoints?: string[];
};

function isRemoteModel(value: unknown): value is RemoteModel {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id !== ""
  );
}

/**
 * Canlı model listesini çeker ve gömülü katalogla birleştirir. Liste sağlayıcıda sık değişiyor
 * (yeni model, kalkan `:free` eki); gömülü liste uygulama sürümüyle donduğu için yeni modeller
 * ancak böyle görünür. Uç anahtarsız açık. Fiyat ve görsel desteği listede yok: bilinen modelde
 * gömülü değer korunur, yeni modelde fiyat 0 ve yalnız metin kalır (görsel göndermek istek
 * hatası üretebilir). Ağ ya da biçim hatasında `undefined` döner; çağıran gömülü listeyle sürer.
 */
export async function fetchCommandCodeModels(
  signal?: AbortSignal,
): Promise<ModelEntry[] | undefined> {
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/models`, signal ? { signal } : {});
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const data =
      typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)
        ? body.data.filter(isRemoteModel)
        : [];
    // Boş liste geçici bir ağ geçidi arızası sayılır; tüm modelleri silmek yerine gömülüde kal.
    if (data.length === 0) return undefined;
    const known = new Map(COMMAND_CODE_MODELS.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const models: ModelEntry[] = [];
    for (const r of data) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const base = known.get(r.id);
      const name = r.name?.trim() || base?.name || r.id;
      const contextWindow =
        typeof r.context_length === "number" && r.context_length > 0
          ? r.context_length
          : (base?.contextWindow ?? 128000);
      if (base) {
        models.push({ ...base, name, contextWindow });
        continue;
      }
      // Yalnız Messages ucu sunan model Anthropic yoluna gider (Claude ailesi).
      const endpoints = r.supported_endpoints ?? [];
      const claude = endpoints.includes("/messages") && !endpoints.includes("/chat/completions");
      models.push(model(r.id, name, contextWindow, [0, 0, 0, 0], false, claude));
    }
    return models;
  } catch {
    return undefined;
  }
}

/**
 * Sağlayıcıyı runtime'a kaydeder. Kimlik bilgisi burada tutulmaz; `apiKey` auth'u Pi tarafından
 * üretilir, anahtar Ayarlar > Bağlantı'dan girilince kimlik havuzuna düşer.
 */
export function registerCommandCode(
  rt: Pick<ModelRuntime, "registerProvider">,
  models: ModelEntry[] = COMMAND_CODE_MODELS,
): void {
  // Pi yeniden kayıtta `models` alanını tümüyle değiştirir; tazeleme aynı çağrıyla yapılır.
  rt.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: OPENAI_BASE_URL,
    api: "openai-completions",
    models,
  });
}
