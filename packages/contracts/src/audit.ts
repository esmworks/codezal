import { z } from "zod";

/**
 * Güvenlik denetimi (security audit) sözleşmesi. Alan adları Cloudflare
 * `security-audit-skill` şemasıyla birebir hizalıdır: `findings.json` dosyası upstream
 * `validate-findings.cjs` ile doğrulanabilir kalmalı. Uygulamaya özgü alanlar (run durumu,
 * görünüm, provenance) bu dosyada ayrı tiplerde tutulur; kayıt şemasına eklenmez
 * (`additionalProperties: false`).
 */

export const AUDIT_PROFILES = ["quick", "standard", "deep"] as const;
export const AuditProfile = z.enum(AUDIT_PROFILES);
export type AuditProfile = z.infer<typeof AuditProfile>;

/** Skill'in altı fazı; `incomplete` terminal durumu ayrı `status` alanındadır. */
export const AUDIT_PHASES = [
  "recon",
  "hunting",
  "validation",
  "recording",
  "verification",
  "reporting",
] as const;
export const AuditPhase = z.enum(AUDIT_PHASES);
export type AuditPhase = z.infer<typeof AuditPhase>;

export const AUDIT_STATUSES = ["in_progress", "complete", "incomplete"] as const;
export const AuditStatus = z.enum(AUDIT_STATUSES);
export type AuditStatus = z.infer<typeof AuditStatus>;

export const AUDIT_UNIT_STATUSES = [
  "planned",
  "candidate",
  "covered",
  "deferred",
  "out_of_scope",
  "rejected",
] as const;
export const AuditUnitStatus = z.enum(AUDIT_UNIT_STATUSES);
export type AuditUnitStatus = z.infer<typeof AuditUnitStatus>;

export const AUDIT_SEVERITIES = ["informational", "low", "medium", "high", "critical"] as const;
export const AuditSeverity = z.enum(AUDIT_SEVERITIES);
export type AuditSeverity = z.infer<typeof AuditSeverity>;

/** Severity sıralaması: `overall_severity`, gösterilen `impact`'i aşamaz. */
export const SEVERITY_RANK: Record<AuditSeverity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Upstream `fingerprint` deseni: kayıt durumlar arasında değişmeyen kaynak-güdümlü kimlik. */
export const AUDIT_FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * Kaynak yolu güvenliği: upstream `isSafeRelativeSourcePath` kuralının aynısı; depo-göreli,
 * ters bölü ve iki nokta yok, `~`/mutlak yol yok, Windows ayrılmış adları yok.
 */
const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const PATH_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export function isSafeRelativeSourcePath(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (PATH_FORBIDDEN_CHARACTER.test(value)) return false;
  if (value.includes("\\") || value.includes(":")) return false;
  if (value.startsWith("/") || value.startsWith("~")) return false;
  return value
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[ .]$/u.test(segment) &&
        !WINDOWS_RESERVED_COMPONENT.test(segment),
    );
}

/** `visibleContent`: en az bir görünür karakter; saf boşluk/kontrol karakteri yetmez. */
const VISIBLE_CONTENT = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

export function hasVisibleProse(value: string): boolean {
  return VISIBLE_CONTENT.test(value);
}

const SafeSourcePath = z
  .string()
  .min(1)
  .refine((v) => isSafeRelativeSourcePath(v), { message: "güvenli depo-göreli yol değil" });

const VisibleText = z
  .string()
  .min(1)
  .refine((v) => hasVisibleProse(v), { message: "görünür içerik yok" });

const Fingerprint = z.string().min(1).regex(AUDIT_FINGERPRINT_PATTERN);

export const AuditTraceEntry = z.strictObject({
  kind: z.enum(["entrypoint", "propagation", "sink"]),
  file: SafeSourcePath,
  line: z.number().int().min(1),
  scope: VisibleText,
  description: VisibleText,
});
export type AuditTraceEntry = z.infer<typeof AuditTraceEntry>;

export const AuditEvidenceEntry = z.strictObject({
  file: SafeSourcePath,
  line: z.number().int().min(1),
  description: VisibleText,
});
export type AuditEvidenceEntry = z.infer<typeof AuditEvidenceEntry>;

export const AUDIT_CONDITION_KINDS = [
  "authentication_level",
  "authorization_role",
  "user_interaction",
  "system_configuration",
  "network_routing",
  "environmental_dependency",
  "data_state",
  "timing_dependency",
  "third_party_dependency",
] as const;
export const AuditCondition = z.strictObject({
  kind: z.enum(AUDIT_CONDITION_KINDS),
  description: VisibleText,
});
export type AuditCondition = z.infer<typeof AuditCondition>;

const SeverityScore = z.strictObject({ score: AuditSeverity, reason: VisibleText });

export const AuditSeverityBlock = z
  .strictObject({
    likelihood: SeverityScore,
    impact: SeverityScore,
    overall_severity: AuditSeverity,
  })
  .refine((s) => SEVERITY_RANK[s.overall_severity] <= SEVERITY_RANK[s.impact.score], {
    message: "overall_severity gösterilen impact'i aşamaz",
  });
