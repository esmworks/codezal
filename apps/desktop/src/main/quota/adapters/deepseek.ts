import { getJson, QuotaError } from "../http.js";
import { asArray, asRecord, bool, num, text } from "../json.js";
import type { QuotaAdapter } from "./types.js";

/**
 * DeepSeek kullandıkça öde hesabı: pencere yok, tek bakiye var. Bakiyeler metin olarak gelir
 * ("110.00") ve birden çok para birimi olabilir; USD tercih edilir, yoksa ilk girdi gösterilir.
 */
export const deepseekQuota: QuotaAdapter = {
  id: "deepseek",
  async fetch(key, fetchImpl) {
    const raw = asRecord(
      await getJson("https://api.deepseek.com/user/balance", { token: key, fetchImpl }),
    );
    const infos = asArray(raw?.balance_infos)
      .map(asRecord)
      .filter((info): info is Record<string, unknown> => info !== undefined);
    const preferred = infos.find((info) => text(info.currency) === "USD") ?? infos[0];
    const amount = num(preferred?.total_balance);
    if (!preferred || amount === undefined) {
      throw new QuotaError("schema", { detail: "balance_infos boş" });
    }

    return {
      provider: "deepseek",
      state: "ok",
      windows: [],
      balance: {
        amount,
        currency: text(preferred.currency) ?? "USD",
        usable: bool(raw?.is_available) ?? true,
      },
      fetchedAt: Date.now(),
    };
  },
};
