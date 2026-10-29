import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ReviewCounts,
  type ReviewFinding,
  type ReviewOutcome,
  ReviewRecord,
} from "@codezal/contracts";
import { z } from "zod";
import { extractJson } from "./audit/parse.js";
import { repoKey } from "./audit/store.js";

/**
 * Kod incelemesi (deneysel) alt sistemi. Denetçi adayları üretir, bağımsız doğrulayıcı bunları
 * çürütmeye çalışır; sonuç gölge modda kayda ve arayüze gider, modele geri verilmez. Model
 * çıktısı toleranslı çözümlenir (fazladan alanlar süzülür, bozuk aday düşer); kayıt şeması katı
 * kalır. Kayıt JSONL'dir ve yalnızca satır eklenir: işaret güncellemesi ayrı `mark` satırıdır.
 */

/** Denetçinin ürettiği aday; doğrulama kararı ayrı turda gelir. */
export const ReviewerFinding = z.strictObject({
  class: z.enum(["bug", "risk", "nit"]),
  title: z.string().min(1),
  description: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  /** Kod alıntısı ya da adım adım yeniden üretim; kanıtsız aday kayda geçmez. */
  evidence: z.string().min(1),
});
export type ReviewerFinding = z.infer<typeof ReviewerFinding>;

export const ReviewerOutput = z.strictObject({ findings: z.array(ReviewerFinding) });
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

/** Doğrulayıcı kararı; `reason` her durumda zorunlu (kanıtsız confirmed yok). */
export const ValidatorVerdict = z.strictObject({
  verdict: z.enum(["confirmed", "rejected", "inconclusive"]),
  reason: z.string().min(1),
});
export type ValidatorVerdict = z.infer<typeof ValidatorVerdict>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const FINDING_KEYS = ["class", "title", "description", "file", "line", "evidence"] as const;
const VERDICT_KEYS = ["verdict", "reason"] as const;

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Geçersiz `line` tüm adayı düşürmesin: sayı değilse alan silinir. */
function normalizeLine(picked: Record<string, unknown>): void {
  const line = picked.line;
  if (line === undefined) return;
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) delete picked.line;
}

/** Denetçi çıktısı: `{findings: [...]}` ya da doğrudan dizi; geçersiz adaylar atlanır. */
export function parseReviewerOutput(text: string): Parsed<ReviewerOutput> {
  const value = extractJson(text);
  if (value === null) return { ok: false, error: "JSON bulunamadı" };
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "findings" in value
      ? (value as { findings: unknown }).findings
      : null;
  if (!Array.isArray(raw)) return { ok: false, error: "findings dizisi yok" };
  const findings: ReviewerFinding[] = [];
  for (const item of raw) {
    const picked = pick(item, FINDING_KEYS);
    if (!picked) continue;
    normalizeLine(picked);
    const parsed = ReviewerFinding.safeParse(picked);
    if (parsed.success) findings.push(parsed.data);
  }
  return { ok: true, value: { findings } };
}

/** Doğrulayıcı kararı; fazladan alanlar süzülür. */
export function parseValidatorVerdict(text: string): Parsed<ValidatorVerdict> {
  const value = extractJson(text);
  if (value === null) return { ok: false, error: "JSON bulunamadı" };
  const picked = pick(value, VERDICT_KEYS);
  if (!picked) return { ok: false, error: "nesne bekleniyordu" };
  const parsed = ValidatorVerdict.safeParse(picked);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "$"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: detail };
  }
  return { ok: true, value: parsed.data };
}

/**
 * İnceleme kayıtlarının disk deposu: `userData/reviews/<depo anahtarı>/<oturum>.jsonl`.
 * Kayıt yalnızca eklenir; `mark` satırları son durumu belirler. Yazma hatası incelemeyi
 * düşürmez (çağıran yutar), çünkü asıl çıktı arayüze olayla gider.
 */
export class ReviewStore {
  /** `userData/reviews` kökü. */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Oturumun kayıt dosyası; kimlik dosya adına güvenli biçimde çevrilir. */
  fileFor(cwd: string, sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-");
    return join(this.dir, repoKey(cwd), `${safe}.jsonl`);
  }

  /** Koşu özetini ve bulguları ekler. */
  record(
    cwd: string,
    sessionId: string,
    input: { at: number; files: string[]; counts: ReviewCounts; findings: ReviewFinding[] },
  ): void {
    const records: ReviewRecord[] = [
      { kind: "run", at: input.at, files: input.files, counts: input.counts },
      ...input.findings.map((finding): ReviewRecord => ({ kind: "finding", finding })),
    ];
    this.#append(cwd, sessionId, records);
  }

  /** Kullanıcı işareti (ölçüm): bulgu gerçek miydi, yanlış pozitif mi? */
  mark(cwd: string, sessionId: string, id: string, outcome: ReviewOutcome): void {
    this.#append(cwd, sessionId, [{ kind: "mark", id, outcome, at: Date.now() }]);
  }

  /** Kayıtları okur; bozuk satırlar atlanır. */
  read(cwd: string, sessionId: string): ReviewRecord[] {
    let text: string;
    try {
      text = readFileSync(this.fileFor(cwd, sessionId), "utf8");
    } catch {
      return [];
    }
    const out: ReviewRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = ReviewRecord.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // Bozuk satır kaydı düşürmez; sonraki satırlar okunur.
      }
    }
    return out;
  }

  /** Son durum: bulgular + işaretler uygulanmış hâli. */
  state(cwd: string, sessionId: string): ReviewFinding[] {
    const findings = new Map<string, ReviewFinding>();
    for (const record of this.read(cwd, sessionId)) {
      if (record.kind === "finding") findings.set(record.finding.id, record.finding);
      else if (record.kind === "mark") {
        const current = findings.get(record.id);
        if (current) findings.set(record.id, { ...current, outcome: record.outcome });
      }
    }
    return [...findings.values()];
  }

  #append(cwd: string, sessionId: string, records: ReviewRecord[]): void {
    const file = this.fileFor(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const text = records.map((record) => JSON.stringify(record)).join("\n");
    appendFileSync(file, `${text}\n`, "utf8");
  }
}