export type AuditSeverityBlock = z.infer<typeof AuditSeverityBlock>;

export const AuditConfidence = z.strictObject({
  score: z.enum(["low", "medium", "high"]),
  reason: VisibleText,
});
export type AuditConfidence = z.infer<typeof AuditConfidence>;

export const AuditExecution = z.strictObject({
  attacker_perspective: VisibleText,
  payloads: z.array(z.string().min(1)).min(1),
  instructions: z.array(VisibleText).min(1),
  observed_result: VisibleText,
});
export type AuditExecution = z.infer<typeof AuditExecution>;

export const AuditCodeChange = z.strictObject({
  file_name: SafeSourcePath,
  fixed_code: z.string(),
});
export type AuditCodeChange = z.infer<typeof AuditCodeChange>;

export const AuditRemediation = z.strictObject({
  strategy: VisibleText,
  code_changes: z.array(AuditCodeChange).optional(),
});
export type AuditRemediation = z.infer<typeof AuditRemediation>;

const Trace = z
  .array(AuditTraceEntry)
  .min(1)
  .superRefine((trace, ctx) => {
    // Upstream kuralı: tek satırlık iz entrypoint ya da sink'tir; çok satırlıda ilk entrypoint,
    // son sink, aradakiler propagation olmalı.
    const first = trace[0]?.kind;
    const last = trace[trace.length - 1]?.kind;
    if (trace.length === 1) {
      if (first !== "entrypoint" && first !== "sink")
        ctx.addIssue({ code: "custom", message: "tek satırlık iz entrypoint ya da sink olmalı" });
      return;
    }
    if (first !== "entrypoint")
      ctx.addIssue({ code: "custom", message: "iz entrypoint ile başlamalı" });
    if (last !== "sink") ctx.addIssue({ code: "custom", message: "iz sink ile bitmeli" });
    for (let i = 1; i < trace.length - 1; i++) {
      if (trace[i]?.kind !== "propagation")
        ctx.addIssue({ code: "custom", message: `iz[${i}] propagation olmalı` });
    }
  });

/** Kapsam dışı bırakılan (ör. ilgisiz) bulgu değil; doğrulanmış zafiyet kaydı. */
export const AuditConfirmedFinding = z.strictObject({
  verdict: z.literal("confirmed"),
  fingerprint: Fingerprint,
  title: VisibleText,
  description: VisibleText,
  root_cause: VisibleText,
  intended_behavior: VisibleText,
  trace: Trace,
  evidence: z.array(AuditEvidenceEntry).min(1),
  conditions: z.array(AuditCondition),
  execution: AuditExecution,
  remediation: AuditRemediation,
  severity: AuditSeverityBlock,
  confidence: AuditConfidence,
});
export type AuditConfirmedFinding = z.infer<typeof AuditConfirmedFinding>;

/** Kaynak-güdümlü aday; kesin doğrulama engelli. Severity taşımaz. */
export const AuditNeedsValidationFinding = z.strictObject({
  verdict: z.literal("needs_validation"),
  fingerprint: Fingerprint,
  title: VisibleText,
  description: VisibleText,
  claimed_root_cause: VisibleText,
  trace: Trace,
  evidence: z.array(AuditEvidenceEntry).min(1),
  blockers: z.array(VisibleText).min(1),
  validation_plan: z
    .strictObject({ local: VisibleText.optional(), deployment: VisibleText.optional() })
    .refine((p) => p.local !== undefined || p.deployment !== undefined, {
      message: "en az bir doğrulama planı gerekir",
    }),
});
export type AuditNeedsValidationFinding = z.infer<typeof AuditNeedsValidationFinding>;

/** Doğrulamada çürütülen aday. */
export const AuditRejectedFinding = z.strictObject({
  verdict: z.literal("rejected"),
  fingerprint: Fingerprint,
  title: VisibleText,
  description: VisibleText,
  claimed_root_cause: VisibleText,
  trace: Trace,
  evidence: z.array(AuditEvidenceEntry).min(1),
  reason: VisibleText,
});
export type AuditRejectedFinding = z.infer<typeof AuditRejectedFinding>;

export const AuditFinding = z.discriminatedUnion("verdict", [
  AuditConfirmedFinding,
  AuditNeedsValidationFinding,
  AuditRejectedFinding,
]);
export type AuditFinding = z.infer<typeof AuditFinding>;

/** `findings.json` kök belgesi: kayıtlar fingerprint'e göre artan sırada ve tekil. */
export const AuditFindingsDocument = z.array(AuditFinding).superRefine((findings, ctx) => {
  const seen = new Set<string>();
  let previous: string | null = null;
  findings.forEach((finding, index) => {
    if (seen.has(finding.fingerprint))
      ctx.addIssue({ code: "custom", message: `$[${index}]: fingerprint tekrarı`, path: [index] });
    seen.add(finding.fingerprint);
    if (previous !== null && previous > finding.fingerprint)
      ctx.addIssue({
        code: "custom",
        message: `$[${index}]: kayıtlar fingerprint'e göre sıralı olmalı`,
        path: [index],
      });
    previous = finding.fingerprint;
  });
});
export type AuditFindingsDocument = z.infer<typeof AuditFindingsDocument>;

