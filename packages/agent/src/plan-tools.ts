import { existsSync, readFileSync } from "node:fs";
import type { PermissionMode, PlanDecision, PlanReview } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const PLAN_ENTER_TOOL = "plan_enter";
export const PLAN_EXIT_TOOL = "plan_exit";

/** Engine oturum durumunu bu köprüyle açar; araçlar Pi oturumunu ve izin yöneticisini bilmez. */
export interface PlanBridge {
  mode(): PermissionMode;
  /** Oturumun plan dosyası; `plansDir` verilmemişse undefined (özellik kapalı). */
  planPath(): string | undefined;
  /** Plan moduna geçer ve önceki modu saklar; zaten plandaysa dokunmaz. */
  enter(): void;
  /** Planı kullanıcıya sunar; onaylanırsa engine önceki moda döner. */
  review(plan: string, path: string): Promise<PlanDecision>;
}

interface PendingReview {
  review: PlanReview;
  resolve: (decision: PlanDecision) => void;
}

let counter = 0;

/**
 * Plan onaylarını bekletir ve cevaplar (izin yöneticisinin plan karşılığı). Onay kartı
 * renderer'da, karar `plans:respond` ile döner; iptal ve kapanışta bekleyenler reddedilir.
 */
export class PlanReviewGate {
  readonly #pending = new Map<string, PendingReview>();
  readonly #onRequest: (review: PlanReview) => void;

  constructor(onRequest: (review: PlanReview) => void) {
    this.#onRequest = onRequest;
  }

  request(
    sessionId: string,
    plan: string,
    path: string,
    returnTo: PermissionMode,
  ): Promise<PlanDecision> {
    const requestId = `plan-${Date.now()}-${++counter}`;
    const review: PlanReview = { requestId, sessionId, plan, path, returnTo };
    return new Promise<PlanDecision>((resolve) => {
      this.#pending.set(requestId, { review, resolve });
      this.#onRequest(review);
    }).finally(() => this.#pending.delete(requestId));
  }

  respond(requestId: string, decision: PlanDecision): boolean {
    const p = this.#pending.get(requestId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }

  /** Oturum iptal edilince ya da kapanınca bekleyen onaylar reddedilir. */
  rejectAll(sessionId: string, feedback?: string): void {
    for (const [id, p] of this.#pending) {
      if (p.review.sessionId !== sessionId) continue;
      p.resolve({ approved: false, ...(feedback ? { feedback } : {}) });
      this.#pending.delete(id);
    }
  }

  pendingFor(sessionId: string): PlanReview | undefined {
    for (const p of this.#pending.values()) if (p.review.sessionId === sessionId) return p.review;
    return undefined;
  }
}

const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);

// Plan metnindeki çözülmemiş soru izleri: "Açık sorular" başlığı, işaretsiz madde, soru işaretli
// satır. Kullanıcı isteği (20 Eyl 2026): plan açık soru taşımaz; model soruyu `question` ile sorar.
const OPEN_HEADING =
  /^#{1,6}\s*(?:açık\s+sorular|sorular|açık\s+noktalar|open\s+questions|questions|open\s+items|tbd|todo)\b/i;
const NONE_LINE = /^(?:yok|yoktur|hiçbiri|none|n\/a|[-—*])[\s.!]*$/i;
const OPEN_MARKER = /^\s*(?:[-*+]|\d+[.)])\s*(?:\[\s*\]|tbd\b|todo\b|\?\?)/i;
const QUESTION_LINE = /^\s*(?:[-*+]|\d+[.)])\s+.*\?[\s*_`]*$/;

/**
 * Planda kalan çözülmemiş soruları toplar. `plan_exit` bunları görürse planı onaya sunmaz:
 * önce `question` ile sorulup yanıtları karar olarak yazılmalıdır.
 */
export function unresolvedQuestions(plan: string): string[] {
  const found: string[] = [];
  let inSection = false;
  for (const line of plan.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inSection = OPEN_HEADING.test(trimmed);
      if (inSection) found.push(trimmed);
      continue;
    }
    if (!trimmed) continue;
    if (inSection) {
      if (!NONE_LINE.test(trimmed)) found.push(trimmed);
      continue;
    }
    if (OPEN_MARKER.test(line) || QUESTION_LINE.test(line)) found.push(trimmed);
  }
  return found;
}

/**
 * Plan moduna giriş/çıkış araçları (Claude Code'un EnterPlanMode / ExitPlanMode deseni). Model
 * belirsiz ya da geniş işte kendi kararıyla plan moduna geçer, planı dosyaya yazar ve `plan_exit`
 * ile onaya sunar; kullanıcı onaylarsa oturum önceki izin moduna döner ve uygulama aynı turda
 * sürer, reddederse geri bildirim modele gider ve plan modu kalır. Kullanıcının çipten elle
 * girdiği plan modundan da `plan_exit` ile çıkılır (dönülecek mod bilinmiyorsa "Sor").
 */
export function planTools(bridge: PlanBridge, lang: Locale = "tr") {
  const d = dict(lang);
  const p = d.prompt;
  // Aynı metin ikinci kez engellenmez: dedektör yanlış pozitif verdiyse model kilitlenmesin.
  const lastBlocked = new Map<string, string>();
  const text = (s: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text: s }],
    details,
  });
  const enter = defineTool({
    name: PLAN_ENTER_TOOL,
    label: d.agent.tool.planEnter,
    description: p.planEnterDesc,
    promptSnippet: p.planEnterSnippet,
    promptGuidelines: [p.planGuideline],
    parameters: Type.Object({}),
    async execute() {
      const path = bridge.planPath();
      if (!path) return text(p.planUnavailable);
      const already = bridge.mode() === "plan";
      if (!already) bridge.enter();
      return text(`${already ? p.planAlready : p.planEntered}\n${fill(p.planFile, { path })}`, {
        path,
      });
    },
  });
  const exit = defineTool({
    name: PLAN_EXIT_TOOL,
    label: d.agent.tool.planExit,
    description: p.planExitDesc,
    promptSnippet: p.planExitSnippet,
    parameters: Type.Object({}),
    async execute() {
      if (bridge.mode() !== "plan") return text(p.planNotInPlan);
      const path = bridge.planPath();
      if (!path) return text(p.planUnavailable);
      const plan = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
      if (!plan) return text(fill(p.planMissing, { path }));
      const open = unresolvedQuestions(plan);
      if (open.length > 0 && lastBlocked.get(path) !== plan) {
        lastBlocked.set(path, plan);
        return text(
          fill(p.planOpenQuestions, {
            items: open
              .slice(0, 6)
              .map((l) => `- ${l}`)
              .join("\n"),
          }),
          { openQuestions: open },
        );
      }
      const decision = await bridge.review(plan, path);
      lastBlocked.delete(path);
      if (decision.approved)
        return text(fill(p.planApproved, { mode: d.permissionMode[bridge.mode()] }), {
          approved: true,
        });
      // İptal: plan uygulanmayacak ve tur durduruldu; model yeni bir yön bekler.
      if (decision.cancelled) return text(p.planCancelled, { approved: false, cancelled: true });
      const feedback = decision.feedback?.trim() || p.planNoFeedback;
      return text(fill(p.planRejected, { feedback }), { approved: false, feedback });
    },
  });
  return [enter, exit] as const;
}
