import type {
  LogLevel,
  LogLine,
  PerfMetric,
  PerfMetricSummary,
  PerfSummary,
} from "@codezal/contracts";
import { localeOf } from "@codezal/i18n";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, on } from "../../api";
import { Button } from "../../components/Button";
import { copyWithToast } from "../../components/CopyButton";
import { matchesFold } from "../../lib/searchText";
import { traceSummary } from "../../lib/trace";
import { useApp } from "../../stores/app";
import { useSessions } from "../../stores/sessions";
import { SegmentedTabs } from "../list";
import { ButtonRow, Row, Section, ToggleRow } from "../rows";
import type { Patch, S } from "./common";

/**
 * Tanılama: canlı günlük görüntüleyici + ayrıntılı günlük/olay izi anahtarları.
 *
 * Günlük main'deki halka tampondan gelir (`app:logTail`) ve `app:logWatch` açıkken canlı akar;
 * izleyici yokken yayın yapılmaz. "Tanı paketini kopyala" sürüm, yollar, aktif oturum izi ve
 * son günlük satırlarını panoya koyar. "Başarı ölçütleri" PRD 11 hedeflerini (açılış, araç kartı
 * gecikmesi) main'deki yerel ölçümlerle karşılaştırır.
 */

type Filter = "all" | LogLevel;

const LEVELS: Filter[] = ["all", "debug", "info", "warn", "error"];
const MAX_LINES = 500;
/** Rapor metnine giren en fazla günlük satırı. */
const REPORT_LINES = 200;

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "text-tx3",
  info: "text-tx2",
  warn: "text-amber",
  error: "text-red",
};

const PERF_ROWS = [
  {
    metric: "firstRender",
    label: "settings.diagnostics.perfFirstRenderLabel",
    desc: "settings.diagnostics.perfFirstRenderDesc",
  },
  {
    metric: "windowReady",
    label: "settings.diagnostics.perfWindowReadyLabel",
    desc: "settings.diagnostics.perfWindowReadyDesc",
  },
  {
    metric: "toolCard",
    label: "settings.diagnostics.perfToolCardLabel",
    desc: "settings.diagnostics.perfToolCardDesc",
  },
] as const satisfies ReadonlyArray<{ metric: PerfMetric; label: string; desc: string }>;

