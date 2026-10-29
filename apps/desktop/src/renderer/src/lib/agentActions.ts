import { invoke } from "../api";
import { useAgentRuns } from "../stores/agentRuns";
import { humanizeError, toast } from "../stores/toast";
import type { AgentJobRow } from "./jobs";

/**
 * Satırdan durdurulabilir mi. Denetim ve inceleme alt ajanlarının durdurma yolu kendi
 * akışlarındadır; burada yalnız `agent` aracıyla başlayan koşular (keşif dahil) durdurulur.
 */
export function canStopAgent(row: AgentJobRow): boolean {
  return (
    (row.status === "running" || row.status === "queued") &&
    (row.source === "worker" || row.kind === "agent" || row.kind === "explore")
  );
}

/**
 * Koşuyu durdurur: bellekteki alt ajan ana turu kesmeden durur (kısmi sonuç döner), ayrık koşu
 * iptal edilir.
 */
export function stopAgentRow(sessionId: string, row: AgentJobRow): void {
  const done =
    row.source === "worker" && row.runId
      ? useAgentRuns.getState().stop(sessionId, row.runId)
      : invoke("subagents:stop", { sessionId, runId: row.traceId });
  void done.catch((e: unknown) => toast.error(humanizeError(e)));
}
