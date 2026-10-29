import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commandcodeQuota } from "./quota/adapters/commandcode.js";
import { deepseekQuota } from "./quota/adapters/deepseek.js";
import { opencodeGoQuota } from "./quota/adapters/opencode-go.js";
import { openrouterQuota } from "./quota/adapters/openrouter.js";
import { zaiQuota, zhipuQuota } from "./quota/adapters/zai.js";
import { getJson, QuotaError } from "./quota/http.js";
import { quotaSnapshot, refreshQuotas, resetQuotaCache } from "./quota/index.js";

/** Canlı doğrulanmış yanıt gövdeleri (20 Eyl 2026, kullanıcının kendi anahtarlarıyla alındı). */

const COMMANDCODE_CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 65.329319251,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.444671479, cap: 14, exceeded: false, resetAt: 1789927459147 },
    weekly: { used: 4.670680749, cap: 35, exceeded: false, resetAt: 1790328053676 },
  },
};

const COMMANDCODE_SUBS = {
  success: true,
  data: {
    status: "active",
    planId: "individual-goat",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-10-18T08:13:45.000Z",
  },
};

const COMMANDCODE_SUMMARY = {
  totalCount: 3049,
  totalTokens: 423746063,
  totalCredits: 4.668364932,
  successRate: 100,
};

const OPENCODE_GO_USAGE = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2026-09-20T17:06:39.066Z" },
    weekly: { status: "ok", percent: 87, resetsAt: "2026-09-21T00:00:00.000Z" },
    monthly: { status: "ok", percent: 52, resetsAt: "2026-10-08T08:07:00.000Z" },
  },
};

const DEEPSEEK_BALANCE = {
  is_available: false,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "-0.05",
      granted_balance: "0.00",
      topped_up_balance: "-0.05",
    },
  ],
};

const OPENROUTER_KEY = {
  data: {
    label: "codezal",
    limit: null,
    limit_remaining: null,
    usage: 12.5,
    usage_monthly: 3.2,
    is_free_tier: false,
    free_model_daily_requests: { used: 5, limit: 50, remaining: 45 },
  },
};

/** Z.ai şeması topluluk eklentilerinden alındı (kullanıcıda anahtar yok → canlı doğrulanamadı). */
const ZAI_QUOTA = {
  code: 200,
  msg: "success",
  data: {
    level: "pro",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 12.5,
        total: 100_000_000,
        nextResetTime: 1789927459147,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 40,
        total: 700_000_000,
        nextResetTime: 1790328053676,
      },
      { type: "TIME_LIMIT", percentage: 5, currentValue: 3, usage: 100 },
    ],
  },
};

/** URL'e göre yanıt veren fetch taklidi; sayaç çağrı sayısını tutar. */
function stubFetch(routes: Record<string, unknown>, calls?: { count: number }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (calls) calls.count += 1;
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (match === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  resetQuotaCache();
});

