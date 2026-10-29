import type { QuotaWindow } from "@codezal/contracts";
import { getJson, QuotaError } from "../http.js";
import { asRecord, clampPercent, epochMs, num, settledValue, text } from "../json.js";
import type { QuotaAdapter } from "./types.js";

const BASE = "https://api.commandcode.ai/alpha";

/**
 * Plan → aylık kredi eşlemesi. Uçta aylık kapasite alanı yok; bu tablo topluluk tarafından
 * cmd CLI'dan çıkarıldı (commandcode-usage README). Bu yüzden kapasite **tahmini** işaretlenir ve
 * yüzde yalnız eşleme biliniyorsa çizilir.
 */
const MONTHLY_CAP: Record<string, number> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

/** 5 saat / hafta penceresi: kredi kullanımı ve kapasite. */
function creditWindow(id: "fiveHour" | "weekly", raw: unknown): QuotaWindow | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const used = num(record.used);
  const cap = num(record.cap);
  const exceeded = record.exceeded === true;
  const resetsAt = epochMs(record.resetAt) ?? null;
  if (used === undefined || cap === undefined || cap <= 0) {
    // Kapasite yoksa yüzde uydurulmaz: pencere yalnız "doldu" bilgisiyle gösterilir.
    return {
      id,
      percent: exceeded ? 100 : 0,
      resetsAt,
      exceeded,
      ...(used === undefined ? {} : { used }),
    };
  }
  return {
    id,
    used,
    cap,
    percent: clampPercent((used / cap) * 100),
    resetsAt,
    exceeded: exceeded || used >= cap,
  };
}

export const commandcodeQuota: QuotaAdapter = {
  id: "commandcode",
  async fetch(key, fetchImpl) {
    const get = (path: string) => getJson(BASE + path, { token: key, fetchImpl });
    // orgId yalnız abonelik sorgusunda gerekiyor; whoami düşerse org'suz devam edilir.
    let orgId: string | undefined;
    try {
      orgId = text(asRecord(asRecord(await get("/whoami"))?.org)?.id);
    } catch {
      orgId = undefined;
    }
    // Kredi zorunlu: bu uç düşerse sağlayıcı için gösterilecek kota yok.
    const creditsRaw = await get("/billing/credits");
    const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [subsResult, summaryResult] = await Promise.allSettled([
      get(`/billing/subscriptions${query}`),
      get("/usage/summary"),
    ]);

    const credits = asRecord(asRecord(creditsRaw)?.credits);
    const limits = asRecord(asRecord(creditsRaw)?.windowLimits);
    const remaining = num(credits?.monthlyCredits);
    if (!credits || !limits || remaining === undefined) {
      throw new QuotaError("schema", { detail: "credits alanları eksik" });
    }

    const subscription = asRecord(asRecord(settledValue(subsResult))?.data);
    const summary = asRecord(settledValue(summaryResult));
    const plan = text(subscription?.planId);
    const cap = plan === undefined ? undefined : MONTHLY_CAP[plan];
    const purchased = num(credits.purchasedCredits);
    const free = num(credits.freeCredits);
    const periodEnd = epochMs(subscription?.currentPeriodEnd);
    const requests = num(summary?.totalCount);
    const tokens = num(summary?.totalTokens);
    const windows = [
      creditWindow("fiveHour", limits.fiveHour),
      creditWindow("weekly", limits.weekly),
    ].filter((w): w is QuotaWindow => w !== undefined);

    return {
      provider: "commandcode",
      state: "ok",
      ...(plan === undefined ? {} : { plan }),
      windows,
      credit: {
        remaining,
        ...(cap === undefined ? {} : { cap }),
        capEstimated: cap !== undefined,
        ...(purchased === undefined ? {} : { purchased }),
        ...(free === undefined ? {} : { free }),
      },
      ...(periodEnd === undefined ? {} : { periodEnd }),
      ...(requests === undefined && tokens === undefined
        ? {}
        : {
            usage: {
              ...(requests === undefined ? {} : { requests }),
              ...(tokens === undefined ? {} : { tokens }),
            },
          }),
      fetchedAt: Date.now(),
    };
  },
};
