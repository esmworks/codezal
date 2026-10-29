import type { QuotaWindow } from "@codezal/contracts";
import { getJson, QuotaError } from "../http.js";
import { asArray, asRecord, epochMs, num, text } from "../json.js";
import type { QuotaAdapter } from "./types.js";

/**
 * Z.ai / ZHIPU GLM Coding Plan. Kota ucu ikinci bir istemcide (Claude Code) kullanılan
 * uçla aynı; anahtar `Authorization` başlığına **Bearer eklenmeden** gider.
 *
 * Şema (topluluk eklentilerinden doğrulandı; `opencode-glm-quota` + `glm-usage-monitor`):
 * `{ data: { level, limits: [...] } }` — `level` plan kademesi; `limits` içinde
 * `TOKENS_LIMIT` unit 3/number 5 → 5 saat, unit 6/number 1 → hafta, `TIME_LIMIT` → MCP (takvim ayı).
 * Pencere alanları: `percentage` (0–100, %100'de taşabilir), `total` (token), `nextResetTime` (Unix ms).
 * Kullanıcıda Z.ai anahtarı olmadığı için **canlı doğrulanamadı**; şema kaynak koduna dayanıyor ve
 * bilinmeyen biçimde `state: "error"` döner, 0 göstermez.
 */
const ZAI_BASE = "https://api.z.ai";
const ZHIPU_BASE = "https://open.bigmodel.cn";

const TOKEN_LIMIT = "TOKENS_LIMIT";
const TIME_LIMIT = "TIME_LIMIT";

/**
 * Yüzde: geçersiz/negatif değer "veri yok" sayılır. Uç ondalıklı yüzde veriyor (12.5), bu yüzden
 * yuvarlanmaz; yalnız taşan değer 100'e kırpılır.
 */
function normalizePct(value: unknown): number | undefined {
  const parsed = num(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return Math.min(100, parsed);
}

function isTokenLimit(record: Record<string, unknown>, unit: number, times: number): boolean {
  return (
    text(record.type) === TOKEN_LIMIT && num(record.unit) === unit && num(record.number) === times
  );
}

/** 5 saat / hafta penceresi: yüzde uçtan, kullanılan token yüzdeden türetilir. */
function tokenWindow(id: "fiveHour" | "weekly", raw: unknown): QuotaWindow | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const percent = normalizePct(record.percentage);
  if (percent === undefined) return undefined;
  const cap = num(record.total);
  const used = cap === undefined ? undefined : Math.round((cap * percent) / 100);
  return {
    id,
    percent,
    ...(used === undefined ? {} : { used }),
    ...(cap === undefined ? {} : { cap }),
    resetsAt: epochMs(record.nextResetTime) ?? null,
    exceeded: percent >= 100,
  };
}

/** MCP kotası: takvim ayıdır, uç sıfırlanma damgası vermez. */
function mcpWindow(raw: unknown): QuotaWindow | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const percent = normalizePct(record.percentage);
  if (percent === undefined) return undefined;
  const cap = num(record.usage);
  const used = num(record.currentValue);
  return {
    id: "monthly",
    label: "MCP",
    percent,
    ...(used === undefined ? {} : { used }),
    ...(cap === undefined ? {} : { cap }),
    resetsAt: null,
    exceeded: percent >= 100,
  };
}

function adapter(id: string, baseUrl: string): QuotaAdapter {
  return {
    id,
    async fetch(key, fetchImpl) {
      const raw = asRecord(
        await getJson(`${baseUrl}/api/monitor/usage/quota/limit`, {
          token: key,
          scheme: "raw",
          fetchImpl,
        }),
      );
      const data = asRecord(raw?.data);
      const limits = asArray(data?.limits)
        .map(asRecord)
        .filter((limit): limit is Record<string, unknown> => limit !== undefined);
      if (!data || limits.length === 0) throw new QuotaError("schema", { detail: "limits yok" });

      const tokenLimits = limits.filter((limit) => text(limit.type) === TOKEN_LIMIT);
      // unit/number ayırıcıları değişirse konuma düşülür: bozuk alan yanlış pencereyi göstermesin.
      const fiveHour = limits.find((limit) => isTokenLimit(limit, 3, 5)) ?? tokenLimits[0];
      const weekly = limits.find((limit) => isTokenLimit(limit, 6, 1)) ?? tokenLimits[1];
      const mcp = limits.find((limit) => text(limit.type) === TIME_LIMIT);
      const windows = [
        tokenWindow("fiveHour", fiveHour),
        tokenWindow("weekly", weekly),
        mcpWindow(mcp),
      ].filter((window): window is QuotaWindow => window !== undefined);
      if (windows.length === 0) throw new QuotaError("schema", { detail: "pencere yok" });

      const plan = text(data.level);
      return {
        provider: id,
        state: "ok",
        ...(plan === undefined ? {} : { plan }),
        windows,
        fetchedAt: Date.now(),
      };
    },
  };
}

/** Global platform (api.z.ai). */
export const zaiQuota = adapter("zai", ZAI_BASE);

/** Çin platformu (open.bigmodel.cn); anahtarı o platformdan alanlar için ayrı sağlayıcı kimliği. */
export const zhipuQuota = adapter("zai-coding-cn", ZHIPU_BASE);
