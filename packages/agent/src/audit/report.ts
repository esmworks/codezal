import type { AuditFinding, AuditRunMeta, CoverageLedger } from "@codezal/contracts";

import { type Dict, dict, type Locale, localeTag } from "@codezal/i18n";
import { sortFindings } from "./schema.js";

/**
 * Markdown çıktısına giren **model/kaynak metnini** tek satıra indirir.
 *
 * Rapor `findings.json`dan türetilir ve "rapor bir fonksiyondur" garantisi buna dayanır; ama
 * bulgu başlığı/açıklaması alt ajanın ürettiği metindir ve satır sonu taşıyabilir. `## Doğrulanmış
 * bulgular` gibi bir satır ekleyen aday, raporu okuyan kişiye uydurma bir bölüm gösterirdi. HTML
 * yolunda `esc` vardı, Markdown yolunda yoktu; burada satır sonları ve markdown yapı karakterleri
 * etkisizleştirilir.
 */
function mdInline(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      // Ters bölü **önce** kaçırılır: sonra kaçırılsaydı `\*` dizisi `\\*` olur ve yeniden
      // vurgu başlatırdı.
      .replace(/\\/g, "\\\\")
      .replace(/([`*_[\]<>|])/g, "\\$1")
      // Satır başındaki yapı karakterleri: açıklama kendi satırında basıldığı için `# ` ile başlayan
      // bir metin rapora uydurma bir bölüm eklerdi.
      .replace(/^([#>])/, "\\$1")
      .replace(/^(-)(\s)/, "\\$1$2")
      .trim()
  );
}

/**
 * Rapor türetimi: üç Markdown dosyası ve PDF için HTML, yalnızca doğrulanmış kayıtlardan ve
 * kapsam defterinden **deterministik** olarak üretilir. Metin ile `findings.json` çelişemez;
 * rapor modelin yazdığı düzyazı değil, kayıtların fonksiyonudur (anti-pattern #10 çözümü).
 */

export interface AuditReportInput {
  meta: AuditRunMeta;
  ledger: CoverageLedger;
  findings: AuditFinding[];
}

export interface AuditReportOutput {
  report: string;
  detail: string;
  needsValidation: string;
  html: string;
}

/** Rapor metinleri sözlükten gelir; anahtarlar tr.ts/en.ts içindeki `audit.report` ile aynıdır. */
type ReportDict = Dict["audit"]["report"];

export function buildReport(input: AuditReportInput, lang: Locale = "tr"): AuditReportOutput {
  const d = dict(lang).audit.report;
  const findings = sortFindings(input.findings);
  const confirmed = findings.filter((f) => f.verdict === "confirmed");
  const pending = findings.filter((f) => f.verdict === "needs_validation");
  const rejected = findings.filter((f) => f.verdict === "rejected");
  const statusCount = (status: string) =>
    input.ledger.units.filter((u) => u.status === status).length;

  const head = [
    `# ${d.title} — ${input.meta.repo}`,
    "",
    `## ${d.runInfo}`,
    "",
    `- ${d.repo}: \`${input.meta.repo}\``,
    `- ${d.target}: \`${input.meta.target}\``,
    `- ${d.profile}: ${input.meta.profile}`,
    `- ${d.sourceRef}: \`${input.meta.sourceRef}\``,
    `- ${d.executionPolicy}: ${d.sourceOnly}`,
    `- ${d.started}: ${new Date(input.meta.startedAt).toISOString()}`,
    `- ${d.status}: ${input.meta.status}${
      input.meta.incompleteReason ? ` (${d.incomplete}: ${input.meta.incompleteReason})` : ""
    }`,
    "",
  ];

  const coverage = [
    `## ${d.coverage}`,
    "",
    `- ${d.units}: ${input.ledger.units.length}`,
    `- ${d.covered}: ${statusCount("covered")}`,
    `- ${d.deferred}: ${statusCount("deferred")}`,
    `- ${d.planned}: ${statusCount("planned")}`,
    `- ${d.outOfScope}: ${statusCount("out_of_scope")}`,
    "",
    `| ${d.units} | ${d.coverage} | ${d.status} | ${d.note} |`,
    "| --- | --- | --- | --- |",
    ...input.ledger.units.map(
      (unit) =>
        `| \`${mdInline(unit.id)}\` ${mdInline(unit.attackClass)} | ${unit.scopePaths.length} | ${unit.status} | ${mdInline(unit.note ?? "")} |`,
    ),
    "",
    `${d.coverageNote} ${d.singleRun}`,
    // Kaynak listesi kırpıldıysa uyarı raporun kapsam bölümünde görünür (meta'da duruyor).
    ...(input.meta.coverageNote ? ["", `> ${mdInline(input.meta.coverageNote)}`] : []),
    "",
  ];

  const summary = [
    `## ${d.findings}`,
    "",
    `- ${d.confirmed}: ${confirmed.length}`,
    `- ${d.needsValidationCount}: ${pending.length}`,
    `- ${d.rejected}: ${rejected.length}`,
    "",
    ...(confirmed.length === 0
      ? [d.noFindings, ""]
      : confirmed.map(
          (f) =>
            `- **[${f.severity.overall_severity}]** ${mdInline(f.title)} — \`${mdInline(f.evidence[0]?.file ?? "")}:${f.evidence[0]?.line}\``,
        )),
    "",
  ];

  const detail: string[] = [`# ${d.detailTitle} — ${input.meta.repo}`, ""];
  if (confirmed.length === 0) detail.push(d.noFindings, "");
  for (const finding of confirmed) {
    if (finding.verdict !== "confirmed") continue;
    detail.push(
      `## [${finding.severity.overall_severity}] ${mdInline(finding.title)}`,
      "",
      `\`${finding.fingerprint}\``,
      "",
      mdInline(finding.description),
      "",
      `**${d.trace}**`,
      "",
      ...finding.trace.map(
        (t) =>
          `- ${mdInline(t.kind)} — \`${mdInline(t.file)}:${t.line}\` (${t.scope}): ${mdInline(t.description)}`,
      ),
      "",
      `**${d.evidence}**`,
      "",
      ...finding.evidence.map(
        (e) => `- \`${mdInline(e.file)}:${e.line}\` — ${mdInline(e.description)}`,
      ),
      "",
    );
    if (finding.conditions.length > 0) {
      detail.push(
        `**${d.conditions}**`,
        "",
        ...finding.conditions.map((c) => `- ${mdInline(c.kind)}: ${mdInline(c.description)}`),
        "",
      );
    }
    detail.push(
      `**${d.execution}** — ${mdInline(finding.execution.attacker_perspective)}`,
      "",
      ...finding.execution.instructions.map((step) => `- ${mdInline(step)}`),
      "",
      `${d.observedResult}: ${mdInline(finding.execution.observed_result)}`,
      "",
      `**${d.remediation}**: ${mdInline(finding.remediation.strategy)}`,
      "",
      `**${d.confidence}**: ${finding.confidence.score} — ${mdInline(finding.confidence.reason)}`,
      "",
    );
  }
  if (rejected.length > 0) {
    detail.push(`## ${d.rejectedSection}`, "");
    for (const finding of rejected) {
      if (finding.verdict !== "rejected") continue;
      detail.push(
        `- \`${finding.fingerprint}\` ${mdInline(finding.title)} — ${mdInline(finding.reason)}`,
      );
    }
    detail.push("");
  }

  const needs = [`# ${d.needsTitle} — ${input.meta.repo}`, ""];
  if (pending.length === 0) needs.push(d.noFindings, "");
  for (const finding of pending) {
    if (finding.verdict !== "needs_validation") continue;
    needs.push(
      `## ${mdInline(finding.title)}`,
      "",
      `\`${finding.fingerprint}\``,
      "",
      mdInline(finding.description),
      "",
      `**${d.blockers}**`,
      "",
      ...finding.blockers.map((b) => `- ${mdInline(b)}`),
      "",
      `**${d.validationPlan}**`,
      "",
      ...(finding.validation_plan.local
        ? [`- ${d.local}: ${mdInline(finding.validation_plan.local)}`]
        : []),
      ...(finding.validation_plan.deployment
        ? [`- ${d.deployment}: ${mdInline(finding.validation_plan.deployment)}`]
        : []),
      "",
      ...finding.evidence.map(
        (e) => `- \`${mdInline(e.file)}:${e.line}\` — ${mdInline(e.description)}`,
      ),
      "",
    );
  }

  const report = [...head, ...coverage, ...summary].join("\n");
  return {
    report,
    detail: detail.join("\n"),
    needsValidation: needs.join("\n"),
    html: reportHtml(d, lang, input, confirmed, pending, rejected),
  };
}

/** PDF için tek dosyalık HTML (main `renderPdf` bunu Chromium'a verir). */
function reportHtml(
  d: ReportDict,
  lang: Locale,
  input: AuditReportInput,
  confirmed: AuditFinding[],
  pending: AuditFinding[],
  rejected: AuditFinding[],
): string {
  const esc = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = input.ledger.units
    .map(
      (unit) =>
        `<tr><td><code>${esc(unit.id)}</code></td><td>${esc(unit.attackClass)}</td><td>${unit.scopePaths.length}</td><td>${esc(unit.status)}</td><td>${esc(unit.note ?? "")}</td></tr>`,
    )
    .join("");
  const confirmedHtml = confirmed
    .map((finding) => {
      if (finding.verdict !== "confirmed") return "";
      return `<section class="finding">
  <h3>[${esc(finding.severity.overall_severity)}] ${esc(finding.title)}</h3>
  <p class="fp">${esc(finding.fingerprint)}</p>
  <p>${esc(finding.description)}</p>
  <h4>${d.trace}</h4>
  <ul>${finding.trace.map((t) => `<li>${esc(t.kind)} — <code>${esc(t.file)}:${t.line}</code> (${esc(t.scope)}): ${esc(t.description)}</li>`).join("")}</ul>
  <h4>${d.evidence}</h4>
  <ul>${finding.evidence.map((e) => `<li><code>${esc(e.file)}:${e.line}</code> — ${esc(e.description)}</li>`).join("")}</ul>
  <h4>${d.execution}</h4>
  <p>${esc(finding.execution.observed_result)}</p>
  <h4>${d.remediation}</h4>
  <p>${esc(finding.remediation.strategy)}</p>
</section>`;
    })
    .join("");
  const pendingHtml = pending
    .map((finding) => {
      if (finding.verdict !== "needs_validation") return "";
      return `<section class="finding">
  <h3>${esc(finding.title)}</h3>
  <p class="fp">${esc(finding.fingerprint)}</p>
  <p>${esc(finding.description)}</p>
  <h4>${d.blockers}</h4>
  <ul>${finding.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
</section>`;
    })
    .join("");
  const rejectedHtml = rejected
    .map((finding) =>
      finding.verdict === "rejected"
        ? `<li><code>${esc(finding.fingerprint)}</code> ${esc(finding.title)} — ${esc(finding.reason)}</li>`
        : "",
    )
    .join("");
  return `<!doctype html>
<html lang="${localeTag(lang)}"><head><meta charset="utf-8"><title>${d.title} — ${esc(input.meta.repo)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font: 12px/1.55 -apple-system, "Segoe UI", sans-serif; color: #1c1c1e; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 22px 0 8px; border-bottom: 1px solid #d8d8dc; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 4px; }
  h4 { font-size: 12px; margin: 10px 0 4px; color: #555; }
  code, .fp { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #444; }
  .fp { margin: 0 0 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { border: 1px solid #e2e2e6; padding: 4px 6px; text-align: left; }
  th { background: #f5f5f7; }
  .finding { page-break-inside: avoid; }
  .meta td { border: 0; padding: 1px 8px 1px 0; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  footer { margin-top: 24px; font-size: 10px; color: #777; }
</style></head><body>
<h1>${d.title}</h1>
<p class="fp">${esc(input.meta.repo)} · ${esc(input.meta.sourceRef)} · ${esc(input.meta.profile)}</p>
<table class="meta">
  <tr><td>${d.target}</td><td><code>${esc(input.meta.target)}</code></td></tr>
  <tr><td>${d.executionPolicy}</td><td>${d.sourceOnly}</td></tr>
  <tr><td>${d.started}</td><td>${new Date(input.meta.startedAt).toISOString()}</td></tr>
  <tr><td>${d.status}</td><td>${esc(input.meta.status)}${input.meta.incompleteReason ? ` (${d.incomplete}: ${esc(input.meta.incompleteReason)})` : ""}</td></tr>
</table>
<h2>${d.coverage}</h2>
<table><thead><tr><th>${d.units}</th><th>${d.attackClass}</th><th>${d.target}</th><th>${d.status}</th><th>${d.note}</th></tr></thead><tbody>${rows}</tbody></table>
<p>${d.coverageNote} ${d.singleRun}</p>${input.meta.coverageNote ? `<p><strong>${esc(input.meta.coverageNote)}</strong></p>` : ""}
<h2>${d.findings}</h2>
<p>${d.confirmed}: ${confirmed.length} · ${d.needsValidationCount}: ${pending.length} · ${d.rejected}: ${rejected.length}</p>
${confirmedHtml}
${pendingHtml}
${rejected.length > 0 ? `<h2>${d.rejectedSection}</h2><ul>${rejectedHtml}</ul>` : ""}
<footer>Codezal — ${d.sourceOnly}</footer>
</body></html>`;
}
