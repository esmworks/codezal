import type { WorkerInfo } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const AGENT_LIST_TOOL = "agent_list";
export const AGENT_MESSAGE_TOOL = "agent_message";
export const AGENT_STOP_TOOL = "agent_stop";

/** Ayrık koşu yönetim araçları; her oturumda etkin (arka plan koşusu yoksa liste boş döner). */
export const AGENT_RUN_TOOLS: readonly string[] = [
  AGENT_LIST_TOOL,
  AGENT_MESSAGE_TOOL,
  AGENT_STOP_TOOL,
];

/** Araçların motor köprüsü; ana oturum kimliği bağlanırken kapanır. */
export interface AgentRunBridge {
  list(): WorkerInfo[];
  /** Koşu bulunamadı ya da bitmişse `false`. */
  message(runId: string, message: string): boolean;
  /** Koşu bulunamadı ya da bitmişse `false`. */
  stop(runId: string): boolean;
}

/** Koşu satırı: kimlik, ajan, ad, durum ve son eylem; model listeyi bununla okur. */
export function describeRun(run: WorkerInfo, lang: Locale = "tr"): string {
  const p = dict(lang).prompt;
  const bits = [`[${run.id}] ${run.agent} · ${run.title} — ${run.status}`];
  if (run.isolated) bits.push(p.agentRunIsolated);
  if (run.activity && run.status !== "review" && run.status !== "done") {
    bits.push(`${p.agentRunActivity}: ${run.activity}`);
  }
  if (run.filesChanged !== undefined) {
    bits.push(p.agentRunFiles.replace("{{count}}", String(run.filesChanged)));
  }
  if (run.error) bits.push(`${p.agentRunError}: ${run.error}`);
  return bits.join(" · ");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}

/**
 * Arka plan ve worktree ajan koşularını izleme araçları. Koşu `agent` aracıyla başlar; bu araçlar
 * durumunu okur, çalışan koşuyu yönlendirir ya da durdurur. Birleştirme kararı kullanıcınındır:
 * modele uygula/sil aracı verilmez.
 */
export function agentRunTools(bridge: AgentRunBridge, lang: Locale = "tr") {
  const d = dict(lang);
  const p = d.prompt;
  const label = d.agent.tool;
  return [
    defineTool({
      name: AGENT_LIST_TOOL,
      label: label.agentList,
      description: p.agentListDesc,
      parameters: Type.Object({}),
      async execute() {
        const runs = bridge.list();
        return text(
          runs.length === 0
            ? p.agentRunEmpty
            : runs.map((run) => describeRun(run, lang)).join("\n"),
        );
      },
    }),
    defineTool({
      name: AGENT_MESSAGE_TOOL,
      label: label.agentMessage,
      description: p.agentMessageDesc,
      parameters: Type.Object({
        run_id: Type.String({ minLength: 1, description: p.agentRunIdParam }),
        message: Type.String({ minLength: 1, maxLength: 4000, description: p.agentMessageParam }),
      }),
      async execute(_id, params) {
        const id = params.run_id.trim();
        const sent = bridge.message(id, params.message.trim());
        return text(sent ? `${p.agentMessageSent} ${id}` : `${p.agentRunMissing} ${id}`);
      },
    }),
    defineTool({
      name: AGENT_STOP_TOOL,
      label: label.agentStop,
      description: p.agentStopDesc,
      parameters: Type.Object({
        run_id: Type.String({ minLength: 1, description: p.agentRunIdParam }),
      }),
      async execute(_id, params) {
        const id = params.run_id.trim();
        const stopped = bridge.stop(id);
        return text(stopped ? `${p.agentStopRequested} ${id}` : `${p.agentRunMissing} ${id}`);
      },
    }),
  ];
}
