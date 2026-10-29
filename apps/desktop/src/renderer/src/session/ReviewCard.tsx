import type { ReviewFinding, ReviewOutcome } from "@codezal/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Clamp } from "../components/Clamp";
import { ErrorText } from "../components/ErrorBar";
import type { ReviewRuntime } from "../stores/reduce";

const CLASS_KEYS = {
  bug: "transcript.reviewClassBug",
  risk: "transcript.reviewClassRisk",
  nit: "transcript.reviewClassNit",
} as const;

const VERDICT_KEYS = {
  confirmed: "transcript.reviewVerdictConfirmed",
  rejected: "transcript.reviewVerdictRejected",
  inconclusive: "transcript.reviewVerdictInconclusive",
} as const;

const VERDICT_TONE = {
  confirmed: "text-red",
  rejected: "text-tx3",
  inconclusive: "text-tx2",
} as const;

/**
 * Kod incelemesi satırı ve kartı: gölge modda koşan denetçinin bulguları. Satır son turun altında
 * durur; tıklanınca bulgu listesi, kanıt ve ölçüm işaretleri açılır. Bulgular modele geri
 * gönderilmez; "Gerçek / Yanlış pozitif" işareti yalnızca ölçüm kaydına yazılır.
 */
export function ReviewCard({ review, sessionId }: { review: ReviewRuntime; sessionId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [marks, setMarks] = useState<Record<string, ReviewOutcome>>({});
  const findings = review.findings ?? [];
  const counts = review.counts;

  if (review.phase === "started") {
    return <div className="text-[12px] text-tx3">{t("transcript.reviewRunning")}</div>;
  }

  const tokens = review.usage
    ? review.usage.input + review.usage.output + review.usage.cacheRead + review.usage.cacheWrite
    : 0;
  const summary =
    findings.length === 0
      ? t("transcript.reviewClean")
      : t("transcript.reviewSummary", {
          confirmed: counts?.confirmed ?? 0,
          rejected: counts?.rejected ?? 0,
          inconclusive: counts?.inconclusive ?? 0,
        });
  const cost =
    tokens > 0 ? ` · ${t("transcript.reviewCost", { tokens: tokens.toLocaleString() })}` : "";

  const mark = (finding: ReviewFinding, outcome: ReviewOutcome) => {
    setMarks((m) => ({ ...m, [finding.id]: outcome }));
    void invoke("review:mark", { sessionId, findingId: finding.id, outcome }).catch(
      () => undefined,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {review.error ? <ErrorText text={review.error} /> : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start text-left text-[12px] text-tx2 hover:text-tx"
      >
        {summary}
        {cost}
      </button>
      {open ? (
        <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-card2 px-4 py-3">
          {findings.map((finding) => {
            const outcome = marks[finding.id] ?? finding.outcome;
            return (
              <div key={finding.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="rounded-[6px] border border-line2 px-[6px] py-[1px] text-tx2">
                    {t(CLASS_KEYS[finding.class])}
                  </span>
                  <span className="font-medium text-tx">{finding.title}</span>
                  <span className={`text-[11px] ${VERDICT_TONE[finding.verdict]}`}>
                    {t(VERDICT_KEYS[finding.verdict])}
                  </span>
                  <span className="font-mono text-[11px] text-tx3">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </span>
                </div>
                <div className="text-[12px] leading-[1.5] text-tx2">{finding.description}</div>
                <Clamp
                  text={finding.evidence}
                  className="whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-tx2"
                />
                <div className="text-[11px] text-tx3">{finding.verdictReason}</div>
                <div className="flex items-center gap-2 pt-[2px]">
                  <button
                    type="button"
                    onClick={() => mark(finding, "real")}
                    className={`rounded-[7px] border px-[8px] py-[2px] text-[11px] hover:bg-hov ${
                      outcome === "real" ? "border-accLine text-accTx" : "border-line2 text-tx2"
                    }`}
                  >
                    {t("transcript.reviewMarkReal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => mark(finding, "false_positive")}
                    className={`rounded-[7px] border px-[8px] py-[2px] text-[11px] hover:bg-hov ${
                      outcome === "false_positive"
                        ? "border-accLine text-accTx"
                        : "border-line2 text-tx2"
                    }`}
                  >
                    {t("transcript.reviewMarkFalse")}
                  </button>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => void invoke("review:reveal", { sessionId }).catch(() => undefined)}
            className="self-start text-[11px] text-tx3 hover:text-tx2"
          >
            {t("transcript.reviewReveal")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
