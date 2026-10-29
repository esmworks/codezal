import { dict, type Locale } from "@codezal/i18n";
import { isLimitError, isQuotaExhausted } from "./limit.js";
import { maskSecrets } from "./mask.js";

/**
 * Sabit hata sebepleri. Metin değişebilir, sebep değişmez: arayüz buna göre farklı davranır,
 * tanı paketi bu kodlarla sayım yapar ve "hangi hata ne sıklıkta" sorusu ölçülebilir olur.
 * ZCode aynı ayrımı yapar (`quota_exhausted`, `rate_limited`, …) ve serbest metne göre karar
 * vermez.
 */
export const PROVIDER_ERROR_REASONS = [
  "rate_limited",
  "quota_exhausted",
  "auth_failed",
  "context_exceeded",
  "request_too_large",
  "provider_overloaded",
  "provider_aborted",
  "network",
  "timeout",
  "unknown",
] as const;
export type ProviderErrorReason = (typeof PROVIDER_ERROR_REASONS)[number];

/** Kimlik reddi: anahtar geçersiz ya da yetki yok. Anahtar değiştirmek işe yarar. */
const AUTH_FAILED =
  /\b(401|403)\b|unauthorized|invalid[_ ]api[_ ]key|api key not valid|forbidden|permission denied/i;

/** Bağlam penceresi: sağlayıcı isteği uzunluk yüzünden reddetti. */
const CONTEXT_EXCEEDED =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|prompt_too_long/i;

/** Aşırı yük: sağlayıcı tarafı geçici olarak doygun. */
const OVERLOADED =
  /\b(429|500|502|503|504|529)\b|overloaded|service unavailable|bad gateway|internal server error/i;

/** Ağ ve zaman aşımı. */
const NETWORK =
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|ETIMEDOUT|socket hang up|network error|fetch failed/i;
const TIMEOUT = /timeout|timed out|request aborted/i;

/**
 * Sağlayıcı hatasını sabit bir sebebe indirger. Sıra önemli: kotayı tespit eden desenler
 * `429`u da kapsadığı için önce daha özgül olanlar denenir.
 */
export function classifyProviderError(message: string | undefined): ProviderErrorReason {
  if (!message) return "unknown";
  if (isQuotaExhausted(message)) return "quota_exhausted";
  if (isLimitError(message)) return "rate_limited";
  if (OPAQUE_MODEL_BODY.test(message.trim())) return "request_too_large";
  if (TOO_MANY_IMAGES.test(message)) return "request_too_large";
  if (PROVIDER_ABORTED.test(message)) return "provider_aborted";
  if (CONTEXT_EXCEEDED.test(message)) return "context_exceeded";
  if (AUTH_FAILED.test(message)) return "auth_failed";
  if (NETWORK.test(message)) return "network";
  if (TIMEOUT.test(message)) return "timeout";
  if (OVERLOADED.test(message)) return "provider_overloaded";
  return "unknown";
}

/**
 * Açıklamayı ve sebebi birlikte döner. Motor hata olayına sebebi koyar; metin kullanıcıya,
 * sebep tanıya gider.
 */
export function explainProviderErrorWithReason(
  message: string,
  lang: Locale = "tr",
): { message: string; reason: ProviderErrorReason } {
  return { message: explainProviderError(message, lang), reason: classifyProviderError(message) };
}

/**
 * Bazı ağ geçitleri istek gövdesi sınırını aşınca açıklamasız 400 döner; gövdede yalnızca model
 * adı bulunur (OpenCode Go: `{"model":"qwen3.8-flash"}`). Anthropic SDK gövdede `message` alanı
 * bulamayınca tamamını hata metnine yazar, kullanıcıya da `400 {"model":"…"}` gibi anlamsız bir
 * satır düşer. Sınırı ölçtük: 6.291.456 bayt geçiyor, 6.292.000 bayt bu hatayı veriyor.
 */
const OPAQUE_MODEL_BODY = /^400\s+\{"model"\s*:\s*"[^"]*"\}$/;

/**
 * Görsel sayısı sınırı (DeepSeek: "At most 4 image(s) may be provided in one prompt"). Bilinen
 * sağlayıcılar için istek gönderilmeden kırpılır (`image-budget.ts`); bu, sınırı bilinmeyen bir
 * sağlayıcı aynı biçimde yanıt verdiğinde kullanıcıya ne yapacağını söyleyen yedek açıklamadır.
 */
const TOO_MANY_IMAGES = /at most (\d+) image/i;

/**
 * Sağlayıcı akışı kendi hata bayrağıyla kesti. OpenAI uyumlu uçlar (Kimi K3, OpenCode Go üzerinden)
 * uzun düşünmenin ortasında `finish_reason: "error"` döndürebiliyor; Pi bunu `stopReason: error` +
 * "Provider finish_reason: error" yapar. Pi'nin yeniden deneme deseni yalnızca `network_error`'ı
 * tanır, düz `error` turu bitiriyordu.
 */
const PROVIDER_ABORTED = /provider finish_reason:\s*error\b/i;

/**
 * Pi'nin yeniden denenebilir saymadığı geçici sağlayıcı hataları: yukarıdaki kesme, `unknown`
 * bitiş sebebi, bitiş sebebi gelmeyen akış, ağ geçidinin "upstream request failed" metni. Kota ve hız
 * sınırı buraya girmez; onlar anahtar geçişi yolundadır (`limit.ts`).
 */
const TRANSIENT =
  /provider finish_reason:\s*(error|network_error|unknown)\b|stream ended without finish_reason|upstream request failed/i;

export function isTransientProviderError(message: string | undefined): boolean {
  if (!message || isLimitError(message)) return false;
  return TRANSIENT.test(message);
}

/**
 * Tanınan sağlayıcı hatalarını açıklamayla değiştirir; tanınmayan metin maskelenip döner.
 * Renderer'a ve transkripte giden sağlayıcı hatalarının hepsi buradan geçer: bazı uçlar isteği
 * (URL'deki `?key=AIza…` ya da başlıktaki belirteç dahil) hata gövdesine yansıtıyor.
 */
export function explainProviderError(message: string, lang: Locale = "tr"): string {
  const d = dict(lang);
  if (PROVIDER_ABORTED.test(message)) return d.errors.providerAborted;
  if (OPAQUE_MODEL_BODY.test(message.trim())) return d.errors.requestTooLarge;
  const images = TOO_MANY_IMAGES.exec(message);
  if (images?.[1]) return d.errors.tooManyImages.replace("{{n}}", images[1]);
  return maskSecrets(message);
}
