import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewFinding } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { parseReviewerOutput, parseValidatorVerdict, ReviewStore } from "./review.js";

describe("parseReviewerOutput", () => {
  it("kod bloğundaki JSON'u çözer, fazladan alanı süzer", () => {
    const text =
      'Bulgular:\n```json\n{"findings":[{"class":"bug","title":"t","description":"d","file":"src/a.ts","line":3,"evidence":"e","extra":1}]}\n```';
    const parsed = parseReviewerOutput(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toEqual([
      { class: "bug", title: "t", description: "d", file: "src/a.ts", line: 3, evidence: "e" },
    ]);
  });

  it("geçersiz satırı düşürür ama adayı korur", () => {
    const text =
      '{"findings":[{"class":"risk","title":"t","description":"d","file":"src/a.ts","line":"x","evidence":"e"}]}';
    const parsed = parseReviewerOutput(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings[0]?.line).toBeUndefined();
  });

  it("geçersiz sınıflı adayı atlar, geçerliyi tutar", () => {
    const text =
      '{"findings":[{"class":"oops","title":"t","description":"d","file":"a.ts","evidence":"e"},{"class":"nit","title":"n","description":"d","file":"a.ts","evidence":"e"}]}';
    const parsed = parseReviewerOutput(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.value.findings[0]?.class).toBe("nit");
  });

  it("bulgu yoksa boş liste, JSON yoksa hata döner", () => {
    expect(parseReviewerOutput('{"findings":[]}')).toEqual({ ok: true, value: { findings: [] } });
    expect(parseReviewerOutput("bulgu yok").ok).toBe(false);
  });
});

describe("parseValidatorVerdict", () => {
  it("kararı çözer, fazladan alanı süzer", () => {
    expect(
      parseValidatorVerdict('{"verdict":"rejected","reason":"kanıt yanlış","extra":1}'),
    ).toEqual({ ok: true, value: { verdict: "rejected", reason: "kanıt yanlış" } });
  });

  it("reason yoksa hata döner (kanıtsız karar kabul edilmez)", () => {
    expect(parseValidatorVerdict('{"verdict":"confirmed"}').ok).toBe(false);
  });
});

describe("ReviewStore", () => {
  const finding: ReviewFinding = {
    id: "f1",
    at: 1,
    class: "bug",
    title: "t",
    description: "d",
    file: "src/a.ts",
    verdict: "confirmed",
    verdictReason: "r",
    evidence: "e",
    outcome: "pending",
  };

  it("koşu ve bulguları ekler, işareti son duruma uygular", () => {
    const dir = mkdtempSync(join(tmpdir(), "codezal-review-"));
    try {
      const store = new ReviewStore(dir);
      store.record("/repo", "s1", {
        at: 1,
        files: ["src/a.ts"],
        counts: { confirmed: 1, rejected: 0, inconclusive: 0 },
        findings: [finding],
      });
      store.mark("/repo", "s1", "f1", "false_positive");
      expect(store.read("/repo", "s1").map((record) => record.kind)).toEqual([
        "run",
        "finding",
        "mark",
      ]);
      const state = store.state("/repo", "s1");
      expect(state).toHaveLength(1);
      expect(state[0]?.outcome).toBe("false_positive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kayıt yoksa boş döner", () => {
    const dir = mkdtempSync(join(tmpdir(), "codezal-review-"));
    try {
      const store = new ReviewStore(dir);
      expect(store.read("/repo", "s1")).toEqual([]);
      expect(store.state("/repo", "s1")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
