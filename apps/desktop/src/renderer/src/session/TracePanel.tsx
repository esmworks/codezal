import type { Locale } from "@codezal/i18n";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { copyWithToast } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { formatDuration, formatPercent, formatTokens, formatUsd } from "../lib/format";
import { useLocale } from "../lib/i18n";
import {
  emptyTrace,
  stepDuration,
  stepThroughput,
  stepTtft,
  type TraceRecord,
  type TraceState,
  toolDuration,
  traceSummary,
} from "../lib/trace";
import { useSessions } from "../stores/sessions";

/**
 * Oturum tanılama paneli ("··· > Tanılamayı göster").
 * Kayıtlar olay akışından türetilir (bkz. lib/trace.ts): istek başına TTFT ve üretim hızı,
 * araç çağrılarının süresi, tur toplamları ve maliyet. Hiçbiri sunucuda ayrıca ölçülmez.
 */

interface Row {
  key: string;
  time: string;
  kind: string;
  name: string;
  duration: string;
  ttft: string;
  speed: string;
  tokens: string;
  tone: "normal" | "muted" | "error" | "warn";
  /** Araç hatalarında sağda çarpı işareti gösterilir. */
  failed: boolean;
}

const DASH = "–";

/** Ortak satır ızgarası: başlık ve satırlar aynı sütun genişliklerini paylaşır. */
const GRID = "grid grid-cols-[62px_70px_minmax(0,1fr)_62px_56px_56px_74px] items-center gap-[8px]";

function clock(at: number, locale: Locale): string {
  return new Date(at).toLocaleTimeString(locale, { hour12: false });
}

function rowsOf(state: TraceState, locale: Locale, t: TFunction): Row[] {
  const rows: Row[] = [];
  for (const [index, record] of state.records.entries()) {
    const base = {
      key: `${index}-${record.kind}-${record.at}`,
      time: clock(record.at, locale),
      duration: DASH,
      ttft: DASH,
      speed: DASH,
      tokens: DASH,
      tone: "normal" as Row["tone"],
      failed: false,
    };
    rows.push({ ...base, ...describe(record, locale, t) });
  }
  return rows;
}

function describe(
  record: TraceRecord,
  locale: Locale,
  t: TFunction,
): Pick<Row, "kind" | "name" | "duration" | "ttft" | "speed" | "tokens" | "tone" | "failed"> {
  switch (record.kind) {
    case "run": {
      const ms = record.endedAt === null ? null : Math.max(0, record.endedAt - record.at);
      return {
        kind: t("trace.kindRun"),
        name: record.aborted ? t("trace.statusAborted") : t("trace.statusTurn"),
        duration: ms === null ? t("trace.statusRunning") : formatDuration(ms, locale),
        ttft: DASH,
        speed: DASH,
        tokens: DASH,
        tone: record.aborted ? "warn" : "muted",
        failed: false,
      };
    }
    case "step": {
      const usage = record.usage;
      return {
        kind: t("trace.kindStep"),
        name: [record.model ?? t("trace.modelUnknown"), record.stopReason ?? ""]
          .filter(Boolean)
          .join(" · "),
        duration: format(stepDuration(record), locale),
        ttft: format(stepTtft(record), locale),
        speed: speed(stepThroughput(record)),
        tokens: usage
          ? `${formatTokens(usage.input, locale)} / ${formatTokens(usage.output, locale)}`
          : DASH,
        tone: record.endedAt === null ? "muted" : "normal",
        failed: false,
      };
    }
    case "tool": {
      const ms = toolDuration(record);
      return {
        kind: t("trace.kindTool"),
        name: `${record.name} · ${record.toolKind}`,
        duration: ms === null ? t("trace.statusRunning") : formatDuration(ms, locale),
        ttft: DASH,
        speed: DASH,
        tokens: DASH,
        tone: record.isError ? "error" : ms === null ? "muted" : "normal",
        failed: record.isError,
      };
    }
    case "context":
      return {
        kind: t("trace.kindContext"),
        name: `${t("trace.contextWindow")}: ${formatPercent(record.percent, locale)}`,
        duration: DASH,
        ttft: DASH,
        speed: DASH,
        tokens: `${formatTokens(record.tokens, locale)} / ${formatTokens(record.contextWindow, locale)}`,
        tone: "muted",
        failed: false,
      };
    case "error":
      return {
        kind: t("trace.kindError"),
        name: record.text,
        duration: DASH,
        ttft: DASH,
        speed: DASH,
        tokens: DASH,
        tone: "error",
        failed: true,
      };
    case "retry":
      return {
        kind: t("trace.kindRetry"),
        name: `${record.text} — ${t("session.statusRetrying")}`,
        duration: DASH,
        ttft: DASH,
        speed: DASH,
        tokens: DASH,
        tone: "warn",
        failed: false,
      };
  }
}

function format(ms: number | null, locale: Locale): string {
  return ms === null ? DASH : formatDuration(ms, locale);
}

