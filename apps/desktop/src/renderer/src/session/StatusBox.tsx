import type { BackgroundJob, SubagentRun } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";
import { canStopAgent, stopAgentRow } from "../lib/agentActions";
import { formatElapsed } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { type AgentJobRow, backgroundJobs, compactLabel, sessionJobs } from "../lib/jobs";
import { revealAgent, revealJobs } from "../lib/revealAgent";
import { useCollapseOnDone } from "../lib/useCollapseOnDone";
import { selectRuns, useAgentRuns } from "../stores/agentRuns";
import { revealBackground, stopBackground } from "../stores/background";

/** Bölümde gösterilen en fazla satır; fazlası sağ paneldeki sekmede listelenir. */
const MAX_ROWS = 6;

/** Satırın alt çizgisindeki metin ve tonu ("1 dk 12 sn süredir çalışıyor", "çıkış 0"). */
interface Meta {
  text: string;
  tone: string;
}

/**
 * İş satırı (ZCode'un durum paneli satırı): tür ikonu, iki satıra sığan başlık, altında durum
 * ve süren işte Durdur. Terminal ve ajan satırları aynı biçimi paylaşır. Satırın tamamı işi sağ
 * panelde açar; Durdur bunun üstünde ayrı katmanda durur ki tıklaması satırı açmasın.
 */
