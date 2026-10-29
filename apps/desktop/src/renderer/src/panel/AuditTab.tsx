import type { AuditFindingView, AuditView } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/Working";
import type { IconName } from "../icons";
import { useApp } from "../stores/app";
import { useAudit } from "../stores/audit";
import { useSessions } from "../stores/sessions";
import { humanizeError, toast } from "../stores/toast";

const PHASE_KEYS = {
  recon: "audit.phaseRecon",
  hunting: "audit.phaseHunting",
  validation: "audit.phaseValidation",
  recording: "audit.phaseRecording",
  verification: "audit.phaseVerification",
  reporting: "audit.phaseReporting",
} as const satisfies Record<AuditView["phase"], TranslationKey>;

const STATUS_KEYS = {
  in_progress: "audit.statusInProgress",
  complete: "audit.statusComplete",
  incomplete: "audit.statusIncomplete",
} as const satisfies Record<AuditView["status"], TranslationKey>;

const VERDICT_STYLE: Record<
  AuditFindingView["verdict"],
  { label: TranslationKey; className: string; icon: IconName }
> = {
  confirmed: { label: "audit.confirmed", className: "border-red/50 text-red", icon: "shield" },
  needs_validation: {
    label: "audit.needsValidation",
    className: "border-amber/50 text-amber",
    icon: "question",
  },
  rejected: { label: "audit.rejected", className: "border-line2 text-tx3", icon: "check" },
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: "bg-red/15 text-red",
  high: "bg-red/10 text-red",
  medium: "bg-amber/15 text-amber",
  low: "bg-chip text-tx2",
  informational: "bg-chip text-tx3",
};

const PROFILE_KEYS = {
  quick: "audit.profileQuick",
  standard: "audit.profileStandard",
  deep: "audit.profileDeep",
} as const satisfies Record<AuditView["profile"], TranslationKey>;

/**
 * Sağ panelin Bulgular sekmesi: run başlığı, kapsam sayaçları, bütçe ve doğrulanmış kayıtlar.
 * Bulgu metinleri düz metin olarak basılır (depo içeriği HTML/markdown olarak yorumlanmaz).
 */