function speed(tokensPerSecond: number | null): string {
  return tokensPerSecond === null ? DASH : `${tokensPerSecond.toFixed(1)} tok/s`;
}

export function TracePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const trace = useSessions((s) => s.runtime[sessionId]?.trace);
  const state = trace ?? emptyTrace();
  const summary = useMemo(() => traceSummary(state), [state]);
  const rows = useMemo(() => rowsOf(state, locale, t), [state, locale, t]);
  const name = useSessions((s) => s.list.find((x) => x.id === sessionId)?.name ?? sessionId);

  const stats: Array<{ label: string; value: string }> = [
    { label: t("trace.statsTurns"), value: String(summary.runs) },
    { label: t("trace.statsSteps"), value: String(summary.steps) },
    {
      label: t("trace.statsTools"),
      value:
        summary.toolErrors > 0
          ? `${summary.tools} (${summary.toolErrors}✗)`
          : String(summary.tools),
    },
    { label: t("trace.statsTime"), value: formatDuration(summary.runMs, locale) },
    { label: t("trace.statsTtft"), value: format(summary.firstTtftMs, locale) },
    {
      label: t("trace.statsTtftAvg"),
      value:
        summary.avgTtftMs === null ? DASH : formatDuration(Math.round(summary.avgTtftMs), locale),
    },
    {
      label: t("trace.statsSpeed"),
      value: summary.throughput === null ? DASH : `${summary.throughput.toFixed(1)} tok/s`,
    },
    {
      label: t("trace.statsTokens"),
      value: `${formatTokens(summary.tokens.input, locale)} / ${formatTokens(summary.tokens.output, locale)}`,
    },
    { label: t("trace.statsCost"), value: formatUsd(summary.cost, locale) },
  ];

  /** Panoya giden metin: sürüm bilgisi Ayarlar > Tanılama'da eklenir; burada oturum özeti var. */
  const report = () => {
    const lines = [
      `Codezal — ${name} (${sessionId})`,
      `${t("trace.statsTurns")}: ${summary.runs}, ${t("trace.statsSteps")}: ${summary.steps}, ${t("trace.statsTools")}: ${summary.tools} (${summary.toolErrors}✗)`,
      `${t("trace.statsTime")}: ${formatDuration(summary.runMs, locale)}, ${t("trace.statsTtft")}: ${format(summary.firstTtftMs, locale)}, ${t("trace.statsSpeed")}: ${summary.throughput?.toFixed(1) ?? DASH} tok/s`,
      `${t("trace.statsTokens")}: ${summary.tokens.input} in / ${summary.tokens.output} out / ${summary.tokens.cacheRead} cache-read`,
      "",
      ...rows.map(
        (r) =>
          `${r.time}  ${r.kind.padEnd(8)}  ${r.name}  ${r.duration}  ${r.ttft}  ${r.speed}  ${r.tokens}`,
      ),
    ];
    copyWithToast(lines.join("\n"));
  };

  return (
    <Modal
      title={t("trace.title")}
      width={780}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 text-[12px] text-tx3">{t("trace.hint")}</span>
          <Button variant="secondary" onClick={report} disabled={rows.length === 0}>
            {t("trace.copy")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        <div className="grid grid-cols-3 gap-[8px] rounded-[12px] border border-line bg-card p-[12px]">
          {stats.map((s) => (
            <div key={s.label} className="flex flex-col gap-[2px]">
              <span className="text-[11px] text-tx3">{s.label}</span>
              <span className="font-mono text-[13px] text-tx">{s.value}</span>
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="py-[18px] text-center text-[13px] text-tx3">{t("trace.empty")}</div>
        ) : (
          <div className="flex flex-col gap-[2px]">
            <div className={`${GRID} px-[6px] pb-[4px] text-[11px] text-tx3`}>
              <span>{t("trace.colTime")}</span>
              <span>{t("trace.colKind")}</span>
              <span>{t("trace.colName")}</span>
              <span>{t("trace.colDuration")}</span>
              <span>{t("trace.colTtft")}</span>
              <span>{t("trace.colSpeed")}</span>
              <span>{t("trace.colTokens")}</span>
            </div>
            {rows.map((row) => (
              <div
                key={row.key}
                className={`${GRID} rounded-[8px] px-[6px] py-[5px] font-mono text-[12px] hover:bg-hov`}
              >
                <span className="text-tx3">{row.time}</span>
                <span className="truncate text-tx2">{row.kind}</span>
                <span
                  className={`flex items-center gap-[6px] truncate ${
                    row.tone === "error"
                      ? "text-red"
                      : row.tone === "warn"
                        ? "text-amber"
                        : row.tone === "muted"
                          ? "text-tx3"
                          : "text-tx"
                  }`}
                >
                  {row.failed ? <Icon name="x" size={12} stroke={2} /> : null}
                  <span className="truncate">{row.name}</span>
                </span>
                <span className="text-tx2">{row.duration}</span>
                <span className="text-tx2">{row.ttft}</span>
                <span className="text-tx2">{row.speed}</span>
                <span className="text-tx2">{row.tokens}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
