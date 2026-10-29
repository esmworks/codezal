import type { ProviderQuota } from "@codezal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { quotaOf } from "../stores/quota";
import { QuotaView } from "./QuotaBox";

/**
 * Statik çizim; store'lar SSR'de başlangıç durumunu okuduğu için kart doğrudan çizilir. Seçili
 * sağlayıcının kaydını bulmak `quotaOf` ile, kutudaki gibi yapılır.
 */
function quota(over: Partial<ProviderQuota> = {}): ProviderQuota {
  return { provider: "commandcode", state: "ok", windows: [], fetchedAt: Date.now(), ...over };
}

let items: ProviderQuota[] = [];
let provider = "commandcode";

function draw(): string {
  return renderToStaticMarkup(
    <QuotaView quota={quotaOf(items, provider)} providerName="Command Code" />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("tr");
});

beforeEach(() => {
  items = [];
  provider = "commandcode";
});

describe("kota kutusu", () => {
  it("seçili modelin sağlayıcısının pencerelerini yüzdeyle çizer", () => {
    items = [
      quota({
        windows: [
          { id: "fiveHour", percent: 0, resetsAt: null, exceeded: false },
          { id: "weekly", percent: 4, resetsAt: null, exceeded: false },
        ],
        credit: { remaining: 55.6, cap: 70, capEstimated: true },
      }),
      quota({ provider: "deepseek", balance: { amount: -0.05, currency: "USD", usable: false } }),
    ];
    const html = draw();
    expect(html).toContain("Kota");
    expect(html).toContain("Command Code");
    expect(html).toContain("5 saat");
    // Türkçede yüzde işareti sayının önünde durur.
    expect(html).toContain("%4");
    // Plan tablosundan türetilen kapasite "~" ile işaretlenir.
    expect(html).toContain("55,6 / ~70,0");
    // Başka sağlayıcının bakiyesi karışmaz.
    expect(html).not.toContain("USD");
  });

  it("kota ucu olmayan sağlayıcıda ve veri gelmeden hiç çizilmez", () => {
    expect(draw()).toBe("");
    items = [quota({ state: "unsupported" })];
    expect(draw()).toBe("");
  });

  it("tükenmiş bakiyeyi ve dolan pencerenin açılış zamanını kırmızı yazar", () => {
    provider = "deepseek";
    items = [
      quota({
        provider: "deepseek",
        windows: [
          { id: "monthly", percent: 100, resetsAt: Date.now() + 3_600_000, exceeded: true },
        ],
        balance: { amount: -0.05, currency: "USD", usable: false },
      }),
    ];
    const html = draw();
    expect(html).toContain("-0,05 USD");
    expect(html).toContain("Doldu");
    expect(html).toContain("sıfırlanır");
  });
});
