import type { AuditBudget, AuditProfile } from "@codezal/contracts";

/**
 * Ajan çağrısı bütçesi. Skill "önce eleştirmen ve doğrulayıcı rezervini ayır" diyor; bizim
 * uygulamamız daha kaba ama dürüst: profil başına sert üst sınır, aşılınca araç reddeder ve
 * run `incomplete` işaretlenir (sessizce seyreltilmez).
 */
export const PROFILE_BUDGET: Record<AuditProfile, number | null> = {
  quick: 25,
  standard: 60,
  deep: 150,
};

export function profileBudget(profile: AuditProfile): number | null {
  return PROFILE_BUDGET[profile];
}

/**
 * Başlangıç bütçesi. `override` modelin verebildiği bir parametredir (`audit_start.budget`), bu
 * yüzden profilin üst sınırını **yükseltemez**: aksi hâlde model `profile: "quick", budget: 100000`
 * diyerek kullanıcının maliyet sınırını kendi eliyle kaldırabiliyordu. Yalnız düşürmeye izin var.
 */
export function initialBudget(profile: AuditProfile, override?: number): AuditBudget {
  const cap = profileBudget(profile);
  if (override === undefined || cap === null) return { agentCalls: override ?? cap, used: 0 };
  return { agentCalls: Math.min(override, cap), used: 0 };
}

export function remaining(budget: AuditBudget): number | null {
  return budget.agentCalls === null ? null : Math.max(0, budget.agentCalls - budget.used);
}

export function canSpend(budget: AuditBudget, n = 1): boolean {
  return budget.agentCalls === null || budget.used + n <= budget.agentCalls;
}

/** Harcamayı uygular; sınır aşılacaksa null döner (çağıran reddeder). */
export function spend(budget: AuditBudget, n = 1): AuditBudget | null {
  if (!canSpend(budget, n)) return null;
  return { ...budget, used: budget.used + n };
}

/** Denetim sırasında harcanan ajan çağrılarını sayan canlı sayaç. */
export class BudgetMeter {
  #budget: AuditBudget;
  readonly #onChange: (budget: AuditBudget) => void;

  constructor(budget: AuditBudget, onChange: (budget: AuditBudget) => void) {
    this.#budget = budget;
    this.#onChange = onChange;
  }

  get value(): AuditBudget {
    return this.#budget;
  }

  get exhausted(): boolean {
    return !canSpend(this.#budget);
  }

  /** Harcamayı dener; sınır doluysa false döner ve durum değişmez. */
  trySpend(n = 1): boolean {
    const next = spend(this.#budget, n);
    if (!next) return false;
    this.#budget = next;
    this.#onChange(next);
    return true;
  }
}
