import { describe, expect, it } from "vitest";
import { maskSecrets } from "./mask.js";

describe("maskSecrets", () => {
  const cases: Array<[string, string]> = [
    ["OpenAI/Anthropic", "sk-ant-api03-abcdefghijklmnop"],
    ["Bearer başlığı", "Bearer abc.def-ghi_jkl"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"],
    ["Google API anahtarı", `AIza${"B".repeat(35)}`],
    ["Google OAuth belirteci", "ya29.a0AfH6SMBx-yz_12345"],
    ["GitHub klasik", `ghp_${"a1".repeat(18)}`],
    ["GitHub OAuth", `gho_${"Z9".repeat(18)}`],
    ["GitHub uygulama", `ghs_${"k".repeat(36)}`],
    ["GitHub ince ayarlı", `github_pat_${"A1_".repeat(20)}`],
    ["Groq", `gsk_${"q".repeat(40)}`],
    ["xAI", `xai-${"x".repeat(40)}`],
    ["AWS erişim anahtarı", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS geçici anahtar", "ASIAIOSFODNN7EXAMPLE"],
  ];
  for (const [name, secret] of cases) {
    it(`${name} maskelenir`, () => {
      const out = maskSecrets(`400 istek reddedildi: key=${secret} geçersiz`);
      expect(out).not.toContain(secret);
      expect(out).toContain("•••");
      expect(out).toContain("geçersiz");
    });
  }

  it("URL sorgusundaki Google anahtarı maskelenir, adresin kalanı okunur kalır", () => {
    const key = `AIza${"x".repeat(35)}`;
    const out = maskSecrets(`GET https://generativelanguage.googleapis.com/v1/models?key=${key}`);
    expect(out).toBe("GET https://generativelanguage.googleapis.com/v1/models?key=•••");
  });

  it("sıradan metne ve kısa öneklere dokunmaz", () => {
    const plain = "commit 3fa9c1d · ghp_kisa · AKIA123 · gsk_ · xai-grok-4 modeli";
    expect(maskSecrets(plain)).toBe(plain);
  });
});
