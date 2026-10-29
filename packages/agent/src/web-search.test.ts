import { describe, expect, it } from "vitest";
import {
  formatResults,
  looksBlocked,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  resolveResultUrl,
  SearchRateLimitError,
  stripTags,
  withRateLimitRetry,
} from "./web-search.js";

const HTML = `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fornek.dev%2Fa%3Fx%3D1&amp;rut=abc">Birinci &amp; başlık</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fornek.dev%2Fa">Özet <b>kalın</b> metin.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://ornek.dev/b">İkinci</a>
    </h2>
  </div>
</div>`;

const LITE = `
<tr><td valign="top">1.&nbsp;</td><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fornek.dev%2Fa&amp;rut=abc" class='result-link'>Birinci</a>
</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>
  Özet <b>metin</b>.
</td></tr>
<tr><td valign="top">2.&nbsp;</td><td>
  <a rel="nofollow" href="https://ornek.dev/b" class='result-link'>İkinci</a>
</td></tr>`;

describe("web-search parser", () => {
  it("html uç noktasındaki sonuçları başlık, adres ve özetle çıkarır", () => {
    expect(parseDuckDuckGoHtml(HTML)).toEqual([
      { title: "Birinci & başlık", url: "https://ornek.dev/a?x=1", snippet: "Özet kalın metin." },
      { title: "İkinci", url: "https://ornek.dev/b", snippet: "" },
    ]);
  });

  it("lite uç noktasındaki sonuçları ve izleyen özetleri eşler", () => {
    expect(parseDuckDuckGoLite(LITE)).toEqual([
      { title: "Birinci", url: "https://ornek.dev/a", snippet: "Özet metin." },
      { title: "İkinci", url: "https://ornek.dev/b", snippet: "" },
    ]);
  });

  it("yönlendirme adresini çözer, düz adresi olduğu gibi bırakır", () => {
    expect(resolveResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc&amp;rut=1")).toBe(
      "https://a.b/c",
    );
    expect(resolveResultUrl("https://a.b/c")).toBe("https://a.b/c");
    expect(resolveResultUrl("//a.b/c")).toBe("https://a.b/c");
  });

  it("etiketleri ve varlıkları temizler", () => {
    expect(stripTags(" a &amp; <b>b</b>&#39;c&#x27; &#246; ")).toBe("a & b'c' ö");
  });

  it("bot doğrulama sayfasını tanır", () => {
    expect(looksBlocked('<script src="/anomaly.js"></script>')).toBe(true);
    expect(looksBlocked(HTML)).toBe(false);
  });

  it("sonuçları numaralı liste olarak biçimler", () => {
    const text = formatResults(parseDuckDuckGoHtml(HTML));
    expect(text).toBe(
      "1. Birinci & başlık\n   https://ornek.dev/a?x=1\n   Özet kalın metin.\n\n2. İkinci\n   https://ornek.dev/b",
    );
  });
});

describe("web-search hız sınırı", () => {
  const blocked = "sınır";
  it("sınıra takılan denemeyi yineler ve sonucu döndürür", async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new SearchRateLimitError("429 Too Many Requests");
        return "sonuç";
      },
      blocked,
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe("sonuç");
    expect(calls).toBe(3);
    // Beklemeler artan sırada: sınır kısa sürüyor, ilk deneme hemen ardından gelmemeli.
    expect(waits).toEqual([1500, 4000]);
  });

  it("denemeler bitince ham durum yerine anlaşılır mesaj verir", async () => {
    await expect(
      withRateLimitRetry(
        async () => {
          throw new SearchRateLimitError("429 Too Many Requests");
        },
        blocked,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(blocked);
  });

  it("sınır dışındaki hatayı yinelemeden yukarı verir", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("ETIMEDOUT");
        },
        blocked,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(1);
  });
});
