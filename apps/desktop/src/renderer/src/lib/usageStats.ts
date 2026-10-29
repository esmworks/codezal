import type { UsageEntry } from "@codezal/contracts";

/**
 * Kullanım sayfası hesapları: günlük kayıtlardan özet, seri, ısı haritası, eğilim ve model payı.
 * Saf fonksiyonlar; tarih "bugün" parametresiyle verilir ki testler saate bağlı kalmasın.
 * Eski kayıtlar (`day` yok) yalnızca toplam ve ay toplamına girer, günlük görünümlere girmez.
 */

/** YYYY-AA-GG, yerel saat dilimi. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** Son `count` gün, eskiden yeniye; sonuncusu `today`. */
export function lastDays(today: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(addDays(today, -i));
  return out;
}

const tokensOf = (e: UsageEntry) => e.input + e.output;

/** Gün → toplam token; yalnızca günlü kayıtlar. */
export function byDay(entries: readonly UsageEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) if (e.day) out.set(e.day, (out.get(e.day) ?? 0) + tokensOf(e));
  return out;
}

export interface UsageStats {
  total: number;
  month: number;
  requestsMonth: number;
  peak: { day: string; tokens: number } | null;
  /** Bugün (ya da bugün boşsa dün) biten kesintisiz gün sayısı. */
  currentStreak: number;
  longestStreak: number;
}

export function summarize(entries: readonly UsageEntry[], today: string): UsageStats {
  const month = today.slice(0, 7);
  let total = 0;
  let monthTokens = 0;
  let requestsMonth = 0;
  for (const e of entries) {
    total += tokensOf(e);
    if (e.month === month) {
      monthTokens += tokensOf(e);
      requestsMonth += e.requests;
    }
  }
  const days = byDay(entries);
  let peak: UsageStats["peak"] = null;
  for (const [day, tokens] of days)
    if (tokens > 0 && (!peak || tokens > peak.tokens)) peak = { day, tokens };
  const active = new Set([...days].filter(([, t]) => t > 0).map(([d]) => d));
  let longest = 0;
  for (const d of active) {
    // Yalnızca serinin ilk gününden sayılır; O(n·uzunluk) ama gün sayısı küçük.
    if (active.has(addDays(d, -1))) continue;
    let n = 1;
    while (active.has(addDays(d, n))) n += 1;
    longest = Math.max(longest, n);
  }
  let cursor = active.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return {
    total,
    month: monthTokens,
    requestsMonth,
    peak,
    currentStreak: current,
    longestStreak: longest,
  };
}

export interface HeatCell {
  day: string;
  tokens: number;
  /** 0 boş, 1-4 en yoğun güne göre çeyrekler. */
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

export interface Heatmap {
  /** Sütun = hafta (Pazartesi başlar), satır = gün; son sütun bugünü içerir. */
  weeks: HeatCell[][];
  /** Ay başlangıçları: sütun indeksi ve ay (0-11). */
  months: Array<{ col: number; month: number }>;
  max: number;
}

export function heatmap(entries: readonly UsageEntry[], today: string, weeks = 52): Heatmap {
  const days = byDay(entries);
  const end = parseDay(today);
  // Haftanın Pazartesi'sine hizala: son sütun bugünün haftası, toplam `weeks` sütun.
  const dow = (end.getDay() + 6) % 7;
  const startKey = addDays(today, -(dow + (weeks - 1) * 7));
  let max = 0;
  for (const t of days.values()) max = Math.max(max, t);
  const level = (t: number): HeatCell["level"] => {
    if (t <= 0 || max <= 0) return 0;
    const q = t / max;
    return q <= 0.25 ? 1 : q <= 0.5 ? 2 : q <= 0.75 ? 3 : 4;
  };
  const out: HeatCell[][] = [];
  const months: Heatmap["months"] = [];
  for (let w = 0; w < weeks; w += 1) {
    const col: HeatCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(startKey, w * 7 + i);
      const future = day > today;
      const tokens = future ? 0 : (days.get(day) ?? 0);
      col.push({ day, tokens, level: level(tokens), future });
    }
    out.push(col);
    // Ay etiketi: ayın ilk günü bu sütuna düşüyorsa; ilk sütun kendi ayını taşır.
    const start = w === 0 ? col[0] : col.find((c) => !c.future && c.day.endsWith("-01"));
    if (start) months.push({ col: w, month: parseDay(start.day).getMonth() });
  }
  // İlk sütunun etiketi hemen ardından gelen ay başıyla çakışmasın.
  const second = months[1];
  if (second && second.col < 3) months.shift();
  return { weeks: out, months, max };
}

