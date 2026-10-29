import { getJson, QuotaError } from "../http.js";
import { asRecord, num } from "../json.js";
import type { QuotaAdapter } from "./types.js";

/**
 * OpenRouter: anahtar ya da hesap kredi limiti. `limit` null ise anahtarın kredi sınırı yoktur;
 * bu durumda kalan kredi gösterilmez. Günlük ücretsiz model kotası `usage.requests` olarak geçer.
 */
export const openrouterQuota: QuotaAdapter = {
  id: "openrouter",
  async fetch(key, fetchImpl) {
    const raw = asRecord(
      await getJson("https://openrouter.ai/api/v1/key", { token: key, fetchImpl }),
    );
    const data = asRecord(raw?.data);
    if (!data) throw new QuotaError("schema", { detail: "data alanı yok" });

    const remaining = num(data.limit_remaining);
    const cap = num(data.limit);
    const requests = num(asRecord(data.free_model_daily_requests)?.used);
    const spend = num(data.usage_monthly) ?? num(data.usage);
    if (remaining === undefined && spend === undefined) {
      throw new QuotaError("schema", { detail: "kullanım alanları yok" });
    }

    return {
      provider: "openrouter",
      state: "ok",
      windows: [],
      ...(remaining === undefined
        ? {}
        : {
            credit: {
              remaining,
              ...(cap === undefined ? {} : { cap }),
              capEstimated: false,
            },
          }),
      ...(requests === undefined ? {} : { usage: { requests } }),
      fetchedAt: Date.now(),
    };
  },
};
