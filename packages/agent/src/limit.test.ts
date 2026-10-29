import { describe, expect, it } from "vitest";
import { isLimitError, isQuotaExhausted, parseRetryDelayMs } from "./limit.js";

describe("isLimitError", () => {
  it("limit ve kota hatalarını tanır", () => {
    for (const msg of [
      "429 Too Many Requests",
      "rate_limit_error: This request would exceed your rate limit",
      "GoUsageLimitError: usage limit reached",
      "Your credit balance is too low",
      "Server requested 3600s retry delay (max: 5s). rate limited",
      "insufficient_quota",
      "Monthly usage limit reached, enable available balance",
    ])
      expect(isLimitError(msg), msg).toBe(true);
  });

  it("sağlayıcı arızasını ve ağ hatalarını limit saymaz", () => {
    for (const msg of [
      "overloaded_error",
      "500 Internal Server Error",
      "fetch failed",
      // Pi'nin bekleme sarmalayıcısı arıza hatalarında da üretilir; sağlam anahtar soğumamalı.
      "Server requested 30s retry delay (max: 5s). Overloaded",
      undefined,
    ])
      expect(isLimitError(msg), String(msg)).toBe(false);
  });
});

describe("parseRetryDelayMs", () => {
  const now = Date.parse("2026-09-06T10:00:00Z");

  it("Pi'nin sunucu gecikme metnini okur", () => {
    expect(parseRetryDelayMs("Server requested 3600s retry delay (max: 5s). x")).toBe(3_600_000);
  });

  it("try again in / OpenAI kısa biçim / retry-after / reset okur", () => {
    expect(parseRetryDelayMs("Please try again in 20s")).toBe(20_000);
    expect(parseRetryDelayMs("try again in 2 minutes")).toBe(120_000);
    expect(parseRetryDelayMs("try again in 1h")).toBe(3_600_000);
    expect(parseRetryDelayMs("Please try again in 1h23m4.5s.")).toBe(
      3_600_000 + 23 * 60_000 + 4_500,
    );
    expect(parseRetryDelayMs("retry-after: 90")).toBe(90_000);
    expect(parseRetryDelayMs("limit resets at 2026-09-06T12:30:00Z", now)).toBe(2.5 * 3_600_000);
  });

  it("aralığa kırpar, bulamazsa undefined döner", () => {
    expect(parseRetryDelayMs("try again in 100ms")).toBe(1_000);
    expect(parseRetryDelayMs("try again in 48 hours")).toBe(24 * 3_600_000);
    expect(parseRetryDelayMs("rate limit exceeded")).toBeUndefined();
    expect(parseRetryDelayMs(undefined)).toBeUndefined();
  });
});

describe("isQuotaExhausted", () => {
  it("kota tükenmesini geçici hız sınırından ayırır", () => {
    expect(
      isQuotaExhausted(
        "OpenAI API error (429): [rate_limit_exceeded] Rate limit exceeded. Please retry after a brief wait.",
      ),
    ).toBe(false);
    expect(isQuotaExhausted("Too many requests")).toBe(false);
    expect(isQuotaExhausted("You exceeded your current quota")).toBe(true);
    expect(isQuotaExhausted("UsageLimitError: 5-hour limit reached")).toBe(true);
    expect(isQuotaExhausted("Your credit balance is too low")).toBe(true);
    expect(isQuotaExhausted(undefined)).toBe(false);
  });

  it("Google'ın dakikalık sınırını kota tükenmesi saymaz", () => {
    const perMinute =
      "[429 Too Many Requests] Quota exceeded for quota metric " +
      '\'Generate Content API requests per minute\' "status": "RESOURCE_EXHAUSTED"';
    expect(isLimitError(perMinute)).toBe(true);
    expect(isQuotaExhausted(perMinute)).toBe(false);
    // Günlük kota gerçekten uzun soğuma ister.
    expect(isQuotaExhausted("Quota exceeded for quota metric 'requests per day'")).toBe(true);
    // Kod tek başına (Google 429 gövdesi) kota kanıtı değil ama limit hatasıdır.
    expect(isLimitError("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaExhausted("RESOURCE_EXHAUSTED")).toBe(false);
  });
});
