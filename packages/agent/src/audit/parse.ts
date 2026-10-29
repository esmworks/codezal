import {
  AuditConfidence,
  AuditExecution,
  AuditRemediation,
  AuditSeverityBlock,
} from "@codezal/contracts";
import { z } from "zod";
import { HunterCandidate, type HunterOutput, VerifierVerdict } from "./candidates.js";

/**
 * Alt ajan çıktısından yapı çıkarma. Modeller JSON'u kod bloğuna sarabilir ya da fazladan alan
 * ekleyebilir; bilinen alanlar süzülür, fazlalıklar atılır. Şemanın kendisi katı kalır: kayda
 * terfi (`promoteCandidate`) yine tam doğrulamadan geçer, yani tolerans yalnızca ara çıktıda.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Metindeki ilk JSON nesnesini/dizisini bulur (kod bloğu varsa onu tercih eder). */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((v): v is string => typeof v === "string");
  for (const candidate of candidates) {
    // Hangi ayraç önce geliyorsa onu dene: `[{...}]` girişinde içteki nesneyi değil diziyi al.
    const braces: Array<[string, string]> = [
      ["{", "}"],
      ["[", "]"],
    ];
    braces.sort((a, b) => {
      const ai = candidate.indexOf(a[0]);
      const bi = candidate.indexOf(b[0]);
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    });
    for (const [open, close] of braces) {
      const start = candidate.indexOf(open);
      const end = candidate.lastIndexOf(close);
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Sıradaki sınırı dene.
      }
    }
  }
  return null;
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const TRACE_KEYS = ["kind", "file", "line", "scope", "description"] as const;
const EVIDENCE_KEYS = ["file", "line", "description"] as const;
const CONDITION_KEYS = ["kind", "description"] as const;
const CONFIDENCE_KEYS = ["score", "reason"] as const;
const HUNTER_KEYS = [
  "title",
  "description",
  "claimed_root_cause",
  "intended_behavior",
  "trace",
  "evidence",
  "conditions",
  "confidence",
] as const;
const VERDICT_KEYS = [
  "verdict",
  "reason",
  "root_cause",
  "intended_behavior",
  "execution",
  "remediation",
  "severity",
  "confidence",
  "blockers",
  "validation_plan",
] as const;

/** Aday nesnesini bilinen alanlara indirger; iz/kanıt/koşul dizileri de süzülür. */
export function filterHunterCandidate(value: unknown): Record<string, unknown> | null {
  const picked = pick(value, HUNTER_KEYS);
  if (!picked) return null;
  const keepArray = (input: unknown, keys: readonly string[]) =>
    Array.isArray(input)
      ? input.map((item) => pick(item, keys)).filter((item) => item !== null)
      : undefined;
  if ("trace" in picked) picked.trace = keepArray(picked.trace, TRACE_KEYS);
  if ("evidence" in picked) picked.evidence = keepArray(picked.evidence, EVIDENCE_KEYS);
  if ("conditions" in picked) picked.conditions = keepArray(picked.conditions, CONDITION_KEYS);
  if ("confidence" in picked)
    picked.confidence = pick(picked.confidence, CONFIDENCE_KEYS) ?? undefined;
  for (const key of Object.keys(picked)) {
    if (picked[key] === undefined) delete picked[key];
  }
  return picked;
}

function issues(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "$"}: ${issue.message}`)
    .join("; ");
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/** Avcı çıktısı: `{candidates: [...]}` ya da doğrudan aday dizisi. */
export function parseHunterOutput(text: string): Parsed<HunterOutput> {
  const value = extractJson(text);
  if (value === null) return { ok: false, error: "JSON bulunamadı" };
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "candidates" in value
      ? (value as { candidates: unknown }).candidates
      : null;
  if (!Array.isArray(raw)) return { ok: false, error: "candidates dizisi yok" };
  const filtered = raw.map(filterHunterCandidate).filter((item) => item !== null);
  // Eleman düşürüldüyse çıktı **eksik** sayılır, boş sayılmaz. `extractJson` metindeki ilk tam
  // JSON'u alır: avcının düzyazısında `Adımlar: [1, 2]` gibi bir dizi geçerse gerçek adaylar hiç
  // görülmez, `safeParse([])` başarılı olur ve birim "covered" işaretlenirdi — rapor, denetlenmemiş
  // kodu denetlenmiş sayardı. Onarım turu ve `parse_error` kaydı tam bu durum için var.
  if (filtered.length < raw.length) {
    return { ok: false, error: `${raw.length - filtered.length}/${raw.length} aday geçersiz` };
  }
  const parsed = z.array(HunterCandidate).safeParse(filtered);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  return { ok: true, value: { candidates: parsed.data } };
}

/** Doğrulayıcı kararı; fazladan alanlar süzülür, iç içe opsiyonel bloklar geçersizse düşürülür. */
export function parseVerifierVerdict(text: string): Parsed<VerifierVerdict> {
  const value = extractJson(text);
  if (value === null) return { ok: false, error: "JSON bulunamadı" };
  const picked = pick(value, VERDICT_KEYS);
  if (!picked) return { ok: false, error: "nesne bekleniyordu" };
  const keepIfValid = (key: string, schema: z.ZodType) => {
    const candidate = picked[key];
    if (candidate === undefined) return;
    const parsed = schema.safeParse(candidate);
    if (parsed.success) picked[key] = parsed.data;
    else delete picked[key];
  };
  keepIfValid("execution", AuditExecution);
  keepIfValid("remediation", AuditRemediation);
  keepIfValid("severity", AuditSeverityBlock);
  keepIfValid("confidence", AuditConfidence);
  if ("validation_plan" in picked) {
    const plan = pick(picked.validation_plan, ["local", "deployment"]);
    const usable = plan
      ? Object.fromEntries(
          Object.entries(plan).filter(([, v]) => typeof v === "string" && v.trim().length > 0),
        )
      : {};
    if (Object.keys(usable).length > 0) picked.validation_plan = usable;
    else delete picked.validation_plan;
  }
  if ("blockers" in picked) {
    const blockers = Array.isArray(picked.blockers)
      ? picked.blockers.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      : [];
    if (blockers.length > 0) picked.blockers = blockers;
    else delete picked.blockers;
  }
  for (const key of Object.keys(picked)) {
    if (picked[key] === undefined) delete picked[key];
  }
  const parsed = VerifierVerdict.safeParse(picked);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  return { ok: true, value: parsed.data };
}