export interface CumulativeCell extends HeatCell {
  /** Bu güne kadar (dahil) birikmiş token; pencere öncesi geçmiş de içinde. */
  cumulative: number;
  /** Birikimin toplama oranı (0-1); hücre tonu bu oranla çizilir. */
  ratio: number;
}

export interface CumulativeHeatmap {
  weeks: CumulativeCell[][];
  months: Heatmap["months"];
  /** Bugüne kadarki toplam (tüm geçmiş); son dolu hücrenin birikimi. */
  total: number;
  /** Pencereden önce birikmiş token (günsüz eski kayıtlar dahil). */
  baseline: number;
  /** Pencere içindeki toplam ve kullanım olan gün sayısı. */
  windowTotal: number;
  activeDays: number;
  /** Günlü ilk kullanım günü; hiç yoksa null. */
  firstDay: string | null;
}

/**
 * Kümülatif ısı haritası: yıl ızgarasıyla aynı düzen, ama hücre tonu o güne kadarki birikimin
 * toplama oranıdır. Düz kalan bölgeler boşta geçen dönemleri, ton sıçramaları yoğun günleri
 * gösterir. Pencere öncesi kullanım (ve günü bilinmeyen eski kayıtlar) başlangıç birikimine
 * girer: son hücre böylece özet şeridindeki "Toplam" ile aynı sayıyı söyler.
 */
export function cumulativeHeatmap(
  entries: readonly UsageEntry[],
  today: string,
  weeks = 52,
): CumulativeHeatmap {
  const grid = heatmap(entries, today, weeks);
  const startKey = grid.weeks[0]?.[0]?.day ?? today;
  let baseline = 0;
  let firstDay: string | null = null;
  for (const e of entries) {
    const tokens = tokensOf(e);
    if (e.day === undefined) {
      baseline += tokens;
      continue;
    }
    if (tokens > 0 && (firstDay === null || e.day < firstDay)) firstDay = e.day;
    if (e.day < startKey) baseline += tokens;
  }
  const cells: CumulativeCell[][] = [];
  let running = baseline;
  let windowTotal = 0;
  let activeDays = 0;
  for (const week of grid.weeks) {
    const col: CumulativeCell[] = [];
    for (const c of week) {
      running += c.tokens;
      windowTotal += c.tokens;
      if (c.tokens > 0) activeDays += 1;
      col.push({ ...c, cumulative: running, ratio: 0, level: 0 });
    }
    cells.push(col);
  }
  const total = running;
  const level = (q: number): HeatCell["level"] =>
    q <= 0 ? 0 : q <= 0.25 ? 1 : q <= 0.5 ? 2 : q <= 0.75 ? 3 : 4;
  for (const col of cells)
    for (const c of col) {
      // Gelecek günler henüz birikmedi: boş çerçeve olarak kalır, tonu yok.
      c.ratio = c.future || total <= 0 ? 0 : c.cumulative / total;
      c.level = level(c.ratio);
    }
  return {
    weeks: cells,
    months: grid.months,
    total,
    baseline,
    windowTotal,
    activeDays,
    firstDay,
  };
}

export interface Series {
  name: string;
  values: number[];
  total: number;
}

export interface Trend {
  days: string[];
  series: Series[];
}