/**
 * Kapsam birimi: `surface × attackClass`. `fingerprint` alanı, bu birimde doğrulanmış kaydı
 * ledger'a bağlar; provenance (`foundBy`/`verifiedBy`) burada tutulur çünkü kayıt şeması
 * upstream gereği ek alan kabul etmez.
 */
export const CoverageUnit = z.strictObject({
  id: z.string().min(1),
  surface: z.string().min(1),
  attackClass: z.string().min(1),
  scopePaths: z.array(z.string()),
  status: AuditUnitStatus,
  /** Birimin bağlı olduğu kaynak sürümü; değişirse `covered` birim yeniden doğrulanır. */
  sourceRef: z.string(),
  /** Bu birimde doğrulanmış kaydın fingerprint'i (varsa). */
  fingerprint: z.string().nullable().default(null),
  /** Kaydı bulan ve doğrulayan alt ajan oturum kimlikleri (bağımsızlık kanıtı). */
  foundBy: z.string().nullable().default(null),
  verifiedBy: z.string().nullable().default(null),
  /** `deferred`/`out_of_scope` gerekçesi. */
  note: z.string().optional(),
});
export type CoverageUnit = z.infer<typeof CoverageUnit>;

export const CoverageLedger = z.strictObject({
  version: z.literal(1),
  repo: z.string().min(1),
  sourceRef: z.string(),
  updatedAt: z.number(),
  units: z.array(CoverageUnit),
});
export type CoverageLedger = z.infer<typeof CoverageLedger>;

export const AuditBudget = z.strictObject({
  /** Profil varsayılanı; `null` ise sınırsız. */
  agentCalls: z.number().int().positive().nullable(),
  used: z.number().int().nonnegative(),
});
export type AuditBudget = z.infer<typeof AuditBudget>;

export const AuditRunMeta = z.strictObject({
  runId: z.string().min(1),
  repo: z.string().min(1),
  target: z.string().min(1),
  profile: AuditProfile,
  sourceRef: z.string(),
  scopePaths: z.array(z.string()),
  /** Seçilen saldırı sınıfı paketleri (companion dosya adları). */
  packs: z.array(z.string()),
  executionPolicy: z.literal("source-only"),
  budget: AuditBudget,
  status: AuditStatus,
  phase: AuditPhase,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  incompleteReason: z.string().optional(),
  /**
   * Kaynak listesi kırpıldıysa not: `MAX_FILES` üstünde dosya varsa defter yalnız ilk dilimi
   * kapsar. Bu alan olmadan koşu "tam kapsama" diye kapanır ve kırpılan dosyalar hiç
   * denetlenmemiş olur (rapor okuyan kişi bunu göremez).
   */
  coverageNote: z.string().optional(),
});
export type AuditRunMeta = z.infer<typeof AuditRunMeta>;

export const AuditStartOptions = z.strictObject({
  profile: AuditProfile.default("standard"),
  /** Boş/verilmezse tüm depo kapsamı. */
  scopePaths: z.array(z.string()).optional(),
  /** Ajan çağrısı üst sınırı; verilmezse profil varsayılanı. */
  budget: z.number().int().positive().optional(),
});
export type AuditStartOptions = z.infer<typeof AuditStartOptions>;

/** Panelin gördüğü kompakt bulgu satırı; tam kayıt `findings.json`'da kalır. */
export const AuditFindingView = z.strictObject({
  fingerprint: z.string(),
  verdict: z.enum(["confirmed", "needs_validation", "rejected"]),
  title: z.string(),
  summary: z.string(),
  /** Yalnızca `confirmed` kayıtlarda dolu. */
  severity: AuditSeverity.nullable(),
  evidence: z.array(AuditEvidenceEntry),
  unit: z.string().nullable(),
  /** Kaydı bulan ve doğrulayan oturumlar farklı mı (yalnız `confirmed` için anlamlı, K4). */
  independentlyVerified: z.boolean(),
});
export type AuditFindingView = z.infer<typeof AuditFindingView>;

export const AuditCounts = z.strictObject({
  units: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  outOfScope: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  needsValidation: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type AuditCounts = z.infer<typeof AuditCounts>;

/** Sağ paneldeki Bulgular sekmesinin tek veri kaynağı. */
export const AuditView = z.strictObject({
  runId: z.string(),
  repo: z.string(),
  target: z.string(),
  profile: AuditProfile,
  phase: AuditPhase,
  status: AuditStatus,
  sourceRef: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  incompleteReason: z.string().nullable(),
  budget: AuditBudget,
  counts: AuditCounts,
  findings: z.array(AuditFindingView),
  /** Rapor Markdown'ı üretildiyse mutlak yol; panel "raporu aç" için kullanır. */
  reportPath: z.string().nullable(),
  /** PDF dışa aktarıldıysa mutlak yol. */
  pdfPath: z.string().nullable(),
  /** Run klasörü (findings.json ve raporlar); panel ve düzeltme görevi bunu kullanır. */
  runDir: z.string(),
});
export type AuditView = z.infer<typeof AuditView>;
