import { describe, expect, it } from "vitest";
import { extractJson, parseHunterOutput, parseVerifierVerdict } from "./parse.js";

const CANDIDATE = {
  title: "Kapsam denetimi eksik",
  description: "Yol kök dışına çıkabiliyor.",
  claimed_root_cause: "Kök karşılaştırması yok.",
  trace: [
    {
      kind: "entrypoint",
      file: "src/a.ts",
      line: 3,
      scope: "read",
      description: "Girdi buradan gelir.",
    },
    { kind: "sink", file: "src/a.ts", line: 9, scope: "open", description: "Dosya açılır." },
  ],
  evidence: [{ file: "src/a.ts", line: 9, description: "Denetim yok." }],
};

describe("alt ajan çıktısı ayrıştırma", () => {
  it("kod bloğundaki JSON'u ve çevresindeki metni tolere eder", () => {
    const text = `İşte sonuç:\n\`\`\`json\n${JSON.stringify({ candidates: [CANDIDATE] })}\n\`\`\`\nUmarım yardımcı olur.`;
    const parsed = parseHunterOutput(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.candidates).toHaveLength(1);
  });

  it("üst düzey aday dizisini kabul eder", () => {
    const parsed = parseHunterOutput(JSON.stringify([CANDIDATE]));
    expect(parsed.ok).toBe(true);
  });

  it("fazladan alanları süzer, şemayı bozmaz", () => {
    const text = JSON.stringify({
      candidates: [{ ...CANDIDATE, severity: "critical", unit: "u-1", extra: true }],
    });
    const parsed = parseHunterOutput(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.candidates[0]).not.toHaveProperty("severity");
      expect(parsed.value.candidates[0]).not.toHaveProperty("unit");
    }
  });

  it("geçersiz adayı gerekçesiyle reddeder", () => {
    const text = JSON.stringify({ candidates: [{ ...CANDIDATE, evidence: [] }] });
    const parsed = parseHunterOutput(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("JSON yoksa hata döner", () => {
    expect(parseHunterOutput("Aday bulamadım.").ok).toBe(false);
  });

  it("doğrulayıcı kararını okur ve fazlalıkları süzer", () => {
    const parsed = parseVerifierVerdict(
      JSON.stringify({
        verdict: "needs_validation",
        reason: "Dağıtım ayarı depoda yok.",
        blocker: "x",
        blockers: ["Dağıtım ayarı depoda yok."],
        validation_plan: { deployment: "Yayın ortamında doğrula." },
        severity: { overall_severity: "high", likelihood: {}, impact: {} },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.verdict).toBe("needs_validation");
      expect(parsed.value.severity).toBeUndefined();
    }
  });

  it("confirmed kararında severity'yi korur", () => {
    const parsed = parseVerifierVerdict(
      JSON.stringify({
        verdict: "confirmed",
        reason: "Kaynakta görünür.",
        root_cause: "Denetim yok.",
        intended_behavior: "Kök içinde kalmalı.",
        execution: {
          attacker_perspective: "Renderer",
          payloads: ["../../etc/passwd"],
          instructions: ["oku"],
          observed_result: "Kaynak izi denetimsiz.",
        },
        remediation: { strategy: "Kök denetimi ekle." },
        severity: {
          likelihood: { score: "high", reason: "Tek çağrı." },
          impact: { score: "medium", reason: "Dosya okuma." },
          overall_severity: "medium",
        },
        confidence: { score: "high", reason: "İz tam." },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.severity?.overall_severity).toBe("medium");
  });

  it("extractJson dengeli nesneyi bulur", () => {
    expect(extractJson('{"a":1} kuyruk')).toEqual({ a: 1 });
    expect(extractJson("yok")).toBeNull();
  });
});
