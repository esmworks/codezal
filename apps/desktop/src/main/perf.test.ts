import { describe, expect, it } from "vitest";
import { PERF_TARGETS, PerfRecorder, percentile, summarizeMetric } from "./perf";

describe("perf", () => {
  it("yüzdelik en yakın sıra yöntemiyle gerçek bir örnek döner", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([42], 95)).toBe(42);
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(10);
    // Girdi dizisi yerinde sıralanmaz.
    expect(values[0]).toBe(5);
  });

  it("özet: hedef katı karşılaştırılır, örnek yoksa karar verilmez", () => {
    expect(summarizeMetric("toolCard", [])).toEqual({
      metric: "toolCard",
      target: 100,
      count: 0,
      p50: null,
      p95: null,
      last: null,
      pass: null,
    });
    const fast = summarizeMetric("toolCard", [20, 30, 40]);
    expect(fast).toMatchObject({ count: 3, p50: 30, p95: 40, last: 40, pass: true });
    // Tam hedefte kalmak geçmez: PRD "100 ms altında" diyor.
    expect(summarizeMetric("toolCard", [100]).pass).toBe(false);
    // Tek yavaş örnek az örnekte p95'i hedefin üstüne çeker.
    expect(summarizeMetric("firstRender", [900, 1000, 2400]).pass).toBe(false);
    expect(PERF_TARGETS.firstRender).toBe(1500);
  });

  it("kaydedici: halka tampon, bozuk süre atlanır, ilk boyama bir kez sayılır", () => {
    const seen: string[] = [];
    const rec = new PerfRecorder(1_000);
    rec.onSample((metric, ms) => seen.push(`${metric}:${ms}`));
    rec.record("toolCard", -5);
    rec.record("toolCard", Number.NaN);
    for (let i = 0; i < 250; i += 1) rec.record("toolCard", i);
    expect(rec.samples("toolCard")).toHaveLength(200);
    expect(rec.samples("toolCard")[0]).toBe(50);

    rec.recordSinceStart("windowReady", 1_800);
    expect(rec.samples("windowReady")).toEqual([800]);
    // Akıl dışı düzeltmeler (sıfır, gelecekte, bir dakikadan eski) yok sayılır.
    rec.setProcessStart(0);
    rec.setProcessStart(5_000);
    expect(rec.processStart).toBe(1_000);
    rec.setProcessStart(500);
    expect(rec.recordFirstRender(2_000)).toBe(true);
    expect(rec.recordFirstRender(90_000)).toBe(false);
    expect(rec.samples("firstRender")).toEqual([1_500]);
    expect(seen).toContain("windowReady:800");
    expect(seen).toContain("firstRender:1500");

    const sum = rec.summary(false);
    expect(sum.packaged).toBe(false);
    expect(sum.metrics.map((m) => m.metric)).toEqual(["windowReady", "firstRender", "toolCard"]);
    expect(sum.metrics[1]).toMatchObject({ count: 1, p95: 1_500, pass: false });
    expect(sum.metrics[0]).toMatchObject({ count: 1, pass: true });
  });
});
