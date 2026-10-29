import { z } from "zod";

/** İnceleme bulgusunun sınıfı: davranış hatası, olası risk ya da stil/iyileştirme önerisi. */
export const ReviewClass = z.enum(["bug", "risk", "nit"]);
export type ReviewClass = z.infer<typeof ReviewClass>;

/** Bağımsız doğrulayıcının kararı; kanıt üretilemeyen aday `confirmed` olamaz. */
export const ReviewVerdict = z.enum(["confirmed", "rejected", "inconclusive"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** Kullanıcı işareti (ölçüm): bulgu gerçek miydi, yanlış pozitif mi? */
export const ReviewOutcome = z.enum(["pending", "real", "false_positive"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/** İnceleme koşusunun doğrulama özeti. */
export const ReviewCounts = z.object({
  confirmed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
});
export type ReviewCounts = z.infer<typeof ReviewCounts>;

/** Kartta ve kayıtta taşınan tek bulgu; `evidence` kartta kısaltılır. */
export const ReviewFinding = z.object({
  id: z.string().min(1),
  at: z.number(),
  class: ReviewClass,
  title: z.string().min(1),
  description: z.string().min(1),
  /** Depo-göreli dosya ve satır: kanıtın konumu. */
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  verdict: ReviewVerdict,
  /** Doğrulayıcının gerekçesi; doğrulanmayan sınıflarda denetçinin notu. */
  verdictReason: z.string(),
  /** Denetçinin gösterdiği kanıt: kod alıntısı ya da yeniden üretim adımı. */
  evidence: z.string().min(1),
  /** Kullanıcı işareti; `review:mark` ile güncellenir. */
  outcome: ReviewOutcome.default("pending"),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** Disk kaydı (JSONL satırları): koşu özeti, bulgu ve kullanıcı işareti ayrı satırlar. */
export const ReviewRecord = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    at: z.number(),
    files: z.array(z.string()),
    counts: ReviewCounts,
  }),
  z.object({ kind: z.literal("finding"), finding: ReviewFinding }),
  z.object({
    kind: z.literal("mark"),
    id: z.string().min(1),
    outcome: ReviewOutcome,
    at: z.number(),
  }),
]);
export type ReviewRecord = z.infer<typeof ReviewRecord>;