/** Model başına günlük seri; en çok kullanılan `maxSeries` model, kalanı `otherLabel`. */
export function trend(
  entries: readonly UsageEntry[],
  days: string[],
  otherLabel: string,
  maxSeries = 5,
): Trend {
  const index = new Map(days.map((d, i) => [d, i]));
  const perModel = new Map<string, number[]>();
  for (const e of entries) {
    const i = e.day !== undefined ? index.get(e.day) : undefined;
    if (i === undefined) continue;
    const row = perModel.get(e.model) ?? new Array<number>(days.length).fill(0);
    row[i] = (row[i] ?? 0) + tokensOf(e);
    perModel.set(e.model, row);
  }
  const ranked = [...perModel]
    .map(([name, values]) => ({ name, values, total: values.reduce((a, b) => a + b, 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
  if (ranked.length <= maxSeries) return { days, series: ranked };
  const top = ranked.slice(0, maxSeries - 1);
  const rest = ranked.slice(maxSeries - 1);
  const other = new Array<number>(days.length).fill(0);
  for (const s of rest) for (const [i, v] of s.values.entries()) other[i] = (other[i] ?? 0) + v;
  top.push({ name: otherLabel, values: other, total: rest.reduce((a, s) => a + s.total, 0) });
  return { days, series: top };
}

export interface Share {
  name: string;
  tokens: number;
  pct: number;
}

/** Aralıktaki model payları (yüzde, büyükten küçüğe); toplam sıfırsa boş. */
export function share(t: Trend): Share[] {
  const total = t.series.reduce((a, s) => a + s.total, 0);
  if (total <= 0) return [];
  return t.series.map((s) => ({ name: s.name, tokens: s.total, pct: (s.total / total) * 100 }));
}

export interface MonthSlice {
  name: string;
  tokens: number;
  requests: number;
  cost: number;
  pct: number;
}

/**
 * Ay içindeki sağlayıcı/model toplamları pasta dilimi olarak; en büyük `maxSlices - 1` model,
 * kalanı `otherLabel` altında birleşir. Toplam sıfırsa boş.
 */
export function monthSlices(
  entries: readonly UsageEntry[],
  month: string,
  otherLabel: string,
  maxSlices = 6,
): MonthSlice[] {
  const byModel = new Map<string, Omit<MonthSlice, "pct">>();
  for (const e of entries) {
    if (e.month !== month) continue;
    const name = `${e.provider} / ${e.model}`;
    const cur = byModel.get(name) ?? { name, tokens: 0, requests: 0, cost: 0 };
    cur.tokens += tokensOf(e);
    cur.requests += e.requests;
    cur.cost += e.cost;
    byModel.set(name, cur);
  }
  const ranked = [...byModel.values()]
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = ranked.reduce((a, r) => a + r.tokens, 0);
  if (total <= 0) return [];
  const kept = ranked.length <= maxSlices ? ranked : ranked.slice(0, maxSlices - 1);
  if (ranked.length > maxSlices) {
    const rest = ranked.slice(maxSlices - 1);
    kept.push({
      name: otherLabel,
      tokens: rest.reduce((a, r) => a + r.tokens, 0),
      requests: rest.reduce((a, r) => a + r.requests, 0),
      cost: rest.reduce((a, r) => a + r.cost, 0),
    });
  }
  return kept.map((r) => ({ ...r, pct: (r.tokens / total) * 100 }));
}

/** Eksen üst sınırı: 1, 2, 5 × 10^k basamaklarından ilk büyüğü. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/**
 * Monoton kübik (Fritsch–Carlson) → Bézier; noktalar arasında yumuşak çizgi, ancak eğri
 * komşu değerlerin dışına taşmaz (sıfırın altına inmez, tepeleri aşmaz).
 */
export function smoothPath(points: ReadonlyArray<{ x: number; y: number }>): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M${first.x},${first.y}`;
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    dx.push(b.x - a.x);
    slope.push(dx[i] ? (b.y - a.y) / (dx[i] ?? 1) : 0);
  }
  const m: number[] = [slope[0] ?? 0];
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = slope[i - 1] ?? 0;
    const s1 = slope[i] ?? 0;
    // Yön değişiminde teğet sıfır: yerel uçlar aşılmaz.
    m.push(s0 * s1 <= 0 ? 0 : (s0 + s1) / 2);
  }
  m.push(slope[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i += 1) {
    const sl = slope[i] ?? 0;
    if (sl === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / sl;
    const b = (m[i + 1] ?? 0) / sl;
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = ((3 * a) / h) * sl;
      m[i + 1] = ((3 * b) / h) * sl;
    }
  }
  let d = `M${first.x},${first.y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const h = (dx[i] ?? 0) / 3;
    const c1x = a.x + h;
    const c1y = a.y + (m[i] ?? 0) * h;
    const c2x = b.x - h;
    const c2y = b.y - (m[i + 1] ?? 0) * h;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${b.x},${b.y}`;
  }
  return d;
}

/**
 * "12,5" / "12.5" / "" → 12.5 / 0. Negatif, sonsuz ya da sayı olmayan girdi `null` (alan eski
 * değere döner). Türkçe klavyede ondalık ayırıcı virgül olduğu için ikisi de kabul edilir.
 */
export function parseUsdBudget(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
