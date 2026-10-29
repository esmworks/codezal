import type { AssistantItem, SubagentRun, ToolCallItem, TranscriptItem } from "@codezal/contracts";
import type { Locale, TranslationKey } from "@codezal/i18n";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Working } from "../components/Working";
import { canStopAgent, stopAgentRow } from "../lib/agentActions";
import { formatElapsed, formatTokens, formatUsd } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { type AgentJobRow, sessionJobs } from "../lib/jobs";
import { planRun } from "../lib/toolGroups";
import { DiffView, reviewRun, toggleDiff } from "../session/AgentReviewPanel";
import { ToolCard, ToolGroup } from "../session/ToolCard";
import { selectRuns, useAgentRuns } from "../stores/agentRuns";
import { useAgents } from "../stores/agents";
import { useModels } from "../stores/models";
import { useSessions } from "../stores/sessions";
import { reportError } from "../stores/toast";
import { DetailHeader, durationOf, StatLine, titleOf } from "./jobParts";

/** Seçim yokken kullanılan sabit boş diziler: store seçicisi her render'da yeni referans üretmesin. */
const EMPTY: TranscriptItem[] = [];
const EMPTY_RUNS: SubagentRun[] = [];

/**
 * Pi'nin altı kademeli düşünme seviyesi arayüzün üç kademesine indirilir (motordaki
 * `#thinkingOf` ile aynı eşleme): kullanıcı ham "low"/"xhigh" yerine seçicideki adı görür.
 */
export function thinkingKey(level: string): TranslationKey {
  if (level === "off") return "agents.thinkingOff";
  if (level === "xhigh" || level === "max") return "thinkingLevel.max";
  if (level === "high" || level === "medium") return "thinkingLevel.high";
  return "thinkingLevel.low";
}

/** Küçük maliyetler "$0,000" diye sıfır görünmesin: bir milin altı üst sınırla yazılır. */
function costText(cost: number, lang: Locale): string {
  return cost < 0.001 ? `<${formatUsd(0.001, lang)}` : formatUsd(cost, lang);
}

interface Stat {
  label: string;
  value: string;
  /** Kırpılan değerin tamamı (ör. model kimliği); yoksa değerin kendisi ipucu olur. */
  title?: string;
}

/** Seçili koşunun ölçümleri; yalnız bilinen alanlar yazılır, boş hücre bırakılmaz. */
function statsOf(
  row: AgentJobRow,
  ctx: { now: number; lang: Locale; t: TFunction; modelName: string | undefined },
): Stat[] {
  const { now, lang, t, modelName } = ctx;
  const out: Stat[] = [];
  if (row.model)
    out.push({
      label: t("agents.statModel"),
      // Katalogda yoksa sağlayıcı öneki atılır: "deepseek/deepseek-v4.1-flash" → kimlik.
      value: modelName ?? row.model.slice(row.model.indexOf("/") + 1),
      title: row.model,
    });
  if (row.thinkingLevel)
    out.push({ label: t("agents.statThinking"), value: t(thinkingKey(row.thinkingLevel)) });
  const ms = durationOf(row, now);
  if (ms !== undefined)
    out.push({ label: t("agents.statDuration"), value: formatElapsed(ms, lang) });
  if (row.steps !== undefined) out.push({ label: t("agents.statSteps"), value: String(row.steps) });
  if (row.tokens) {
    const rate =
      row.status === "running" && row.tokensPerSec
        ? ` · ${t("agents.tokensPerSec", { rate: row.tokensPerSec })}`
        : "";
    out.push({ label: t("agents.statTokens"), value: `${formatTokens(row.tokens, lang)}${rate}` });
  }
  if (row.cost) out.push({ label: t("agents.statCost"), value: costText(row.cost, lang) });
  return out;
}

/** İnceleme bekleyen worktree koşusunun kararı: değişikliği incele, uygula ya da at. */
function ReviewActions({ sessionId, row }: { sessionId: string; row: AgentJobRow }) {
  const { t } = useTranslation();
  const busy = useAgentRuns((s) => (row.runId ? s.busy === row.runId : false));
  const runId = row.runId;
  if (runId && row.source === "worker" && row.droppable === false) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => toggleDiff(sessionId, runId)}>
          {t("agentRuns.inspect")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => reviewRun(sessionId, runId, "apply")}>
          {t("agentRuns.apply")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => reviewRun(sessionId, runId, "discard")}>
          {t("agentRuns.discard")}
        </Button>
      </div>
    );
  }
  return null;
}

/**
 * Tek ajanın ayrıntısı (Claude'daki "Background tasks" ayrıntısı): geri oklu başlık, ölçüm
 * satırı ("Model …"), balonda görev istemi, altında araç adımları ve ajanın raporu. Liste
 * "Arka plan işleri" sekmesindedir; geri oku oraya döner.
 *
 * İz iki kaynaktan gelir: yerli alt ajanlarda `useAgents.trace` (motordaki `subagent_trace`
 * olayı; biten koşularınki oturum açılışında da gelir), ayrık koşularda koşunun kendi oturum
 * transkripti. İkisi de aynı araç kartlarıyla
 * çizilir, böylece panel sohbet görünümünden kopuk durmaz.
 */
