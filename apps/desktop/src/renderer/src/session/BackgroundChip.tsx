import type { BackgroundJob, SubagentRun } from "@codezal/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { sessionJobs } from "../lib/jobs";
import { revealAgent } from "../lib/revealAgent";
import { selectRuns, useAgentRuns } from "../stores/agentRuns";
import { revealBackground } from "../stores/background";
import { useSessions } from "../stores/sessions";

const EMPTY_JOBS: BackgroundJob[] = [];
const EMPTY_RUNS: SubagentRun[] = [];

/**
 * Composer'ın sol ucundaki arka plan rozeti (ZCode'daki gibi): süren komut ve ajan sayısını
 * türüne göre ikonla yazar, hiçbiri yoksa görünmez. Yüzen kart dar pencerede ya da panel
 * açıkken çizilmediği için çalışan işin tek görünür izi budur; tıklamak ilk süren işin (komut
 * varsa komutun, yoksa ajanın) ayrıntısını "Arka plan işleri" sekmesinde açar.
 */
export function BackgroundChip({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const backgrounds = useSessions((s) => s.runtime[sessionId]?.backgrounds ?? EMPTY_JOBS);
  const subagents = useSessions((s) => s.runtime[sessionId]?.subagents ?? EMPTY_RUNS);
  const workers = useAgentRuns(selectRuns(sessionId));
  const bash = backgrounds.filter((b) => b.status === "running");
  const agents = sessionJobs(subagents, workers).filter(
    (r) => r.status === "running" || r.status === "queued",
  );
  if (bash.length === 0 && agents.length === 0) return null;

  const open = () => {
    const first = bash[0];
    if (first) revealBackground(sessionId, first.id);
    else if (agents[0]) revealAgent(sessionId, agents[0].traceId);
  };

  return (
    <button
      type="button"
      onClick={open}
      title={t("background.chipTitle")}
      aria-label={t("background.chipLabel", { bash: bash.length, agents: agents.length })}
      className="flex shrink-0 items-center gap-[8px] rounded-[7px] px-[7px] py-[3px] text-[12px] text-tx2 tabular-nums hover:bg-hov hover:text-tx"
    >
      {bash.length > 0 ? (
        <span className="flex items-center gap-[3px]">
          <Icon name="terminal" size={13} />
          {bash.length}
        </span>
      ) : null}
      {agents.length > 0 ? (
        <span className="flex items-center gap-[3px]">
          <Icon name="bot" size={13} />
          {agents.length}
        </span>
      ) : null}
    </button>
  );
}
