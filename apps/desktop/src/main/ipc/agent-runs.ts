import type { AppContext } from "../context.js";
import { handle } from "../ipc.js";

/**
 * Ajan koşusu kanalları. Koşular onları başlatan oturuma bağlıdır; her kanal ana oturum kimliğiyle
 * çağrılır. Koşunun izin istekleri ana oturumda sorulur ve mevcut `permissions:respond` ile yanıtlanır.
 */
export function registerAgentRunsIpc({ engine: eng }: AppContext): void {
  handle("agentRuns:list", ({ sessionId }) => eng.listAgentRuns(sessionId));

  handle("agentRuns:stop", ({ sessionId, runId }) => {
    eng.stopAgentRun(sessionId, runId);
  });

  handle("agentRuns:steer", ({ sessionId, runId, message }) => {
    eng.steerAgentRun(sessionId, runId, message);
  });

  handle("agentRuns:review", ({ sessionId, runId, decision }) =>
    eng.reviewAgentRun(sessionId, runId, decision),
  );

  // İnceleme ekranı: diff her açılışta taze çekilir (koşu çalışırken de değişebilir).
  handle("agentRuns:diff", async ({ sessionId, runId }) => ({
    diff: await eng.agentRunDiff(sessionId, runId),
  }));

  handle("background:list", ({ sessionId }) => eng.listBackground(sessionId));

  handle("background:output", ({ sessionId, jobId }) => eng.backgroundOutput(sessionId, jobId));

  handle("background:stop", ({ sessionId, jobId }) => eng.stopBackground(sessionId, jobId));

  handle("subagents:stop", ({ sessionId, runId }) => {
    eng.stopSubagent(sessionId, runId);
  });
}
