import { describe, expect, it } from "vitest";
import {
  maxImagesPerRequest,
  SESSION_IMAGE_BUDGET_BYTES,
  trimImageHistory,
} from "./image-budget.js";

const image = (bytes: number) => ({ type: "image", data: "x".repeat(bytes) });
const text = (t: string) => ({ type: "text", text: t });
const user = (...content: unknown[]) => ({ role: "user", content });
const placeholder = (reason: "bytes" | "count") => `[yok:${reason}]`;

describe("trimImageHistory", () => {
  it("bütçe yetiyorsa hiçbir şeye dokunmaz", () => {
    const messages = [user(text("bak"), image(100)), user(image(100))];
    expect(trimImageHistory(messages, { bytes: 1000 }, placeholder)).toBe(0);
    expect(messages[0]?.content[1]).toEqual(image(100));
  });

  it("bütçe dolunca en eski görselden başlayarak yer tutucuya çevirir", () => {
    const messages = [user(image(100)), user(image(100)), user(text("son"), image(100))];
    expect(trimImageHistory(messages, { bytes: 200 }, placeholder)).toBe(1);
    expect(messages[0]?.content[0]).toEqual(text("[yok:bytes]"));
    expect(messages[1]?.content[0]).toEqual(image(100));
    // Son turun görseli kullanıcının sorduğu şeydir; en son o düşer.
    expect(messages[2]?.content[1]).toEqual(image(100));
  });

  it("gereken kadarını düşürür, fazlasını değil", () => {
    const messages = [user(image(100)), user(image(100)), user(image(100))];
    expect(trimImageHistory(messages, { bytes: 150 }, placeholder)).toBe(2);
    expect(messages[2]?.content[0]).toEqual(image(100));
  });

  it("negatif bütçede tüm görselleri düşürür ve metni korur", () => {
    const messages = [user(text("merhaba"), image(50))];
    expect(trimImageHistory(messages, { bytes: -10 }, placeholder)).toBe(1);
    expect(messages[0]?.content).toEqual([text("merhaba"), text("[yok:bytes]")]);
  });

  it("dizi olmayan içeriği ve görsel dışı blokları atlar", () => {
    const messages = [
      { role: "user", content: "düz metin" },
      { role: "toolResult", content: [text("çıktı")] },
      user(image(100)),
    ];
    expect(trimImageHistory(messages, { bytes: 0 }, placeholder)).toBe(1);
    expect(messages[1]?.content).toEqual([text("çıktı")]);
  });

  it("sayı sınırını aşan en eski görselleri düşürür, sebebi sayı olarak bildirir", () => {
    const messages = [
      user(image(10)),
      { role: "toolResult", content: [text("PDF"), image(10), image(10)] },
      user(text("bak"), image(10), image(10)),
    ];
    expect(trimImageHistory(messages, { bytes: 1000, count: 4 }, placeholder)).toBe(1);
    expect(messages[0]?.content[0]).toEqual(text("[yok:count]"));
    expect(messages[1]?.content[1]).toEqual(image(10));
    expect(messages[2]?.content[2]).toEqual(image(10));
  });

  it("sayı sınırı tam doluyken dokunmaz", () => {
    const messages = [user(image(10), image(10)), user(image(10), image(10))];
    expect(trimImageHistory(messages, { bytes: 1000, count: 4 }, placeholder)).toBe(0);
  });

  it("iki sınır birden aşıldığında sayı sebebi öne çıkar, sonra bayt sürer", () => {
    const messages = [user(image(100)), user(image(100)), user(image(100)), user(image(100))];
    // Sayı: 4 > 3 → bir görsel "count" ile düşer; bayt: 300 > 150 → iki görsel daha "bytes" ile.
    expect(trimImageHistory(messages, { bytes: 150, count: 3 }, placeholder)).toBe(3);
    expect(messages[0]?.content[0]).toEqual(text("[yok:count]"));
    expect(messages[1]?.content[0]).toEqual(text("[yok:bytes]"));
    expect(messages[2]?.content[0]).toEqual(text("[yok:bytes]"));
    expect(messages[3]?.content[0]).toEqual(image(100));
  });

  it("bütçe ölçülen 6 MiB ağ geçidi sınırının altında kalır", () => {
    expect(SESSION_IMAGE_BUDGET_BYTES).toBeLessThan(6 * 1024 * 1024);
  });
});

describe("maxImagesPerRequest", () => {
  it("DeepSeek için 4 döner; sağlayıcı, adres ya da model kimliğinden tanır", () => {
    expect(
      maxImagesPerRequest({
        provider: "deepseek",
        id: "deepseek-v4-flash-vision-exp",
        baseUrl: "https://api.deepseek.com",
      }),
    ).toBe(4);
    expect(maxImagesPerRequest({ provider: "openrouter", id: "deepseek/deepseek-v4" })).toBe(4);
    expect(maxImagesPerRequest({ provider: "custom", baseUrl: "https://api.deepseek.com" })).toBe(
      4,
    );
  });

  it("bilinmeyen sağlayıcıda sınır yoktur", () => {
    expect(maxImagesPerRequest({ provider: "anthropic", id: "claude-opus-5" })).toBeUndefined();
    expect(maxImagesPerRequest(undefined)).toBeUndefined();
  });
});
