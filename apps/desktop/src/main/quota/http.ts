/**
 * Kota uçlarının ortak HTTP katmanı.
 *
 * Kota uçları Cloudflare arkasında ve tarayıcı dışı istemcileri imzaya göre reddediyor: User-Agent
 * göndermeyen istek `403 error code: 1010` alır (20 Eyl 2026'da canlı doğrulandı; python-urllib ve
 * undici varsayılanı engellendi, herhangi bir UA geçti). Bu yüzden UA her istekte açıkça gönderilir
 * ve bu davranış testle korunur.
 */

const USER_AGENT = "Codezal";

export type QuotaErrorKind = "unauthenticated" | "rate-limited" | "http" | "network" | "schema";

export class QuotaError extends Error {
  readonly kind: QuotaErrorKind;
  readonly status: number | undefined;
  /** 429 yanıtındaki `Retry-After` (ms); yoksa undefined. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: QuotaErrorKind,
    options: {
      status?: number | undefined;
      retryAfterMs?: number | undefined;
      detail?: string;
    } = {},
  ) {
    super(options.detail ?? kind);
    this.name = "QuotaError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface GetJsonOptions {
  token?: string;
  /** Z.ai ham anahtar bekler; diğer uçlar `Bearer` kullanır. */
  scheme?: "bearer" | "raw";
  timeoutMs?: number;
  /** Testler ve çağrı sahipleri kendi fetch'ini geçebilir. */
  fetchImpl?: typeof fetch | undefined;
}

/** JSON yanıtı `unknown` döner: alanların şeklini adaptör doğrular, eksik alan 0 sayılmaz. */
export async function getJson(url: string, options: GetJsonOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (options.token) {
    headers.Authorization = options.scheme === "raw" ? options.token : `Bearer ${options.token}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new QuotaError("unauthenticated", { status: response.status });
    }
    if (response.status === 429) {
      throw new QuotaError("rate-limited", { status: 429, retryAfterMs: retryAfterOf(response) });
    }
    if (!response.ok) throw new QuotaError("http", { status: response.status });
    return await response.json();
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    // Bozuk gövde (JSON değil) ile ağ hatası ayrı raporlanır: ikisi farklı kullanıcı mesajı üretir.
    if (error instanceof SyntaxError) throw new QuotaError("schema", { detail: "geçersiz JSON" });
    if (error instanceof Error && error.name === "AbortError") {
      throw new QuotaError("network", { detail: "zaman aşımı" });
    }
    throw new QuotaError("network", {
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}
