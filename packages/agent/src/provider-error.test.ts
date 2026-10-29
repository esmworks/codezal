import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  explainProviderError,
  explainProviderErrorWithReason,
  isTransientProviderError,
} from "./provider-error.js";

describe("isTransientProviderError", () => {
  it("Kimi'nin finish_reason: error kesmesini ve benzer üst akış hatalarını geçici sayar", () => {
    expect(isTransientProviderError("Provider finish_reason: error")).toBe(true);
    expect(isTransientProviderError("Provider finish_reason: network_error")).toBe(true);
    expect(isTransientProviderError("Stream ended without finish_reason")).toBe(true);
    expect(
      isTransientProviderError("Error from provider (Console Go): Upstream request failed: boom"),
    ).toBe(true);
  });

  it("kota, hız sınırı, içerik filtresi ve bilinmeyen metin geçici değildir", () => {
    expect(isTransientProviderError("OpenAI API error (429): rate_limit_exceeded")).toBe(false);
    expect(isTransientProviderError("Provider finish_reason: content_filter")).toBe(false);
    expect(isTransientProviderError("Provider finish_reason: length")).toBe(false);
    expect(isTransientProviderError("bir şey oldu")).toBe(false);
    expect(isTransientProviderError(undefined)).toBe(false);
  });
});

describe("explainProviderError", () => {
  it("sağlayıcı kesmesini yeniden deneme ve model değiştirme öğüdüyle açıklar", () => {
    expect(explainProviderError("Provider finish_reason: error")).toMatch(/yarıda kesti/);
    expect(explainProviderError("Provider finish_reason: error", "en")).toMatch(/cut the response/);
  });

  it("gövdesiz 400'ü açıklamaya çevirir", () => {
    expect(explainProviderError('400 {"model":"qwen3.8-flash"}')).toMatch(/gövde sınırını aştı/);
    expect(explainProviderError('400 {"model": "minimax-m3"}')).toMatch(/gövde sınırını aştı/);
    expect(explainProviderError('400 {"model":"kimi-k3"}', "en")).toMatch(/body limit/);
  });

  it("görsel sayısı sınırını sayıyla açıklar", () => {
    const raw =
      "Streaming response failed: [400] At most 4 image(s) may be provided in one prompt. (parameter=image)";
    expect(explainProviderError(raw)).toMatch(/en fazla 4 görsel/);
    expect(explainProviderError(raw, "en")).toMatch(/at most 4 images/);
  });

  it("açıklaması olan hatalara dokunmaz", () => {
    const real = '400 {"type":"error","error":{"message":"max_tokens too large"}}';
    expect(explainProviderError(real)).toBe(real);
    expect(explainProviderError("429 rate limit exceeded")).toBe("429 rate limit exceeded");
    expect(explainProviderError("")).toBe("");
  });

  it("hata gövdesine yansıyan anahtarı renderer'a çıkmadan maskeler", () => {
    const key = `AIza${"k".repeat(35)}`;
    const raw = `400 API key not valid: https://generativelanguage.googleapis.com/v1?key=${key}`;
    expect(explainProviderError(raw)).not.toContain(key);
    const { message, reason } = explainProviderErrorWithReason(
      `401 bad token ghp_${"a".repeat(36)}`,
    );
    expect(message).not.toContain("ghp_a");
    // Sebep ham metinden çıkarılır; maskeleme sınıflandırmayı bozmaz.
    expect(reason).toBe("auth_failed");
  });
});

describe("hata sebebi sınıflandırma", () => {
  /**
   * Sabit sebep kodları tanının temeli: serbest metin sayılamaz, kod sayılabilir. Sıra da
   * önemli — kota desenleri `429`u kapsadığı için önce daha özgül olanlar denenir.
   */
  it("kota ve hız sınırını ayırır", () => {
    expect(classifyProviderError("You exceeded your current quota, billing details")).toBe(
      "quota_exhausted",
    );
    expect(classifyProviderError("429 Too Many Requests")).toBe("rate_limited");
    // Google dakikalık sınırı "quota" sözcüğünü taşır ama geçicidir.
    expect(classifyProviderError("Quota exceeded for quota metric 'per minute'")).toBe(
      "rate_limited",
    );
  });

  it("kimlik, bağlam ve gövde sınırını ayırır", () => {
    expect(classifyProviderError("401 Unauthorized: invalid api key")).toBe("auth_failed");
    expect(classifyProviderError("This model's maximum context length is 200000 tokens")).toBe(
      "context_exceeded",
    );
    expect(classifyProviderError('400 {"model":"qwen3.8-flash"}')).toBe("request_too_large");
    expect(classifyProviderError("At most 4 image(s) may be provided in one prompt")).toBe(
      "request_too_large",
    );
  });

  it("sağlayıcı kesmesi, ağ ve zaman aşımını ayırır", () => {
    expect(classifyProviderError("Provider finish_reason: error")).toBe("provider_aborted");
    expect(classifyProviderError("read ECONNRESET")).toBe("network");
    expect(classifyProviderError("Request timed out after 60000ms")).toBe("timeout");
    expect(classifyProviderError("503 Service Unavailable")).toBe("provider_overloaded");
  });

  it("tanınmayan metinde `unknown` döner; metin ve sebep birlikte gelir", () => {
    expect(classifyProviderError("beklenmedik bir şey oldu")).toBe("unknown");
    expect(classifyProviderError(undefined)).toBe("unknown");
    const both = explainProviderErrorWithReason("429 Too Many Requests", "tr");
    expect(both.reason).toBe("rate_limited");
    expect(both.message.length).toBeGreaterThan(0);
  });
});

describe("sıkıştırma no-op sebepleri", () => {
  /**
   * Pi, sıkıştırılacak eski içerik bulamadığında `compact()`ı **hata** olarak fırlatır. Bu bir
   * arıza değil; kullanıcı `/compact` dediğinde "başarısız" demek yanlış olurdu. Motor bu iki
   * mesajı ayrı sebebe çevirir (bkz. `compactNoopReason`).
   */
  it("Pi'nin no-op mesajlarını tanır, başka hatayı tanımaz", async () => {
    const { compactNoopReason } = await import("./engine.js");
    expect(compactNoopReason("Nothing to compact (session too small)")).toBe("nothing-to-compact");
    expect(compactNoopReason("Already compacted")).toBe("already-compacted");
    expect(compactNoopReason("429 Too Many Requests")).toBeUndefined();
    expect(compactNoopReason("")).toBeUndefined();
  });
});
