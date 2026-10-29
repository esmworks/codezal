import type { ProviderQuota } from "@codezal/contracts";
import { i18n } from "../i18n.js";
import { ADAPTERS } from "./adapters/index.js";
import type { QuotaAdapter } from "./adapters/types.js";
import { QuotaError } from "./http.js";

/** Önbellek ömrü: kota uçları ücretsiz ama aynı veriyi tekrar tekrar çekmenin anlamı yok. */
const TTL_MS = 60_000;
/** 429 sonrası bekleme; uç `Retry-After` verirse o süre (en fazla bu sınır) kullanılır. */
const BACKOFF_MS = 5 * 60_000;

const cache = new Map<string, ProviderQuota>();
const backoffUntil = new Map<string, number>();
const inflight = new Map<string, Promise<ProviderQuota>>();

export interface QuotaTarget {
  provider: string;
  /** Aktif yuvanın çözülmüş anahtarı; yoksa sağlayıcı bağlı değil demektir. */
  apiKey: string | undefined;
}

export interface RefreshOptions {
  /** Önbellek ömrünü ve 429 geri çekilmesini yok sayar (kullanıcı "Yenile" dedi). */
  force?: boolean;
  fetchImpl?: typeof fetch;
}

/** Elde olan kota verisi; ağa çıkmaz. */
export function quotaSnapshot(): ProviderQuota[] {
  return [...cache.values()];
}

/** Test ve oturum sıfırlama için önbelleği boşaltır. */
export function resetQuotaCache(): void {
  cache.clear();
  backoffUntil.clear();
  inflight.clear();
}

/** Verilen sağlayıcıların kotasını (gerekirse ağdan) tazeler. */
export async function refreshQuotas(
  targets: QuotaTarget[],
  options: RefreshOptions = {},
): Promise<ProviderQuota[]> {
  // Tek sağlayıcının beklenmedik hatası tüm tazelemeyi düşürmesin: diğer rozetler verisini korur.
  const results = await Promise.allSettled(targets.map((target) => quotaOf(target, options)));
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : mapError(targets[index]?.provider ?? "", result.reason),
  );
}

/** Aynı sağlayıcı için eşzamanlı çağrılar tek isteğe birleşir. */
async function quotaOf(target: QuotaTarget, options: RefreshOptions): Promise<ProviderQuota> {
  const pending = inflight.get(target.provider);
  if (pending) {
    if (!options.force) return pending;
    // Elle tazeleme önbellekten dönmemeli: süren isteği bekleyip sonra zorla yeniden çekilir.
    await pending;
  }
  const promise = load(target, options).finally(() => inflight.delete(target.provider));
  inflight.set(target.provider, promise);
  return promise;
}

async function load(target: QuotaTarget, options: RefreshOptions): Promise<ProviderQuota> {
  const now = Date.now();
  const cached = cache.get(target.provider);
  if (!options.force && cached && now - cached.fetchedAt < TTL_MS) return cached;

  const adapter = ADAPTERS.get(target.provider);
  let quota: ProviderQuota;
  if (!adapter) quota = unsupportedQuota(target.provider);
  else if (target.apiKey === undefined) {
    quota = errorQuota(
      target.provider,
      "unauthenticated",
      i18n.t("settings.quota.stateUnauthenticated"),
    );
  } else if (!options.force && (backoffUntil.get(target.provider) ?? 0) > now) {
    // 429 yediğimiz sağlayıcıyı hemen yeniden denemek durumu kötüleştirir.
    quota = errorQuota(target.provider, "error", i18n.t("settings.quota.stateRateLimited"));
  } else {
    quota = await fetchWithAdapter(adapter, target.provider, target.apiKey, options);
  }
  cache.set(target.provider, quota);
  return quota;
}

async function fetchWithAdapter(
  adapter: QuotaAdapter,
  provider: string,
  key: string,
  options: RefreshOptions,
): Promise<ProviderQuota> {
  try {
    const quota = await adapter.fetch(key, options.fetchImpl);
    backoffUntil.delete(provider);
    return quota;
  } catch (error) {
    if (error instanceof QuotaError && error.kind === "rate-limited") {
      const suggested = error.retryAfterMs;
      const wait = suggested && suggested > 0 ? Math.min(suggested, BACKOFF_MS) : BACKOFF_MS;
      backoffUntil.set(provider, Date.now() + wait);
    }
    return mapError(provider, error);
  }
}

function unsupportedQuota(provider: string): ProviderQuota {
  return { provider, state: "unsupported", windows: [], fetchedAt: Date.now() };
}

function errorQuota(
  provider: string,
  state: "unauthenticated" | "error",
  message: string,
): ProviderQuota {
  return { provider, state, windows: [], message, fetchedAt: Date.now() };
}

function mapError(provider: string, error: unknown): ProviderQuota {
  if (error instanceof QuotaError) {
    if (error.kind === "unauthenticated") {
      return errorQuota(provider, "unauthenticated", i18n.t("settings.quota.stateUnauthenticated"));
    }
    if (error.kind === "rate-limited") {
      return errorQuota(provider, "error", i18n.t("settings.quota.stateRateLimited"));
    }
    if (error.kind === "schema") {
      return errorQuota(provider, "error", i18n.t("settings.quota.stateSchema"));
    }
    if (error.kind === "http") {
      return errorQuota(
        provider,
        "error",
        i18n.t("settings.quota.stateHttp", { status: error.status ?? 0 }),
      );
    }
  }
  return errorQuota(provider, "error", i18n.t("settings.quota.stateNetwork"));
}
