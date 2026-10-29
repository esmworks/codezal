import type { QuotaWindow } from "@codezal/contracts";
import { getJson, QuotaError } from "../http.js";
import { asRecord, clampPercent, epochMs, num, text } from "../json.js";
import type { QuotaAdapter } from "./types.js";

const BASE = "https://opencode.ai/zen/go/v1";

/**
 * Ucun döndürdüğü üç pencere ve arayüzdeki kimliği; sırası gösterim sırasıdır. Uç kısa pencereye
 * `rolling` der ama belgede süresi 5 saattir (aylık limitin %20'si); "Kayan pencere" etiketi
 * kullanıcıya bir şey anlatmıyordu.
 */
const WINDOWS = [
  ["rolling", "fiveHour"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
] as const;

/**
 * OpenCode Go aboneliği: pencere doluluğu yüzde olarak gelir (used/cap yok). `status` alanı
 * "rate-limited" olduğunda pencere tamamen dolu kabul edilir.
 */
export const opencodeGoQuota: QuotaAdapter = {
  id: "opencode-go",
  async fetch(key, fetchImpl) {
    const raw = asRecord(await getJson(`${BASE}/usage`, { token: key, fetchImpl }));
    const usage = asRecord(raw?.usage);
    if (!usage) throw new QuotaError("schema", { detail: "usage alanı yok" });

    const windows: QuotaWindow[] = [];
    for (const [key, id] of WINDOWS) {
      const record = asRecord(usage[key]);
      if (!record) continue;
      const status = text(record.status);
      const percent = num(record.percent);
      // Ne durum ne yüzde varsa pencere atlanır; eksik alan 0 diye gösterilmez.
      if (status === undefined && percent === undefined) continue;
      const exceeded = status === "rate-limited";
      windows.push({
        id,
        percent: exceeded ? 100 : clampPercent(percent ?? 0),
        resetsAt: epochMs(record.resetsAt) ?? null,
        exceeded,
      });
    }
    if (windows.length === 0) throw new QuotaError("schema", { detail: "pencere bulunamadı" });

    return { provider: "opencode-go", state: "ok", windows, fetchedAt: Date.now() };
  },
};