function formatMs(value: number | null, locale: string): string {
  if (value === null) return "–";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ms`;
}

function levelLabel(level: Filter, t: TFunction): string {
  if (level === "all") return t("settings.diagnostics.levelAll");
  if (level === "debug") return t("settings.diagnostics.levelDebug");
  if (level === "info") return t("settings.diagnostics.levelInfo");
  if (level === "warn") return t("settings.diagnostics.levelWarn");
  return t("settings.diagnostics.levelError");
}

export function DiagnosticsPage({ s, patch }: { s: S; patch: Patch }) {
  const { t, i18n } = useTranslation();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [version, setVersion] = useState<{ app: string; electron: string; pi: string } | null>(
    null,
  );
  const [paths, setPaths] = useState<{ logsDir: string; agentEventsDir: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [perf, setPerf] = useState<PerfSummary | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const activeId = useApp((a) => a.activeSessionId);
  const trace = useSessions((a) => (activeId ? a.runtime[activeId]?.trace : undefined));

  const loadPerf = () =>
    void invoke("perf:summary", undefined)
      .then(setPerf)
      .catch(() => undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: açılışta bir kez yüklenir
  useEffect(() => {
    loadPerf();
    void invoke("app:version", undefined)
      .then(setVersion)
      .catch(() => undefined);
    void invoke("app:paths", undefined)
      .then((p) => setPaths({ logsDir: p.logsDir, agentEventsDir: p.agentEventsDir }))
      .catch(() => undefined);
    void invoke("app:logTail", { lines: MAX_LINES })
      .then((r) => setLines(r.lines))
      .catch(() => undefined);
    const off = on("app:log", (line) => setLines((prev) => [...prev, line].slice(-MAX_LINES)));
    void invoke("app:logWatch", { on: true }).catch(() => undefined);
    return () => {
      off();
      void invoke("app:logWatch", { on: false }).catch(() => undefined);
    };
  }, []);

  const filtered = useMemo(() => {
    // Günlükler İngilizce kapsam adı taşır (`IPC`, `PTY`); Türkçe küçültme onları bozuyordu.
    const needle = query.trim();
    return lines.filter(
      (l) =>
        (filter === "all" || l.level === filter) &&
        (!needle || matchesFold(`${l.scope} ${l.message}`, needle)),
    );
  }, [lines, filter, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filtered değişince (yeni satır geldi) kaydır
  useEffect(() => {
    if (!follow) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [filtered, follow]);

  const copyReport = () => {
    const head = [
      `Codezal ${version?.app ?? "?"} · Electron ${version?.electron ?? "?"} · Pi ${version?.pi ?? "?"}`,
      `logs: ${paths?.logsDir ?? "?"}`,
      `agent-events: ${paths?.agentEventsDir ?? "?"}`,
    ];
    if (activeId && trace) {
      const sum = traceSummary(trace);
      head.push(
        `oturum: ${activeId} · tur ${sum.runs} · adım ${sum.steps} · araç ${sum.tools} (${sum.toolErrors}✗) · token ${sum.tokens.input} in / ${sum.tokens.output} out`,
      );
      // Hata sebepleri sabit kodlarla sayılır: "hangi hata ne sıklıkta" sorusunun cevabı
      // serbest metinden çıkarılamaz, koddan çıkar.
      const reasons = Object.entries(sum.errorReasons).sort((a, b) => b[1] - a[1]);
      if (reasons.length > 0) {
        head.push(`hatalar: ${reasons.map(([k, n]) => `${k}:${n}`).join(" · ")}`);
      }
    }
    if (perf) {
      const parts = perf.metrics.map(
        (m) => `${m.metric} p50=${m.p50 ?? "-"} p95=${m.p95 ?? "-"} n=${m.count} <${m.target}`,
      );
      head.push(`perf: ${parts.join(" · ")}${perf.packaged ? "" : " (dev)"}`);
    }
    const log = filtered
      .slice(-REPORT_LINES)
      .map(
        (l) => `${new Date(l.at).toISOString()} ${l.level.toUpperCase()} [${l.scope}] ${l.message}`,
      );
    copyWithToast(
      [...head, "", `--- ${t("settings.diagnostics.reportLog")} (${log.length}) ---`, ...log].join(
        "\n",
      ),
    );
  };

  return (
    <>
      <Section title={t("settings.diagnostics.logSection")}>
        <ToggleRow
          first
          label={t("settings.diagnostics.verboseLabel")}
          desc={t("settings.diagnostics.verboseDesc")}
          on={s.verboseLog}
          onChange={(v) => patch({ verboseLog: v })}
        />
        <ToggleRow
          label={t("settings.diagnostics.traceLabel")}
          desc={t("settings.diagnostics.traceDesc")}
          on={s.agentTraceLog}
          onChange={(v) => patch({ agentTraceLog: v })}
        />
        <ButtonRow
          label={t("settings.diagnostics.openLogsLabel")}
          desc={t("settings.diagnostics.openLogsDesc")}
          value={t("common.open")}
          onClick={() => void invoke("app:openLogs", undefined)}
        />
        <ButtonRow
          label={t("settings.diagnostics.openEventsLabel")}
          desc={t("settings.diagnostics.openEventsDesc")}
          value={t("common.open")}
          onClick={() => void invoke("app:openAgentEvents", undefined)}
        />
      </Section>

      <Section title={t("settings.diagnostics.viewerSection")}>
        <div className="flex flex-col gap-[10px] p-[14px]">
          <div className="flex flex-wrap items-center gap-[10px]">
            <SegmentedTabs
              value={filter}
              items={LEVELS.map((key) => ({ key, label: levelLabel(key, t) }))}
              onChange={setFilter}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("common.search")}
              className="h-[28px] min-w-[120px] flex-1 rounded-[8px] border border-line bg-bg px-[9px] text-[12px] text-tx outline-none placeholder:text-tx3"
            />
            <label className="flex items-center gap-[6px] text-[12px] text-tx2">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                className="accent-[var(--tx)]"
              />
              {t("settings.diagnostics.follow")}
            </label>
            <Button size="sm" variant="secondary" onClick={copyReport}>
              {t("settings.diagnostics.copyReport")}
            </Button>
          </div>

          <div
            ref={boxRef}
            className="h-[320px] overflow-auto rounded-[11px] border border-line bg-bg px-[10px] py-[8px] font-mono text-[11px] leading-[1.5]"
          >
            {filtered.length === 0 ? (
              <div className="py-3 text-center text-tx3">{t("settings.diagnostics.empty")}</div>
            ) : (
              filtered.map((l, index) => (
                <div key={`${l.at}-${index}`} className="whitespace-pre-wrap">
                  <span className="text-tx3">
                    {new Date(l.at).toLocaleTimeString(localeOf(i18n.language), {
                      hour12: false,
                    })}
                  </span>{" "}
                  <span className={LEVEL_STYLE[l.level]}>{l.level.toUpperCase().padEnd(5)}</span>{" "}
                  <span className="text-tx2">[{l.scope}]</span>{" "}
                  <span className="text-tx">{l.message}</span>
                </div>
              ))
            )}
          </div>
          <div className="text-[11px] text-tx3">
            {t("settings.diagnostics.count", { count: filtered.length, total: lines.length })}
          </div>
        </div>
      </Section>

      <Section title={t("settings.diagnostics.perfSection")}>
        <div className="flex items-start gap-5 px-[18px] py-[14px]">
          <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-tx3">
            {t("settings.diagnostics.perfDesc")}
            {perf && !perf.packaged ? (
              <div className="pt-[4px] text-amber">{t("settings.diagnostics.perfDevNote")}</div>
            ) : null}
          </div>
          <Button size="sm" variant="secondary" onClick={loadPerf}>
            {t("settings.diagnostics.perfRefresh")}
          </Button>
        </div>
        {PERF_ROWS.map((row) => (
          <Row key={row.metric} label={t(row.label)} desc={t(row.desc)}>
            <PerfValue
              summary={perf?.metrics.find((m) => m.metric === row.metric)}
              locale={localeOf(i18n.language)}
              t={t}
            />
          </Row>
        ))}
      </Section>

      <Section title={t("settings.diagnostics.envSection")}>
        <Row first label={t("settings.diagnostics.versionLabel")}>
          <span className="font-mono text-[12px] text-tx2">
            {version ? `${version.app} · Electron ${version.electron} · Pi ${version.pi}` : "…"}
          </span>
        </Row>
        <Row label={t("settings.diagnostics.logsPathLabel")}>
          <span className="font-mono text-[12px] text-tx3">{paths?.logsDir ?? "…"}</span>
        </Row>
        <Row label={t("settings.diagnostics.eventsPathLabel")}>
          <span className="font-mono text-[12px] text-tx3">{paths?.agentEventsDir ?? "…"}</span>
        </Row>
      </Section>
    </>
  );
}

/** Ölçüm hücresi: p50/p95 ve örnek sayısı, altında hedef ve sonuç (geçti/kaldı/ölçüm yok). */
function PerfValue({
  summary,
  locale,
  t,
}: {
  summary: PerfMetricSummary | undefined;
  locale: string;
  t: TFunction;
}) {
  if (!summary || summary.count === 0) {
    return <span className="text-[12px] text-tx3">{t("settings.diagnostics.perfNoData")}</span>;
  }
  const verdict = summary.pass
    ? { text: t("settings.diagnostics.perfPass"), tone: "text-green" }
    : { text: t("settings.diagnostics.perfFail"), tone: "text-red" };
  return (
    <div className="flex shrink-0 flex-col items-end gap-[2px] text-right">
      <span className="font-mono text-[12px] text-tx2">
        {t("settings.diagnostics.perfStats", {
          p50: formatMs(summary.p50, locale),
          p95: formatMs(summary.p95, locale),
          count: summary.count,
        })}
      </span>
      <span className="text-[12px] text-tx3">
        {t("settings.diagnostics.perfTarget", { target: formatMs(summary.target, locale) })}
        {" · "}
        <span className={`font-medium ${verdict.tone}`}>{verdict.text}</span>
      </span>
    </div>
  );
}
