import type { UsageEntry } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  addDays,
  cumulativeHeatmap,
  heatmap,
  lastDays,
  monthSlices,
  niceMax,
  parseUsdBudget,
  share,
  smoothPath,
  summarize,
  trend,
} from "./usageStats";

function e(day: string | undefined, model: string, tokens: number, requests = 1): UsageEntry {
  return {
    provider: "p",
    model,
    month: (day ?? "2026-08-01").slice(0, 7),
    ...(day ? { day } : {}),
    input: tokens,
    output: 0,
    requests,
    cost: 0,
  };
}

const TODAY = "2026-09-11";

describe("usageStats", () => {
  it("gün aritmetiği yerel takvimde ay ve yıl sınırını geçer", () => {
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(lastDays("2026-09-03", 3)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("özet: toplam, ay, en yoğun gün ve seriler; günsüz eski kayıt yalnızca toplamlara girer", () => {
    const rows = [
      e(undefined, "eski", 1000), // Ağustos, gün yok
      e("2026-09-08", "a", 10),
      e("2026-09-09", "a", 50),
      e("2026-09-10", "b", 20),
      e("2026-09-11", "a", 5, 3),
      e("2026-09-01", "a", 70),
      e("2026-09-02", "a", 1),
    ];
    const s = summarize(rows, TODAY);
    expect(s.total).toBe(1156);
    expect(s.month).toBe(156);
    expect(s.requestsMonth).toBe(8);
    expect(s.peak).toEqual({ day: "2026-09-01", tokens: 70 });
    expect(s.currentStreak).toBe(4);
    expect(s.longestStreak).toBe(4);
    // Bugün boşsa seri dünden sayılır, kopmuş sayılmaz.
    expect(
      summarize(
        rows.filter((r) => r.day !== TODAY),
        TODAY,
      ).currentStreak,
    ).toBe(3);
    expect(summarize([], TODAY)).toMatchObject({ total: 0, peak: null, currentStreak: 0 });
  });

  it("ısı haritası: son sütun bugünü içerir, gelecek günler işaretli, seviyeler en yoğuna göre", () => {
    const h = heatmap([e("2026-09-11", "a", 100), e("2026-09-10", "a", 20)], TODAY, 4);
    expect(h.weeks).toHaveLength(4);
    const last = h.weeks[3] ?? [];
    // 2026-09-11 Cuma: Pazartesi 07'de başlar, Cuma 5. hücre.
    expect(last[0]?.day).toBe("2026-09-07");
    expect(last[4]).toMatchObject({ day: TODAY, level: 4, future: false });
    expect(last[3]).toMatchObject({ day: "2026-09-10", level: 1 });
    expect(last[5]).toMatchObject({ future: true, tokens: 0 });
    expect(h.max).toBe(100);
    // 4 haftada Ağustos etiketi Eylül'e çok yakın düşer ve atılır; 6 haftada ikisi de kalır.
    expect(h.months).toEqual([{ col: 2, month: 8 }]);
    expect(heatmap([], TODAY, 6).months).toEqual([
      { col: 0, month: 7 },
      { col: 4, month: 8 },
    ]);
  });

  it("kümülatif ısı haritası: pencere öncesi geçmiş başlangıca girer, birikim azalmaz", () => {
    const rows = [
      e(undefined, "eski", 40), // günsüz eski kayıt: başlangıç birikimi
      e("2026-01-05", "a", 60), // 4 haftalık pencerenin (17 Ağustos'tan) öncesi
      e("2026-08-20", "a", 100),
      e("2026-09-10", "b", 200),
      e("2026-09-11", "a", 600),
    ];
    const h = cumulativeHeatmap(rows, TODAY, 4);
    expect(h.weeks).toHaveLength(4);
    expect(h.weeks[0]?.[0]?.day).toBe("2026-08-17");
    expect(h.baseline).toBe(100);
    expect(h.windowTotal).toBe(900);
    expect(h.activeDays).toBe(3);
    expect(h.firstDay).toBe("2026-01-05");
    // Son dolu hücre özet şeridindeki toplamla aynı sayıyı söyler.
    expect(h.total).toBe(summarize(rows, TODAY).total);
    const cells = h.weeks.flat();
    expect(cells[0]).toMatchObject({ cumulative: 100, ratio: 0.1, level: 1 });
    for (let i = 1; i < cells.length; i += 1)
      expect(cells[i]?.cumulative ?? 0).toBeGreaterThanOrEqual(cells[i - 1]?.cumulative ?? 0);
    const last = h.weeks[3] ?? [];
    expect(last[3]).toMatchObject({ day: "2026-09-10", tokens: 200, cumulative: 400, level: 2 });
    expect(last[4]).toMatchObject({ day: TODAY, cumulative: 1000, ratio: 1, level: 4 });
    // Gelecek günler birikimi taşır ama tonsuz kalır.
    expect(last[5]).toMatchObject({ future: true, cumulative: 1000, ratio: 0, level: 0 });
    expect(h.months).toEqual(heatmap(rows, TODAY, 4).months);
  });

  it("kümülatif ısı haritası: ilk kullanımdan önce boş, hiç kullanım yoksa hepsi sıfır", () => {
    const h = cumulativeHeatmap([e("2026-09-09", "a", 50)], TODAY, 2);
    const cells = h.weeks.flat();
    expect(cells.filter((c) => c.day < "2026-09-09").every((c) => c.level === 0)).toBe(true);
    expect(cells.find((c) => c.day === "2026-09-09")).toMatchObject({ level: 4, ratio: 1 });
    const empty = cumulativeHeatmap([], TODAY, 2);
    expect(empty).toMatchObject({ total: 0, baseline: 0, activeDays: 0, firstDay: null });
    expect(empty.weeks.flat().every((c) => c.level === 0 && c.ratio === 0)).toBe(true);
  });

  it("eğilim: model başına günlük seri, fazlası 'Diğer'e toplanır; pay yüzdeleri", () => {
    const days = lastDays(TODAY, 3);
    const rows = [
      e("2026-09-09", "a", 10),
      e("2026-09-11", "a", 30),
      e("2026-09-11", "b", 20),
      e("2026-09-10", "c", 5),
      e("2026-09-10", "d", 5),
      e("2026-09-01", "a", 999), // aralık dışı
    ];
    const t = trend(rows, days, "Diğer", 3);
    expect(t.series.map((s) => s.name)).toEqual(["a", "b", "Diğer"]);
    expect(t.series[0]?.values).toEqual([10, 0, 30]);
    expect(t.series[2]).toMatchObject({ values: [0, 10, 0], total: 10 });
    expect(share(t).map((s) => [s.name, Math.round(s.pct)])).toEqual([
      ["a", 57],
      ["b", 29],
      ["Diğer", 14],
    ]);
    expect(trend([], days, "Diğer").series).toEqual([]);
  });

  it("ay dilimleri: model başına birleşir, küçükler Diğer olur", () => {
    const rows: UsageEntry[] = [
      e("2026-09-10", "a", 40),
      e("2026-09-11", "a", 20),
      e("2026-09-11", "b", 20),
      e("2026-09-11", "c", 10),
      e("2026-09-11", "d", 10),
      e("2026-08-30", "a", 999), // başka ay
    ];
    const s = monthSlices(rows, "2026-09", "Diğer", 3);
    expect(s.map((x) => [x.name, x.tokens, x.requests, x.pct])).toEqual([
      ["p / a", 60, 2, 60],
      ["p / b", 20, 1, 20],
      ["Diğer", 20, 2, 20],
    ]);
    expect(monthSlices(rows, "2026-09", "Diğer").map((x) => x.name)).toHaveLength(4);
    expect(monthSlices(rows, "2026-07", "Diğer")).toEqual([]);
  });

  it("eksen üst sınırı ve yumuşak yol", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1_300_000)).toBe(2_000_000);
    expect(niceMax(50)).toBe(50);
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 1, y: 2 }])).toBe("M1,2");
    const d = smoothPath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    expect(d.startsWith("M0,0 C")).toBe(true);
    expect(d.endsWith("20,0")).toBe(true);
    // Tepe noktasında teğet sıfır: kontrol noktaları 10'u aşmaz (eğri taşmaz).
    const ys = d.match(/,(-?[\d.]+)/g)?.map((m) => Number(m.slice(1))) ?? [];
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });
});

describe("parseUsdBudget", () => {
  it("nokta ve virgül ondalığını kabul eder, boşu 0 sayar", () => {
    expect(parseUsdBudget("12,5")).toBe(12.5);
    expect(parseUsdBudget(" 20.25 ")).toBe(20.25);
    expect(parseUsdBudget("")).toBe(0);
    expect(parseUsdBudget("0")).toBe(0);
  });

  it("negatif ya da sayı olmayan girdiyi reddeder", () => {
    expect(parseUsdBudget("-5")).toBeNull();
    expect(parseUsdBudget("abc")).toBeNull();
    expect(parseUsdBudget("Infinity")).toBeNull();
  });

  it("kuruşa yuvarlar", () => {
    expect(parseUsdBudget("1.239")).toBe(1.24);
  });
});
