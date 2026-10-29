/**
 * Sağlayıcı hata metninden "limit doldu" tespiti ve sunucunun bildirdiği bekleme süresi.
 * Pi'nin yeniden deneme desenleriyle bilerek örtüşmez: overloaded/5xx/ağ hataları sağlayıcı arızasıdır,
 * sağlam anahtarı soğutmamalıdır.
 *
 * Pi, sunucunun istediği bekleme üst sınırı aşınca hatayı
 * `Server requested Ns retry delay (max: Ms). <sağlayıcı mesajı>` diye sarar. Bu sarmalayıcı her
 * yeniden denenebilir hatada (overloaded, 5xx) üretildiği için karar sarmalayıcıya değil sondaki
 * özgün sağlayıcı mesajına bakar.
 */

/**
 * Saniyelik/dakikalık hız sınırı: sunucu süre bildirmediyse kısa sürede geçer.
 * `resource.?exhausted` burada durur: Google 429'un gövde kodudur ve dakikalık sınırda da,
 * günlük kotada da aynı şekilde gelir, tek başına kota tükenmesine kanıt değildir.
 */
const RATE_PARTS = ["rate.?limit", "too many requests", "\\b429\\b", "resource.?exhausted"];

/** Kota tükenmesi: plan penceresi, bakiye ya da bütçe bitmiş; anahtar uzun süre kullanılamaz. */
const QUOTA_PARTS = [
  "quota",
  "usage.?limit",
  "UsageLimitError",
  "credit balance",
  "available balance",
  "insufficient_quota",
  "billing",
  "out of budget",
];

/**
 * Kısa pencere adı geçen sınır kotayla aynı kelimeleri kullansa da geçicidir. Google dakikalık
 * sınırı "Quota exceeded for quota metric '... per minute'" diye bildirir; bu ifade olmadan
 * "quota" görüldüğü için anahtar saatlerce dolu sanılıyordu.
 */
const SHORT_WINDOW_PATTERN = /per[-\s]?(?:second|minute)\b|\bper\s+min\b|\b[rt]pm\b/i;

const LIMIT_PATTERN = new RegExp([...RATE_PARTS, ...QUOTA_PARTS].join("|"), "i");
const QUOTA_PATTERN = new RegExp(QUOTA_PARTS.join("|"), "i");

export function isLimitError(message: string | undefined): boolean {
  return typeof message === "string" && LIMIT_PATTERN.test(message);
}

/**
 * Kota gerçekten tükendi mi. Yalnızca hız sınırı diyen hata (429, "rate limit exceeded") kısa
 * sürede geçer; anahtarı saatlerce soğutmak tek anahtarlı kurulumda onu boş yere kullanılmaz
 * gösterir. Sunucu bir bekleme süresi bildiriyorsa zaten o süre kullanılır, bu ayrım devreye girmez.
 */
export function isQuotaExhausted(message: string | undefined): boolean {
  if (typeof message !== "string") return false;
  if (SHORT_WINDOW_PATTERN.test(message)) return false;
  return QUOTA_PATTERN.test(message);
}

/** Süre bildirmeyen hız sınırı için soğuma; bir sonraki başarılı istekte zaten silinir. */
export const SHORT_LIMIT_COOLDOWN_MS = 60_000;

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 24 * 3_600_000;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
};

function clamp(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

/** OpenAI biçimi: "1h23m4.5s", "6m0s", "20s". */
function parseCompact(text: string): number | undefined {
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)/i.exec(text);
  if (!m || (!m[1] && !m[2])) return undefined;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3_600_000 + min * 60_000 + s * 1_000;
}

/**
 * Hata metninde bildirilen bekleme süresi (ms), [1 sn, 24 sa] aralığına kırpılır; yoksa undefined.
 * Pi, sunucunun 60 sn üstü isteğini "Server requested Ns retry delay" olarak metne yazar.
 */
export function parseRetryDelayMs(
  message: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!message) return undefined;
  const requested = /Server requested (\d+)s retry delay/i.exec(message);
  if (requested) return clamp(Number(requested[1]) * 1_000);

  const tryAgain =
    /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|second|m|min|minute|h|hour)s?\b/i.exec(message);
  if (tryAgain) {
    const unit = (tryAgain[2] ?? "s").toLowerCase();
    return clamp(Number(tryAgain[1]) * (UNIT_MS[unit] ?? 1_000));
  }

  const compact = parseCompact(message);
  if (compact !== undefined) return clamp(compact);

  const retryAfter = /retry[- ]after[:=\s]+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/i.exec(message);
  if (retryAfter) return clamp(Number(retryAfter[1]) * 1_000);

  const reset = /resets?\s+(?:at|in)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
    message,
  );
  if (reset?.[1]) return clamp(Date.parse(reset[1]) - now);

  return undefined;
}
