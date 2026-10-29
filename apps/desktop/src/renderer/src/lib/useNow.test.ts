import { describe, expect, it } from "vitest";
import { msUntilNextTick } from "./useNow";

describe("msUntilNextTick", () => {
  it("aralık sınırındaysa tam aralık bekler", () => {
    expect(msUntilNextTick(0, 60_000)).toBe(60_000);
    expect(msUntilNextTick(120_000, 60_000)).toBe(60_000);
  });

  it("aralığın ortasındaysa kalan süreyi verir", () => {
    expect(msUntilNextTick(30_000, 60_000)).toBe(30_000);
    expect(msUntilNextTick(45_500, 60_000)).toBe(14_500);
  });

  it("sınırın hemen öncesinde kısa süre verir", () => {
    expect(msUntilNextTick(59_001, 60_000)).toBe(999);
  });
});
