import type {
  AuditCondition,
  AuditConfidence,
  AuditEvidenceEntry,
  AuditExecution,
  AuditFinding,
  AuditRemediation,
  AuditSeverityBlock,
  AuditTraceEntry,
} from "@codezal/contracts";
import {
  AuditCondition as ConditionSchema,
  AuditConfidence as ConfidenceSchema,
  AuditEvidenceEntry as EvidenceSchema,
  AuditExecution as ExecutionSchema,
  AuditFinding as FindingSchema,
  hasVisibleProse,
  AuditRemediation as RemediationSchema,
  AuditSeverityBlock as SeveritySchema,
  AuditTraceEntry as TraceSchema,
} from "@codezal/contracts";
import { z } from "zod";

/**
 * Aday boru hattı: avcı `HunterCandidate` üretir → doğrulayıcı `VerifierVerdict` verir →
 * `promoteCandidate` bunları upstream şemasına uygun bir `AuditFinding`e çevirir. Modelin
 * bağlamına yalnızca kimlik ve tek satırlık özetler döner; tam kayıt diskte kalır.
 */

const VisibleText = z
  .string()
  .min(1)
  .refine((v) => hasVisibleProse(v), { message: "görünür içerik yok" });

/** Avcının döndürdüğü kaynak-güdümlü aday; severity taşımaz (o doğrulamanın işi). */
export const HunterCandidate = z.strictObject({
  title: VisibleText,
  description: VisibleText,
  claimed_root_cause: VisibleText,
  intended_behavior: VisibleText.optional(),
  trace: z.array(TraceSchema).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  conditions: z.array(ConditionSchema).default([]),
  confidence: ConfidenceSchema.optional(),
});
export type HunterCandidate = z.infer<typeof HunterCandidate>;

export const HunterOutput = z.strictObject({
  candidates: z.array(HunterCandidate),
});
export type HunterOutput = z.infer<typeof HunterOutput>;

/** Doğrulayıcının verdiği karar; `confirmed` yalnızca görünür bir sonuç gösterilebiliyorsa. */
export const VerifierVerdict = z.strictObject({
  verdict: z.enum(["confirmed", "needs_validation", "rejected"]),
  /** rejected: çürütme gerekçesi; needs_validation: engelin tam tarifi. */
  reason: VisibleText,
  root_cause: VisibleText.optional(),
  intended_behavior: VisibleText.optional(),
  execution: ExecutionSchema.optional(),
  remediation: RemediationSchema.optional(),
  severity: SeveritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  blockers: z.array(VisibleText).optional(),
  validation_plan: z
    .strictObject({ local: VisibleText.optional(), deployment: VisibleText.optional() })
    .optional(),
});
export type VerifierVerdict = z.infer<typeof VerifierVerdict>;

export const CandidateVerification = z.strictObject({
  verdict: z.enum(["confirmed", "needs_validation", "rejected"]),
  verifiedBy: z.string(),
  at: z.number(),
  detail: VerifierVerdict,
});
export type CandidateVerification = z.infer<typeof CandidateVerification>;

/** Diskteki aday kaydı (`candidates.json`): av + doğrulama; kayda terfi etmeden önceki hâl. */
export const AuditCandidate = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/),
  unit: z.string().min(1),
  attackClass: z.string().min(1),
  title: VisibleText,
  description: VisibleText,
  claimed_root_cause: VisibleText,
  intended_behavior: VisibleText.optional(),
  trace: z.array(TraceSchema).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  conditions: z.array(ConditionSchema).default([]),
  confidence: ConfidenceSchema.optional(),
  foundBy: z.string().min(1),
  createdAt: z.number(),
  verification: CandidateVerification.nullable().default(null),
  /** Avcı JSON'u çözümlenemediyse aday kaybolmaz; gerekçe görünür kalır. */
  parseError: z.string().optional(),
});
export type AuditCandidate = z.infer<typeof AuditCandidate>;

export const CandidateFile = z.strictObject({
  version: z.literal(1),
  updatedAt: z.number(),
  items: z.array(AuditCandidate),
});
export type CandidateFile = z.infer<typeof CandidateFile>;

export interface CandidateTrace {
  trace: AuditTraceEntry[];
  evidence: AuditEvidenceEntry[];
  conditions: AuditCondition[];
  confidence?: AuditConfidence;
  intendedBehavior?: string;
}

/**
 * Aday + doğrulama → upstream kaydı. Eksik alan ya da kural ihlali `errors` ile döner;
 * bu, kaydın sessizce bozulmasını engeller (K2/K4).
 */
