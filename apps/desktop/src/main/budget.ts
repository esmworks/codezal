import type { UsageEntry } from "@codezal/contracts";

/** Para bütçesi uyarı eşikleri (yüzde). Her biri ayda bir kez bildirilir. */
export const BUDGET_THRESHOLDS = [80, 100] as const;

/** Bu ay hangi eşiklerin bildirildiği; usage.json'da saklanır ki her açılışta yinelenmesin. */
export interface BudgetNotified {
  month: string;
  /** Bildirim anındaki sınır; kullanıcı sınırı değiştirirse eşikler yeniden açılır. */
  limit: number;
  thresholds: number[];
}

/** Ayın (YYYY-AA) toplam maliyeti (USD). */
export function monthCost(entries: readonly UsageEntry[], month: string): number {
  return entries.reduce((sum, e) => (e.month === month ? sum + e.cost : sum), 0);
}

/**
 * Bu ayın maliyetine göre gösterilecek uyarıyı seçer. Aynı anda birden çok eşik aşıldıysa (ör. %50
 * → %120) yalnız en yükseği bildirilir, alttakiler de "bildirildi" sayılır: art arda iki bildirim
 * gürültü olurdu. Ay ya da sınır değişince kayıt sıfırlanır. Sınır 0 ise özellik kapalıdır.
 * `changed` false ise kayıt yazılmaz (her kullanım olayında diske gidilmesin).
 */
export function budgetAlerts(
  cost: number,
  limit: number,
  month: string,
  saved: BudgetNotified | undefined,
): { fire: number | undefined; next: BudgetNotified | undefined; changed: boolean } {
  if (!(limit > 0)) return { fire: undefined, next: saved, changed: false };
  const fresh = saved !== undefined && saved.month === month && saved.limit === limit;
  const done = fresh ? saved.thresholds : [];
  // Bölmeden karşılaştırılır: 2.4 / 3 * 100 kayan noktada 79.999… çıkar ve %80 kaçardı.
  const crossed = BUDGET_THRESHOLDS.filter((t) => cost * 100 >= t * limit);
  const pending = crossed.filter((t) => !done.includes(t));
  if (pending.length === 0) {
    // Eşik yok ama kayıt eski aya ya da eski sınıra aitse sıfırlanmış hâli yazılır.
    if (fresh) return { fire: undefined, next: saved, changed: false };
    return { fire: undefined, next: { month, limit, thresholds: [] }, changed: true };
  }
  return {
    fire: Math.max(...pending),
    next: { month, limit, thresholds: [...new Set([...done, ...crossed])].sort((a, b) => a - b) },
    changed: true,
  };
}
