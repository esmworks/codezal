import type { ProviderQuota } from "@codezal/contracts";

/**
 * Kota adaptörü: sağlayıcının anahtarını alır, uçlarından normalize edilmiş kotayı döner.
 * Başarısızlıkta `QuotaError` fırlatır; `quota/index.ts` bunu `ProviderQuota.state`'e çevirir.
 */
export interface QuotaAdapter {
  /** Sağlayıcı kimliği (Pi kataloğundaki `provider.id`). */
  id: string;
  fetch(key: string, fetchImpl?: typeof fetch): Promise<ProviderQuota>;
}
