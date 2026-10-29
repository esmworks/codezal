import type { BackgroundJob, SubagentRun } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { canStopAgent, stopAgentRow } from "../lib/agentActions";
import { useLocale } from "../lib/i18n";
import { type AgentJobRow, backgroundJobs, commandLine, sessionJobs } from "../lib/jobs";
import { revealAgent } from "../lib/revealAgent";
import { selectRuns, useAgentRuns } from "../stores/agentRuns";
import { useAgents } from "../stores/agents";
import { revealBackground, stopBackground } from "../stores/background";
import { usePanel } from "../stores/panel";
import { useSessions } from "../stores/sessions";
import { reportError } from "../stores/toast";
import { AgentDetail } from "./AgentsTab";
import { BackgroundDetail } from "./BackgroundTab";
import { isLive, JobCard, metaParts, titleOf, usageParts } from "./jobParts";

const EMPTY_JOBS: BackgroundJob[] = [];
const EMPTY_RUNS: SubagentRun[] = [];

/**
 * Temizlenen komutun gizleme anahtarı. Komut kimlikleri (`bg-N`) oturum içinde benzersizdir;
 * gizleme haritası oturumlar arası ortak olduğu için oturumla nitelenir.
 */
function bgHideKey(sessionId: string, jobId: string): string {
  return `bg:${sessionId}:${jobId}`;
}

/**
 * "Arka plan işleri" sekmesi (Claude'daki "Background tasks"): liste ve seçili işin ayrıntısı
 * aynı yüzeyde. Kart ayrıntıyı açar, ayrıntının geri oku listeye döner.
 */
export function JobsTab({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const job = usePanel((s) => s.job);
  if (job && job.sessionId === sessionId) {
    return job.kind === "agent" ? (
      <AgentDetail key={job.id} sessionId={sessionId} cwd={cwd} runId={job.id} />
    ) : (
      <BackgroundDetail key={job.id} sessionId={sessionId} jobId={job.id} />
    );
  }
  return <JobList sessionId={sessionId} />;
}

/**
 * İş listesi: "Çalışıyor" ve katlanır "Bitti" bölümleri; komutlar ve ajanlar aynı kartı paylaşır.
 * Komut listesi main'deki runner'dan gelir, bu yüzden tur başında yüzen karttan düşen biten
 * komutlar burada kalır.
 */
function JobList({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const lang = useLocale();
  const live = useSessions((s) => s.runtime[sessionId]?.backgrounds ?? EMPTY_JOBS);
  const subagents = useSessions((s) => s.runtime[sessionId]?.subagents ?? EMPTY_RUNS);
  const workers = useAgentRuns(selectRuns(sessionId));
  const hidden = useAgents((s) => s.hidden);
  const forget = useAgents((s) => s.forget);
  const [jobs, setJobs] = useState<BackgroundJob[]>(EMPTY_JOBS);
  const [now, setNow] = useState(() => Date.now());
  const [finishedOpen, setFinishedOpen] = useState(true);

  // Tetik anahtarı: yalnız bir komut başlayınca ya da bitince liste yeniden çekilir.
  const liveKey = live.map((j) => `${j.id}:${j.status}`).join("|");
  useEffect(() => {
    void liveKey;
    let alive = true;
    void invoke("background:list", { sessionId })
      .then((list) => {
        if (alive) setJobs(list);
      })
      // Liste çekilemezse canlı listeyle devam edilir ama hata yutulmaz.
      .catch((error: unknown) => {
        if (alive) reportError(error);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, liveKey]);

  const terms = backgroundJobs(jobs.length > 0 ? jobs : live).filter(
    (r) => !hidden[bgHideKey(sessionId, r.id)],
  );
  const agents = sessionJobs(subagents, workers).filter((r) => !hidden[r.traceId]);
  // Komutlar ve ajanlar tek listede: süren iş eskisi üstte, biten en yeni biten önce.
  const all = [...terms, ...agents];
  // Kuyruktaki (başlamamış) iş sürenlerin altında durur.
  const startKey = (r: AgentJobRow) =>
    r.status === "queued" ? Number.MAX_SAFE_INTEGER : (r.startedAt ?? Number.MAX_SAFE_INTEGER);
  const running = all.filter(isLive).sort((a, b) => startKey(a) - startKey(b));
  const finished = all
    .filter((r) => !isLive(r))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));

  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  if (all.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="list" size={17} className="text-tx3" />
        <div className="text-[13px] font-medium text-tx2">{t("jobs.emptyTitle")}</div>
        <p className="max-w-[280px] text-[12px] leading-[1.6] text-tx3">{t("jobs.emptyHint")}</p>
      </div>
    );
  }

  const card = (row: AgentJobRow) => {
    const bg = row.source === "background";
    return (
      <JobCard
        key={`${row.source}:${row.traceId}`}
        title={titleOf(row)}
        hint={row.task}
        // Açıklaması olmayan komutun başlığı komutun kendisidir: kod yazısıyla çizilir.
        mono={bg && row.task !== undefined && row.label === commandLine(row.task)}
        live={isLive(row)}
        meta={metaParts(row, now, lang, t)}
        usage={bg ? [] : usageParts(row, lang, t)}
        link={bg ? t("jobs.viewOutput") : t("jobs.viewTranscript")}
        onOpen={() =>
          bg ? revealBackground(sessionId, row.id) : revealAgent(sessionId, row.traceId)
        }
        onStop={
          bg
            ? row.status === "running"
              ? () => stopBackground(sessionId, row.id)
              : undefined
            : canStopAgent(row)
              ? () => stopAgentRow(sessionId, row)
              : undefined
        }
      />
    );
  };

  const clearFinished = () =>
    forget(
      sessionId,
      // İnceleme kararı bekleyen worktree koşusu temizlenmez: kararın verileceği tek yer burası.
      finished
        .filter((r) => !r.reviewing)
        .map((r) => (r.source === "background" ? bgHideKey(sessionId, r.id) : r.traceId)),
    );

  const heading = "flex h-8 items-center gap-[6px] px-1 text-[12.5px] text-tx3";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
      {running.length > 0 ? (
        <section>
          <div className={heading}>{t("jobs.running")}</div>
          <ul className="flex flex-col gap-[6px]">{running.map(card)}</ul>
        </section>
      ) : null}
      {finished.length > 0 ? (
        <section className={running.length > 0 ? "mt-3" : ""}>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setFinishedOpen(!finishedOpen)}
              aria-expanded={finishedOpen}
              className={`${heading} rounded-[6px] hover:text-tx`}
            >
              <span>{t("jobs.finished")}</span>
              <span className="tabular-nums">{finished.length}</span>
              <Icon name={finishedOpen ? "chevronDown" : "chevronRight"} size={12} stroke={2} />
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={clearFinished}
              title={t("jobs.clearFinished")}
              aria-label={t("jobs.clearFinished")}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          {finishedOpen ? <ul className="flex flex-col gap-[6px]">{finished.map(card)}</ul> : null}
        </section>
      ) : null}
    </div>
  );
}
