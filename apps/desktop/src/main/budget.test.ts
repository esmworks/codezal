import type { UsageEntry } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { type BudgetNotified, budgetAlerts, monthCost } from "./budget.js";

const M = "2026-10";

describe("budgetAlerts", () => {
  it("sınır 0 iken (kapalı) hiçbir şey bildirmez ve kaydı değiştirmez", () => {
    expect(budgetAlerts(500, 0, M, undefined)).toEqual({
      fire: undefined,
      next: undefined,
      changed: false,
    });
  });

  it("%80 altında bildirim yok", () => {
    const r = budgetAlerts(7.9, 10, M, undefined);
    expect(r.fire).toBeUndefined();
    expect(r.next).toEqual({ month: M, limit: 10, thresholds: [] });
  });

  it("%80'i geçince bir kez bildirir, tekrarında sessiz kalır", () => {
    const first = budgetAlerts(8, 10, M, undefined);
    expect(first.fire).toBe(80);
    expect(first.next).toEqual({ month: M, limit: 10, thresholds: [80] });
    const again = budgetAlerts(9, 10, M, first.next);
    expect(again).toEqual({ fire: undefined, next: first.next, changed: false });
  });

  it("kayan nokta yuvarlaması eşiği kaçırmaz (2,4 / 3 tam %80)", () => {
    expect(budgetAlerts(2.4, 3, M, undefined).fire).toBe(80);
  });

  it("%80 bildirildikten sonra %100'de ayrıca bildirir", () => {
    const saved: BudgetNotified = { month: M, limit: 10, thresholds: [80] };
    const r = budgetAlerts(10, 10, M, saved);
    expect(r.fire).toBe(100);
    expect(r.next?.thresholds).toEqual([80, 100]);
    expect(budgetAlerts(15, 10, M, r.next).fire).toBeUndefined();
  });

  it("tek seferde %50'den %120'ye çıkınca yalnız %100 bildirilir, %80 de işaretlenir", () => {
    const r = budgetAlerts(12, 10, M, { month: M, limit: 10, thresholds: [] });
    expect(r.fire).toBe(100);
    expect(r.next?.thresholds).toEqual([80, 100]);
  });

  it("yeni ayda eşikler sıfırlanır", () => {
    const old: BudgetNotified = { month: "2026-09", limit: 10, thresholds: [80, 100] };
    const quiet = budgetAlerts(1, 10, M, old);
    expect(quiet.fire).toBeUndefined();
    expect(quiet.changed).toBe(true);
    expect(quiet.next).toEqual({ month: M, limit: 10, thresholds: [] });
    expect(budgetAlerts(8.5, 10, M, quiet.next).fire).toBe(80);
  });

  it("sınır değişince eşikler yeniden açılır", () => {
    const saved: BudgetNotified = { month: M, limit: 10, thresholds: [80, 100] };
    const r = budgetAlerts(10, 12, M, saved);
    expect(r.fire).toBe(80);
    expect(r.next).toEqual({ month: M, limit: 12, thresholds: [80] });
  });
});

describe("monthCost", () => {
  const entry = (month: string, cost: number): UsageEntry => ({
    provider: "p",
    model: "m",
    month,
    input: 1,
    output: 1,
    requests: 1,
    cost,
  });

  it("yalnız verilen ayın maliyetini toplar", () => {
    const entries = [entry(M, 1.25), entry(M, 0.75), entry("2026-09", 40)];
    expect(monthCost(entries, M)).toBeCloseTo(2);
    expect(monthCost([], M)).toBe(0);
  });
});
