import {
  type AuditEvidenceEntry,
  type AuditFinding,
  AuditFindingsDocument,
  type AuditFindingView,
  type AuditSeverity,
  type CoverageUnit,
  hasVisibleProse,
} from "@codezal/contracts";

/**
 * Bulgu kaydı doğrulaması: yapısal + semantik kurallar `AuditFindingsDocument` içinde
 * (upstream `validate-findings.cjs` ile aynı kurallar). Burada yalnızca sonucu araç
 * sonuçlarına uygun bir hata listesine çeviriyoruz.
 */
export function validateFindings(
  input: unknown,
): { ok: true; findings: AuditFinding[] } | { ok: false; errors: string[] } {
  const parsed = AuditFindingsDocument.safeParse(input);
  if (parsed.success) return { ok: true, findings: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "$";
      return `${path}: ${issue.message}`;
    }),
  };
}

/** Upstream sıralama kuralı: kod birimi sırasıyla artan fingerprint (locale değil). */
export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
  );
}

/**
 * Aday kaydı kaynak-güdümlü, durumdan bağımsız bir kimlik taşır: aynı aday `needs_validation`
 * iken de `confirmed` olurken de aynı fingerprint'i korur (upstream kuralı).
 */
export function fingerprintFor(input: { attackClass: string; file: string; line: number }): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9._/@+-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `${slug(input.attackClass) || "audit"}:${slug(input.file) || "unknown"}:${input.line}`;
}

/** Panelde ve araç sonucunda gösterilen tek satırlık özet. */
export function summaryOf(finding: AuditFinding): string {
  const firstSentence = finding.description.split(/(?<=[.!?])\s+/)[0] ?? finding.description;
  const text = firstSentence.trim() || finding.description.trim();
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

/** Kaydın severity'si yalnızca `confirmed` için vardır; diğerleri null. */
export function severityOf(finding: AuditFinding): AuditSeverity | null {
  return finding.verdict === "confirmed" ? finding.severity.overall_severity : null;
}

export function evidenceOf(finding: AuditFinding): AuditEvidenceEntry[] {
  return finding.evidence;
}

/** Ledger biriminden kayda provenance; kayıt şeması ek alan taşıyamadığı için burada durur. */
export function toFindingView(finding: AuditFinding, unit: CoverageUnit | null): AuditFindingView {
  const foundBy = unit?.foundBy ?? null;
  const verifiedBy = unit?.verifiedBy ?? null;
  return {
    fingerprint: finding.fingerprint,
    verdict: finding.verdict,
    title: finding.title,
    summary: summaryOf(finding),
    severity: severityOf(finding),
    evidence: evidenceOf(finding).slice(0, 4),
    unit: unit?.id ?? null,
    // Yalnizca `confirmed` bağımsız doğrulama iddiası taşır; diğer kararlar severity almaz.
    independentlyVerified:
      finding.verdict === "confirmed" &&
      foundBy !== null &&
      verifiedBy !== null &&
      foundBy !== verifiedBy,
  };
}

/** Modelin okuduğu kayıtların güvenli olup olmadığını hızlıca bildirir (boş/kontrol karakteri). */
export function isUsableText(value: string): boolean {
  return value.trim().length > 0 && hasVisibleProse(value);
}