export function promoteCandidate(
  candidate: AuditCandidate,
): { ok: true; finding: AuditFinding } | { ok: false; errors: string[] } {
  const verification = candidate.verification;
  if (!verification) return { ok: false, errors: [`${candidate.id}: doğrulama yok`] };
  if (candidate.foundBy === verification.verifiedBy && verification.verdict === "confirmed") {
    return {
      ok: false,
      errors: [`${candidate.id}: confirmed kaydı bulan ajan tarafından doğrulanamaz (K4)`],
    };
  }
  const detail = verification.detail;
  const base = {
    fingerprint: candidate.id,
    title: candidate.title,
    description: candidate.description,
  };

  let raw: unknown;
  if (verification.verdict === "confirmed") {
    raw = {
      ...base,
      verdict: "confirmed",
      root_cause: detail.root_cause ?? candidate.claimed_root_cause,
      intended_behavior:
        detail.intended_behavior ??
        candidate.intended_behavior ??
        "Kontrol, saldırıyı engellemeliydi.",
      trace: candidate.trace,
      evidence: candidate.evidence,
      conditions: candidate.conditions,
      execution: detail.execution,
      remediation: detail.remediation,
      severity: detail.severity,
      confidence: detail.confidence ?? candidate.confidence,
    };
  } else if (verification.verdict === "needs_validation") {
    raw = {
      ...base,
      verdict: "needs_validation",
      claimed_root_cause: detail.root_cause ?? candidate.claimed_root_cause,
      trace: candidate.trace,
      evidence: candidate.evidence,
      blockers: detail.blockers ?? [detail.reason],
      validation_plan: detail.validation_plan ?? { local: detail.reason },
    };
  } else {
    raw = {
      ...base,
      verdict: "rejected",
      claimed_root_cause: detail.root_cause ?? candidate.claimed_root_cause,
      trace: candidate.trace,
      evidence: candidate.evidence,
      reason: detail.reason,
    };
  }

  const parsed = FindingSchema.safeParse(raw);
  if (parsed.success) return { ok: true, finding: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "$";
      return `${candidate.id}.${path}: ${issue.message}`;
    }),
  };
}

/** Kayıt durumuna göre `confirmed` dışındakilerde severity bulunmaz. */
export function candidateSeverity(candidate: AuditCandidate): AuditSeverityBlock | null {
  return candidate.verification?.detail.severity ?? null;
}

/** Avcının ham JSON'unu aday listesine çevirir; bozuk çıktı kaybolmaz. */
export function candidateFromHunter(input: {
  id: string;
  unit: string;
  attackClass: string;
  foundBy: string;
  value: HunterCandidate;
  now: number;
}): AuditCandidate {
  return {
    id: input.id,
    unit: input.unit,
    attackClass: input.attackClass,
    title: input.value.title,
    description: input.value.description,
    claimed_root_cause: input.value.claimed_root_cause,
    ...(input.value.intended_behavior ? { intended_behavior: input.value.intended_behavior } : {}),
    trace: input.value.trace,
    evidence: input.value.evidence,
    conditions: input.value.conditions,
    ...(input.value.confidence ? { confidence: input.value.confidence } : {}),
    foundBy: input.foundBy,
    createdAt: input.now,
    verification: null,
  };
}

/** Ayrıştırılamayan avcı turu: gerekçesi görünür bir aday iskeleti. */
export function unparsedCandidate(input: {
  id: string;
  unit: string;
  attackClass: string;
  foundBy: string;
  parseError: string;
  now: number;
  trace: AuditTraceEntry[];
  evidence: AuditEvidenceEntry[];
}): AuditCandidate {
  return {
    id: input.id,
    unit: input.unit,
    attackClass: input.attackClass,
    title: `${input.unit} biriminde yapısal çıktı alınamadı`,
    description: "Avcı alt ajanı beklenen JSON yerine serbest metin döndürdü.",
    claimed_root_cause: input.parseError.slice(0, 500),
    trace: input.trace,
    evidence: input.evidence,
    conditions: [],
    foundBy: input.foundBy,
    createdAt: input.now,
    verification: null,
    parseError: input.parseError,
  };
}

/** Doğrulayıcıdan gelen ham sonucu şemaya sokar. */
export function parseVerifierVerdict(input: unknown): VerifierVerdict | null {
  const parsed = VerifierVerdict.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export type {
  AuditCondition,
  AuditConfidence,
  AuditExecution,
  AuditRemediation,
  AuditSeverityBlock,
};