function WorkRow({
  icon,
  live,
  title,
  hint,
  meta,
  openLabel,
  onOpen,
  onStop,
}: {
  icon: IconName;
  live: boolean;
  title: string;
  /** Kırpılan başlığın tamamı (tam komut, ajanın görev metni). */
  hint: string;
  meta: Meta;
  openLabel: string;
  onOpen: () => void;
  onStop?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <li className="relative flex min-w-0 items-start gap-[9px] rounded-[9px] px-2 py-[7px] hover:bg-hov">
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={hint}
        className="absolute inset-0 rounded-[9px]"
      />
      <Icon
        name={icon}
        size={14}
        className={`pointer-events-none relative mt-[2px] shrink-0 ${live ? "text-tx2" : "text-tx3"}`}
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="line-clamp-2 text-[13px] leading-[1.5] break-words text-tx">{title}</p>
        <div className="flex min-h-[22px] min-w-0 items-center gap-2 text-[12.5px]">
          <span className={`min-w-0 flex-1 truncate tabular-nums ${meta.tone}`}>{meta.text}</span>
          {onStop ? (
            <button
              type="button"
              onClick={onStop}
              title={t("background.stopTitle")}
              className="pointer-events-auto relative z-[2] flex h-[22px] shrink-0 items-center gap-[5px] rounded-[6px] px-[7px] text-tx2 hover:bg-line2 hover:text-tx"
            >
              <Icon name="stop" size={10} fill />
              {t("background.stop")}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * Katlanır bölüm başlığı (ZCode'daki "Terminals · 1 in background"): soluk başlık, üzerine
 * gelince görünen ok ve ölçü. Katlıyken ölçü en uzun süren işin süresini de yazar.
 */
function Section({
  title,
  meta,
  open,
  onToggle,
  first,
  children,
}: {
  title: string;
  meta: { text: string; tone: string };
  open: boolean;
  onToggle: () => void;
  first: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={first ? "" : "mt-1 border-t border-line pt-1"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex h-8 w-full min-w-0 items-center gap-[6px] px-2 text-left"
      >
        <span className="shrink-0 text-[14px] font-medium text-tx2">{title}</span>
        <Icon
          name={open ? "chevronDown" : "chevronRight"}
          size={12}
          stroke={2}
          className="shrink-0 text-tx3 opacity-0 transition-opacity group-hover:opacity-100"
        />
        <span className={`min-w-0 truncate text-[13px] tabular-nums ${meta.tone}`}>
          {meta.text}
        </span>
      </button>
      {open ? (
        <ul className="flex max-h-[288px] flex-col gap-[2px] overflow-y-auto">{children}</ul>
      ) : null}
    </section>
  );
}

/**
 * Durum kartı (ZCode'un yüzen durum paneli): arka plan komutları "Terminaller", alt ajanlar ve
 * ayrık koşular "Ajanlar" bölümünde, aynı satır biçimiyle listelenir. Boş bölüm çizilmez; iki
 * bölüm de boşsa kart yoktur. Bölüm, işleri bitince kendiliğinden katlanır; biten satır kısa bir
 * "bitti" geri bildiriminden (`DONE_LINGER_MS`) sonra düşer, ayrıntısı sağ panelde kalır.
 */
export function StatusBox({
  sessionId,
  backgrounds,
  subagents,
}: {
  sessionId: string;
  backgrounds: BackgroundJob[];
  subagents: SubagentRun[];
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  const workers = useAgentRuns(selectRuns(sessionId));
  const [now, setNow] = useState(() => Date.now());
  const [termOpen, setTermOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const terms = backgroundJobs(backgrounds, { now });
  const agents = sessionJobs(subagents, workers, { now });
  const termLive = terms.filter((r) => r.status === "running");
  const agentLive = agents.filter((r) => r.status === "running" || r.status === "queued");
  // Süren satırın sayacı ve biten satırın ömrü saatle ilerler; boş kartta saat kurulmaz.
  const needClock = terms.length + agents.length > 0;
  useEffect(() => {
    if (!needClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [needClock]);
  useCollapseOnDone(terms.length > 0 && termLive.length === 0, setTermOpen);
  // Kullanıcı kararı bekleyen worktree satırı "bitmiş" sayılmaz: bölüm onu gizleyip katlanmasın.
  useCollapseOnDone(
    agents.length > 0 && agentLive.length === 0 && !agents.some((r) => r.reviewing),
    setAgentOpen,
  );
  if (terms.length === 0 && agents.length === 0) return null;

  const elapsed = (r: AgentJobRow): string =>
    formatElapsed(Math.max(0, now - (r.startedAt ?? now)), lang);
  const runningFor = (r: AgentJobRow): Meta => ({
    text: r.startedAt === undefined ? "" : t("background.runningFor", { time: elapsed(r) }),
    tone: "text-tx3",
  });
  /** Bölüm ölçüsü: süren iş sayısı; katlıyken önüne en eski süren işin süresi eklenir. */
  const sectionMeta = (rows: AgentJobRow[], live: AgentJobRow[], count: string, open: boolean) => {
    if (live.length === 0)
      return rows.every((r) => r.status === "done")
        ? { text: "✓", tone: "text-green" }
        : { text: "", tone: "text-tx3" };
    const oldest = live.find((r) => r.startedAt !== undefined);
    return {
      text: !open && oldest ? `${elapsed(oldest)} · ${count}` : count,
      tone: "text-tx3",
    };
  };

  const termMeta = (r: AgentJobRow): Meta => {
    if (r.status === "running") return runningFor(r);
    if (r.status === "done")
      return {
        text: r.code !== undefined ? t("env.agentExit", { code: r.code }) : t("background.done"),
        tone: r.code === undefined || r.code === 0 ? "text-green" : "text-tx2",
      };
    if (r.status === "error") return { text: t("env.agentFailed"), tone: "text-tx2" };
    return { text: t("env.agentStopped"), tone: "text-tx3" };
  };
  const agentMeta = (r: AgentJobRow): Meta => {
    // Worker izin/soru bekliyorsa süre yerine bunu söyle: kullanıcı neyi beklediğini görsün.
    if (r.waiting) return { text: t("env.agentWaiting"), tone: "text-tx2" };
    if (r.reviewing) return { text: t("env.agentReview"), tone: "text-accTx" };
    if (r.status === "queued") return { text: t("env.agentQueued"), tone: "text-tx3" };
    if (r.status === "running") return runningFor(r);
    if (r.status === "done") return { text: t("agents.done"), tone: "text-green" };
    if (r.status === "error") return { text: t("env.agentFailed"), tone: "text-tx2" };
    return { text: t("env.agentStopped"), tone: "text-tx3" };
  };

  return (
    <div className="overflow-hidden rounded-[14px] border border-line2 bg-card p-[6px]">
      {terms.length > 0 ? (
        <Section
          first
          title={t("background.terminalsTitle")}
          meta={sectionMeta(
            terms,
            termLive,
            t("background.running", { count: termLive.length }),
            termOpen,
          )}
          open={termOpen}
          onToggle={() => setTermOpen(!termOpen)}
        >
          {terms.slice(0, MAX_ROWS).map((r) => (
            <WorkRow
              key={r.id}
              icon="terminal"
              live={r.status === "running"}
              title={r.label}
              hint={r.task ?? r.label}
              meta={termMeta(r)}
              openLabel={t("background.viewOutput", { command: r.label })}
              onOpen={() => revealBackground(sessionId, r.id)}
              onStop={r.status === "running" ? () => stopBackground(sessionId, r.id) : undefined}
            />
          ))}
        </Section>
      ) : null}
      {agents.length > 0 ? (
        <Section
          first={terms.length === 0}
          title={t("env.agentsTitle")}
          meta={sectionMeta(
            agents,
            agentLive,
            t("env.agentsRunning", { count: agentLive.length }),
            agentOpen,
          )}
          open={agentOpen}
          onToggle={() => setAgentOpen(!agentOpen)}
        >
          {agents.slice(0, MAX_ROWS).map((r) => (
            <WorkRow
              key={`${r.source}:${r.traceId}`}
              icon="bot"
              live={r.status === "running"}
              title={compactLabel(r.label, 90, lang)}
              hint={r.task ?? r.label}
              meta={agentMeta(r)}
              openLabel={t("background.viewAgent", { name: r.label })}
              onOpen={() => revealAgent(sessionId, r.traceId)}
              onStop={canStopAgent(r) ? () => stopAgentRow(sessionId, r) : undefined}
            />
          ))}
        </Section>
      ) : null}
      {/* ZCode'daki "Ended … N ›" satırının karşılığı: bitenler dahil bütün işler dizinde. */}
      <button
        type="button"
        onClick={revealJobs}
        className="mt-1 flex h-8 w-full items-center gap-[6px] border-t border-line px-2 pt-1 text-left text-[13px] text-tx3 hover:text-tx"
      >
        <Icon name="list" size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("jobs.all")}</span>
        <Icon name="chevronRight" size={12} stroke={2} className="shrink-0" />
      </button>
    </div>
  );
}