describe("getJson", () => {
  it("her istekte User-Agent gönderir (Cloudflare 1010 kapısı)", async () => {
    let headers: Headers | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await getJson("https://example.test/x", { token: "sk-1", fetchImpl });
    expect(headers?.get("user-agent")).toBe("Codezal");
    expect(headers?.get("authorization")).toBe("Bearer sk-1");
  });

  it("Z.ai için ham anahtar başlığı kullanır", async () => {
    let headers: Headers | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await getJson("https://example.test/x", { token: "glm-1", scheme: "raw", fetchImpl });
    expect(headers?.get("authorization")).toBe("glm-1");
  });

  it("401/403'ü unauthenticated, 429'u rate-limited sayar", async () => {
    const unauthorized = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await expect(getJson("https://example.test/x", { fetchImpl: unauthorized })).rejects.toThrow(
      QuotaError,
    );
    await expect(
      getJson("https://example.test/x", { fetchImpl: unauthorized }),
    ).rejects.toMatchObject({ kind: "unauthenticated" });

    const limited = (async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
    await expect(getJson("https://example.test/x", { fetchImpl: limited })).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 120_000,
    });
  });

  it("bozuk gövdeyi schema, ağ hatasını network sayar", async () => {
    const broken = (async () => new Response("sayfa", { status: 200 })) as typeof fetch;
    await expect(getJson("https://example.test/x", { fetchImpl: broken })).rejects.toMatchObject({
      kind: "schema",
    });

    const offline = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(getJson("https://example.test/x", { fetchImpl: offline })).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("commandcode adaptörü", () => {
  const routes = {
    "/whoami": { success: true, user: { userName: "erhanerbas" }, org: null },
    "/billing/credits": COMMANDCODE_CREDITS,
    "/billing/subscriptions": COMMANDCODE_SUBS,
    "/usage/summary": COMMANDCODE_SUMMARY,
  };

  it("krediyi, pencereleri ve planı ayrıştırır", async () => {
    const quota = await commandcodeQuota.fetch("user_1", stubFetch(routes));
    expect(quota.state).toBe("ok");
    expect(quota.plan).toBe("individual-goat");
    expect(quota.credit?.remaining).toBeCloseTo(65.329, 3);
    // Aylık kapasite uçta yok: plan tablosundan gelir ve tahmini işaretlenir.
    expect(quota.credit?.cap).toBe(70);
    expect(quota.credit?.capEstimated).toBe(true);
    expect(quota.windows.map((w) => w.id)).toEqual(["fiveHour", "weekly"]);
    expect(quota.windows[0]?.percent).toBe(3);
    expect(quota.windows[1]?.percent).toBe(13);
    expect(quota.windows[0]?.cap).toBe(14);
    expect(quota.windows[0]?.resetsAt).toBe(1789927459147);
    expect(quota.periodEnd).toBe(Date.parse("2026-10-18T08:13:45.000Z"));
    expect(quota.usage?.requests).toBe(3049);
    expect(quota.usage?.tokens).toBe(423746063);
  });

  it("zorunlu alan yoksa schema hatası verir (0 göstermez)", async () => {
    const quota = { windowLimits: COMMANDCODE_CREDITS.windowLimits };
    await expect(
      commandcodeQuota.fetch("user_1", stubFetch({ ...routes, "/billing/credits": quota })),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("abonelik ucu düşse de kredi gösterilir", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/billing/subscriptions")) return new Response("{}", { status: 500 });
      if (url.includes("/whoami")) return new Response(JSON.stringify(routes["/whoami"]));
      if (url.includes("/billing/credits")) {
        return new Response(JSON.stringify(COMMANDCODE_CREDITS));
      }
      return new Response(JSON.stringify(COMMANDCODE_SUMMARY));
    }) as typeof fetch;
    const quota = await commandcodeQuota.fetch("user_1", fetchImpl);
    expect(quota.state).toBe("ok");
    expect(quota.plan).toBeUndefined();
    expect(quota.credit?.cap).toBeUndefined();
    expect(quota.credit?.remaining).toBeCloseTo(65.329, 3);
  });
});

describe("opencode-go adaptörü", () => {
  it("üç pencereyi yüzde olarak okur", async () => {
    const quota = await opencodeGoQuota.fetch(
      "sk-1",
      stubFetch({ "/zen/go/v1/usage": OPENCODE_GO_USAGE }),
    );
    expect(quota.state).toBe("ok");
    expect(quota.windows.map((w) => w.id)).toEqual(["fiveHour", "weekly", "monthly"]);
    expect(quota.windows[1]?.percent).toBe(87);
    expect(quota.windows[1]?.resetsAt).toBe(Date.parse("2026-09-21T00:00:00.000Z"));
  });

  it("rate-limited penceresini dolu sayar", async () => {
    const usage = {
      usage: {
        rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-09-20T17:06:39.066Z" },
        weekly: { status: "ok", percent: 40, resetsAt: "2026-09-21T00:00:00.000Z" },
      },
    };
    const quota = await opencodeGoQuota.fetch("sk-1", stubFetch({ "/usage": usage }));
    expect(quota.windows[0]?.exceeded).toBe(true);
    expect(quota.windows[0]?.percent).toBe(100);
    expect(quota.windows[1]?.exceeded).toBe(false);
  });

  it("usage alanı yoksa schema hatası verir", async () => {
    await expect(
      opencodeGoQuota.fetch("sk-1", stubFetch({ "/usage": { ok: true } })),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("deepseek adaptörü", () => {
  it("metin sayıları parse eder ve bakiye durumunu taşır", async () => {
    const quota = await deepseekQuota.fetch(
      "sk-ds",
      stubFetch({ "/user/balance": DEEPSEEK_BALANCE }),
    );
    expect(quota.balance?.amount).toBeCloseTo(-0.05, 5);
    expect(quota.balance?.currency).toBe("USD");
    expect(quota.balance?.usable).toBe(false);
    expect(quota.windows).toEqual([]);
  });

  it("bakiye listesi boşsa schema hatası verir", async () => {
    await expect(
      deepseekQuota.fetch("sk-ds", stubFetch({ "/user/balance": { is_available: true } })),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("openrouter adaptörü", () => {
  it("ücretsiz model kotasını okur, limitsiz anahtarda kredi göstermez", async () => {
    const quota = await openrouterQuota.fetch(
      "sk-or",
      stubFetch({ "/api/v1/key": OPENROUTER_KEY }),
    );
    expect(quota.state).toBe("ok");
    expect(quota.credit).toBeUndefined();
    expect(quota.usage?.requests).toBe(5);
  });

  it("kalan krediyi limitiyle birlikte gösterir", async () => {
    const body = {
      data: { limit: 20, limit_remaining: 7.5, usage: 12.5, free_model_daily_requests: {} },
    };
    const quota = await openrouterQuota.fetch("sk-or", stubFetch({ "/api/v1/key": body }));
    expect(quota.credit?.remaining).toBe(7.5);
    expect(quota.credit?.cap).toBe(20);
    expect(quota.credit?.capEstimated).toBe(false);
  });
});

describe("zai adaptörü", () => {
  it("5 saat/hafta/MCP pencerelerini ve plan kademesini okur", async () => {
    const quota = await zaiQuota.fetch("glm-1", stubFetch({ "/quota/limit": ZAI_QUOTA }));
    expect(quota.state).toBe("ok");
    expect(quota.plan).toBe("pro");
    expect(quota.windows.map((w) => w.id)).toEqual(["fiveHour", "weekly", "monthly"]);
    expect(quota.windows[0]?.percent).toBe(12.5);
    expect(quota.windows[0]?.cap).toBe(100_000_000);
    expect(quota.windows[0]?.used).toBe(12_500_000);
    expect(quota.windows[0]?.resetsAt).toBe(1789927459147);
    expect(quota.windows[1]?.percent).toBe(40);
    expect(quota.windows[2]?.label).toBe("MCP");
    expect(quota.windows[2]?.used).toBe(3);
    expect(quota.windows[2]?.cap).toBe(100);
    // MCP takvim ayıdır: uç sıfırlanma damgası vermez.
    expect(quota.windows[2]?.resetsAt).toBeNull();
  });

  it("ayırıcılar tanınmazsa ilk iki token penceresine düşer", async () => {
    const body = {
      data: {
        level: "max",
        limits: [
          { type: "TOKENS_LIMIT", unit: 9, number: 9, percentage: 10, total: 1000 },
          { type: "TOKENS_LIMIT", unit: 9, number: 8, percentage: 20, total: 2000 },
        ],
      },
    };
    const quota = await zaiQuota.fetch("glm-1", stubFetch({ "/quota/limit": body }));
    expect(quota.windows.map((w) => w.percent)).toEqual([10, 20]);
  });

  it("limits yoksa schema hatası verir", async () => {
    await expect(
      zaiQuota.fetch("glm-1", stubFetch({ "/quota/limit": { data: { level: "pro" } } })),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("Çin platformu kendi ucuna gider ve anahtarı ham başlıkta gönderir", async () => {
    let url = "";
    let auth: string | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(ZAI_QUOTA));
    }) as typeof fetch;
    const quota = await zhipuQuota.fetch("glm-cn", fetchImpl);
    expect(url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(auth).toBe("glm-cn");
    expect(quota.provider).toBe("zai-coding-cn");
  });
});

describe("kota önbelleği", () => {
  it("adaptörü olmayan sağlayıcıyı unsupported sayar", async () => {
    const [quota] = await refreshQuotas([{ provider: "xai", apiKey: "xai-1" }]);
    expect(quota?.state).toBe("unsupported");
    expect(quotaSnapshot()).toHaveLength(1);
  });

  it("anahtar yoksa uca çıkmadan unauthenticated döner", async () => {
    const calls = { count: 0 };
    const [quota] = await refreshQuotas([{ provider: "deepseek", apiKey: undefined }]);
    expect(quota?.state).toBe("unauthenticated");
    expect(quota?.message).toBeTruthy();
    expect(calls.count).toBe(0);
  });

  it("60 sn içinde önbellekten döner, force ile yeniden çeker", async () => {
    const calls = { count: 0 };
    const fetchImpl = stubFetch({ "/user/balance": DEEPSEEK_BALANCE }, calls);
    await refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl });
    expect(calls.count).toBe(1);
    await refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl });
    expect(calls.count).toBe(1);
    await refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl, force: true });
    expect(calls.count).toBe(2);
  });

  it("429 sonrası geri çekilir, force olmadan yeniden denemez", async () => {
    const calls = { count: 0 };
    const fetchImpl = (async () => {
      calls.count += 1;
      return new Response("{}", { status: 429 });
    }) as typeof fetch;
    const [first] = await refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl });
    expect(first?.state).toBe("error");
    expect(first?.message).toBeTruthy();
    await refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl });
    expect(calls.count).toBe(1);
  });

  it("eşzamanlı istekleri tek çağrıya birleştirir", async () => {
    const calls = { count: 0 };
    const fetchImpl = stubFetch({ "/user/balance": DEEPSEEK_BALANCE }, calls);
    await Promise.all([
      refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl }),
      refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl }),
    ]);
    expect(calls.count).toBe(1);
  });

  it("force, süren isteği bekleyip yeni istek atar", async () => {
    const calls = { count: 0 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      calls.count += 1;
      await gate;
      return new Response(JSON.stringify(DEEPSEEK_BALANCE));
    }) as typeof fetch;
    const first = refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], { fetchImpl });
    const forced = refreshQuotas([{ provider: "deepseek", apiKey: "sk-ds" }], {
      fetchImpl,
      force: true,
    });
    release?.();
    await Promise.all([first, forced]);
    // Elle yenileme önbellekten dönmemeli.
    expect(calls.count).toBe(2);
  });

  it("bir sağlayıcının hatası diğerlerinin verisini düşürmez", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("/user/balance")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(OPENCODE_GO_USAGE));
    }) as typeof fetch;
    const quotas = await refreshQuotas(
      [
        { provider: "deepseek", apiKey: "sk-ds" },
        { provider: "opencode-go", apiKey: "sk-oc" },
      ],
      { fetchImpl },
    );
    expect(quotas.map((q) => q.state)).toEqual(["error", "ok"]);
  });
});

/** Canlı doğrulama: `CODEZAL_QUOTA_LIVE=1` iken gerçek uçlara gider (anahtarlar keys.json'dan). */
function liveKey(provider: string): string | undefined {
  const dir =
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), "Library", "Application Support", "Codezal", "pi");
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as {
      providers?: Record<string, { slots?: { credential?: { key?: string } }[] }>;
    };
    return parsed.providers?.[provider]?.slots?.[0]?.credential?.key;
  } catch {
    return undefined;
  }
}

describe.runIf(process.env.CODEZAL_QUOTA_LIVE === "1")("canlı kota uçları", () => {
  const cases: [string, typeof commandcodeQuota][] = [
    ["commandcode", commandcodeQuota],
    ["opencode-go", opencodeGoQuota],
    ["deepseek", deepseekQuota],
    ["zai", zaiQuota],
  ];
  for (const [provider, adapter] of cases) {
    const key = liveKey(provider);
    it.runIf(key !== undefined)(
      `${provider}: gerçek uçtan kota okunur`,
      async () => {
        const quota = await adapter.fetch(key ?? "");
        expect(quota.state).toBe("ok");
        expect(quota.windows.length > 0 || quota.balance !== undefined).toBe(true);
      },
      30_000,
    );
  }
});