export function AuditTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { view, loading, busy, load, start, exportReport, reveal } = useAudit();
  const createSession = useSessions((s) => s.create);
  const openSession = useApp((s) => s.openSession);

  useEffect(() => {
    void load(sessionId);
  }, [sessionId, load]);

  if (!view) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        {loading ? <Spinner /> : null}
        <div className="flex items-center gap-[9px] text-tx2">
          <Icon name="shield" size={17} className="text-tx2" />
          <span className="text-[13px] font-medium">{t("audit.title")}</span>
        </div>
        <p className="max-w-[300px] text-center text-[12px] leading-[1.6] text-tx3">
          {t("audit.empty")}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void start(sessionId).catch((error: unknown) => toast.error(humanizeError(error)));
          }}
          className="rounded-[8px] border border-line2 px-3 py-[6px] text-[12px] text-tx hover:bg-hov disabled:opacity-50"
        >
          {busy ? t("audit.starting") : t("audit.start")}
        </button>
      </div>
    );
  }

  const done = view.status !== "in_progress";
  const total = Math.max(1, view.counts.units);
  const segments = [
    { key: "covered", value: view.counts.covered, className: "bg-green" },
    { key: "deferred", value: view.counts.deferred, className: "bg-amber" },
    { key: "planned", value: view.counts.planned, className: "bg-acc" },
    { key: "outOfScope", value: view.counts.outOfScope, className: "bg-line2" },
  ] as const;
  const budgetText =
    view.budget.agentCalls === null
      ? t("audit.budgetUnlimited", { used: view.budget.used })
      : t("audit.budget", { used: view.budget.used, limit: view.budget.agentCalls });

  // Düzeltme ayrı bir oturuma gider: denetim kodu değiştirmez (K5); bulgu metni isteme gömülür.
  const createFixTask = (finding: AuditFindingView) => {
    const evidence = finding.evidence[0]
      ? `${finding.evidence[0].file}:${finding.evidence[0].line}`
      : "—";
    const prompt = t("audit.fixTaskPrompt", {
      fingerprint: finding.fingerprint,
      title: finding.title,
      summary: finding.summary,
      evidence,
      severity: finding.severity ?? "—",
      runDir: view.runDir,
    });
    void createSession(
      {
        cwd: view.target,
        mode: "kodlama",
        name: t("audit.fixTaskName", { title: finding.title }).slice(0, 80),
      },
      prompt,
    )
      // Komut yürüdüyse oturum açılmaz (`create` null döner); açılacak bir şey yok.
      .then((summary) => {
        if (summary) openSession(summary.id);
      })
      .catch((error: unknown) => toast.error(humanizeError(error)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-3">
        <div className="flex items-center gap-[9px]">
          <Icon name="shield" size={15} className={done ? "text-tx3" : "text-acc"} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-tx">
            {t("audit.title")}
          </span>
          <span
            className={`shrink-0 rounded-full px-[7px] py-[1px] text-[11px] ${
              view.status === "complete"
                ? "bg-green/15 text-green"
                : view.status === "incomplete"
                  ? "bg-amber/15 text-amber"
                  : "bg-chip text-tx2"
            }`}
          >
            {t(STATUS_KEYS[view.status])}
          </span>
        </div>
        <div className="mt-[6px] text-[11px] text-tx3">
          {view.runId} · {t("audit.profile")}: {t(PROFILE_KEYS[view.profile])} · {t("audit.phase")}:{" "}
          {t(PHASE_KEYS[view.phase])}
        </div>
        <div className="mt-[2px] text-[11px] text-tx3">
          {t("audit.sourceOnly")} · {budgetText}
        </div>
        {view.incompleteReason ? (
          <div className="mt-[2px] text-[11px] text-amber">
            {t("audit.incompleteReason")}: {view.incompleteReason}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-[6px] flex items-center justify-between text-[11px] text-tx3">
          <span>{t("audit.coverage")}</span>
          <span>
            {view.counts.covered}/{view.counts.units} {t("audit.units")}
          </span>
        </div>
        <div className="flex h-[6px] w-full overflow-hidden rounded-full bg-chip">
          {segments.map((segment) => (
            <span
              key={segment.key}
              className={segment.className}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ))}
        </div>
        <div className="mt-[8px] grid grid-cols-2 gap-x-3 gap-y-[3px] text-[11px] text-tx3">
          <span>
            {t("audit.covered")}: <span className="text-tx2">{view.counts.covered}</span>
          </span>
          <span>
            {t("audit.planned")}: <span className="text-tx2">{view.counts.planned}</span>
          </span>
          <span>
            {t("audit.deferred")}: <span className="text-tx2">{view.counts.deferred}</span>
          </span>
          <span>
            {t("audit.outOfScope")}: <span className="text-tx2">{view.counts.outOfScope}</span>
          </span>
        </div>

        <div className="mt-4 mb-[6px] flex items-center justify-between text-[11px] text-tx3">
          <span>{t("audit.findings")}</span>
          <span>
            {view.counts.confirmed} · {view.counts.needsValidation} · {view.counts.rejected}
          </span>
        </div>
        {view.findings.length === 0 ? (
          <p className="text-[12px] text-tx3">{t("audit.noFindings")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {view.findings.map((finding) => (
              <FindingRow
                key={finding.fingerprint}
                finding={finding}
                onCreateTask={createFixTask}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void exportReport(sessionId)
              .then((path) => {
                if (path) toast.success(`${t("audit.exported")}: ${path}`);
              })
              .catch((error: unknown) => toast.error(humanizeError(error)));
          }}
          className="rounded-[7px] border border-line2 px-2 py-[4px] text-[11px] text-tx2 hover:bg-hov hover:text-tx disabled:opacity-50"
        >
          {busy ? t("audit.exporting") : view.pdfPath ? t("audit.openReport") : t("audit.export")}
        </button>
        <button
          type="button"
          onClick={() => {
            void reveal(sessionId).catch((error: unknown) => toast.error(humanizeError(error)));
          }}
          className="rounded-[7px] px-2 py-[4px] text-[11px] text-tx3 hover:bg-hov hover:text-tx"
        >
          {t("audit.reveal")}
        </button>
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  onCreateTask,
}: {
  finding: AuditFindingView;
  onCreateTask: (finding: AuditFindingView) => void;
}) {
  const { t } = useTranslation();
  const style = VERDICT_STYLE[finding.verdict];
  const severity = finding.severity;
  return (
    <div className="rounded-[10px] border border-line bg-card px-3 py-2">
      <div className="flex items-center gap-[6px]">
        <Icon name={style.icon} size={12} className="shrink-0" />
        <span
          className={`shrink-0 rounded-full border px-[6px] py-[1px] text-[10px] ${style.className}`}
        >
          {t(style.label)}
        </span>
        {severity ? (
          <span
            className={`shrink-0 rounded-full px-[6px] py-[1px] text-[10px] ${SEVERITY_CLASS[severity] ?? "bg-chip text-tx3"}`}
          >
            {severity}
          </span>
        ) : null}
        {finding.independentlyVerified ? (
          <span className="ml-auto shrink-0 text-[10px] text-green">{t("audit.independent")}</span>
        ) : null}
      </div>
      <div className="mt-[6px] text-[12px] text-tx">{finding.title}</div>
      <p className="mt-[3px] text-[11px] leading-[1.55] text-tx2">{finding.summary}</p>
      {finding.evidence[0] ? (
        <div className="mt-[5px] font-mono text-[10px] text-tx3">
          {finding.evidence[0].file}:{finding.evidence[0].line}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onCreateTask(finding)}
        className="mt-[7px] rounded-[6px] px-2 py-[3px] text-[10px] text-tx3 hover:bg-hov hover:text-tx"
      >
        {t("audit.fixTask")}
      </button>
    </div>
  );
}