export function AgentDetail({
  sessionId,
  cwd,
  runId,
}: {
  sessionId: string;
  cwd: string;
  /** Koşunun iz kimliği (`AgentJobRow.traceId`): yerli alt ajanda koşu, worker'da oturum kimliği. */
  runId: string;
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  const subagents = useSessions((s) => s.runtime[sessionId]?.subagents ?? EMPTY_RUNS);
  const workers = useAgentRuns(selectRuns(sessionId));
  const diff = useAgentRuns((s) => s.diff);
  const busy = useAgentRuns((s) => s.busy);
  const trace = useAgents((s) => s.trace);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = sessionJobs(subagents, workers).find((r) => r.traceId === runId);
  const live = active?.status === "running";
  const modelName = useModels((s) =>
    active?.model
      ? s.catalog.find((c) => `${c.provider}/${c.id}` === active.model)?.name
      : undefined,
  );

  // Canlı süre sayacı: yalnız koşu sürerken kurulur.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Koşu oturumu bellekte yoksa aç: transkripti `sessions:open` ile gelir.
  const workerId = active?.source === "worker" ? active.traceId : "";
  useEffect(() => {
    if (!workerId) return;
    if (useSessions.getState().runtime[workerId]) return;
    // Açılamayan koşu oturumu boş ayrıntı bırakır; sebebi bildirimle söylenir.
    void useSessions.getState().open(workerId).catch(reportError);
  }, [workerId]);

  const workerItems = useSessions((s) =>
    active?.source === "worker" ? (s.runtime[active.traceId]?.transcript ?? EMPTY) : EMPTY,
  );
  // Yerli alt ajanın izi, koşu snapshot'tan düşse de bellekte durur: ayrıntı sonucu göstermeye devam eder.
  const items: TranscriptItem[] =
    active?.source === "worker" ? workerItems : (trace[runId]?.items ?? EMPTY);

  const steps = useMemo(() => {
    const run = items.filter(
      (i): i is ToolCallItem | AssistantItem => i.type === "tool" || i.type === "assistant",
    );
    return planRun(run, { live });
  }, [items, live]);

  // Yeni iz öğesi geldikçe en alta kaydır: canlı akış takip edilsin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || steps.length === 0 || !live) return;
    el.scrollTop = el.scrollHeight;
  }, [steps, live]);

  if (!active && items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailHeader title={t("panel.agent")} />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="bot" size={17} className="text-tx3" />
          <div className="text-[13px] font-medium text-tx2">{t("jobs.agentGone")}</div>
        </div>
      </div>
    );
  }

  const prompt = active?.task?.trim() ?? "";
  const stats = active ? statsOf(active, { now: live ? now : Date.now(), lang, t, modelName }) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        title={active ? titleOf(active) : t("panel.agent")}
        onStop={active && canStopAgent(active) ? () => stopAgentRow(sessionId, active) : undefined}
        stopDisabled={Boolean(active?.runId && busy === active.runId)}
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="flex flex-col gap-3 pt-1">
          <StatLine stats={stats} />
          {prompt ? (
            <div className="rounded-[12px] bg-card px-4 py-3 text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap text-tx">
              {prompt}
            </div>
          ) : null}
          {active ? <ReviewActions sessionId={sessionId} row={active} /> : null}
          {diff && active?.runId && diff.runId === active.runId ? (
            <DiffView text={diff.text} onClose={() => useAgentRuns.getState().clearDiff()} />
          ) : null}
        </div>
        <div className="mt-3">
          {items.length === 0 ? (
            live ? (
              <Working label={t("agents.starting")} className="py-2" />
            ) : (
              <div className="py-6 text-center text-[13px] text-tx3">{t("agents.noTrace")}</div>
            )
          ) : null}
          {steps.map((step, i) => {
            if (step.type === "assistant")
              return (
                <div key={`${step.item.id}-${i}`} className="py-[4px]">
                  <Markdown text={step.item.text.trim()} />
                </div>
              );
            if (step.type === "tool")
              return (
                <ToolCard
                  key={step.entry.anchorId}
                  item={step.entry.item}
                  attempts={step.entry.attempts}
                  cwd={cwd}
                />
              );
            return (
              <ToolGroup
                key={`g-${step.entries[0]?.anchorId ?? i}`}
                entries={step.entries}
                cwd={cwd}
                lang={lang}
                live={live}
              />
            );
          })}
          {/* Sohbetteki tur sonu göstergesiyle aynı: süren adımı araç satırı zaten söylüyor. */}
          {live && items.length > 0 ? (
            <Working label={active?.activity ?? t("agents.live")} spinnerOnly className="py-2" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
