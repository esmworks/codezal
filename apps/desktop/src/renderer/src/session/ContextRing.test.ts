import { describe, expect, it } from "vitest";
import { cacheHitRate } from "./ContextRing";

describe("cacheHitRate", () => {
  it("önbellekten okunan girdinin tüm girdiye oranını yüzde olarak verir", () => {
    expect(
      cacheHitRate({ input: 100, output: 50, cacheRead: 800, cacheWrite: 100, cost: 0 }),
    ).toBeCloseTo(80);
  });
  it("girdi yoksa null döner", () => {
    expect(cacheHitRate(null)).toBeNull();
    expect(cacheHitRate({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBeNull();
  });
});
