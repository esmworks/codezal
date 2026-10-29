import type { AgentInfo } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT_TYPE } from "./profile.js";

export const AGENT_TOOL = "agent";
/** Görev metninin üst sınırı; açıklamada modele söylenir (sınır gizli kalınca çağrı doğrulamada düşüyordu). */
export const AGENT_PROMPT_MAX = 8000;
/** Ana tura dönen özetin üst sınırı; alt ajanın amacı bağlamı küçültmektir. */
export const AGENT_MAX_CHARS = 16_000;
/** Alt koşu bu süreyi aşarsa durdurulur; ana tur yazma yetkili bir ajan yüzünden asılı kalmaz. */
export const AGENT_TIMEOUT_MS = 10 * 60_000;

/** Modelin dağıtım çağrısı; motor bunu ayrı bir oturumda çalıştırır. */
export interface AgentRunInput {
  /** Profil adı (`subagent_type`); boşsa gömülü genel ajan çalışır. */
  agentType: string;
  prompt: string;
  /** Koşu satırında görünen kısa görev adı; model vermezse istemin ilk satırı kullanılır. */
  description?: string;
  /** `true`: ana tur beklemez, koşu bitince ana oturum dürtülür. Verilmezse ajan tanımı karar verir. */
  background?: boolean;
  /**
   * `worktree`: koşu kendi git worktree'sinde çalışır. Verilmezse ajan tanımı ve otomatik karar
   * geçerlidir; yalıtımı kapatma seçeneği modele verilmez.
   */
  isolation?: "worktree";
  /** Ana transcript'teki araç çağrısı kimliği; canlı iz bu kimlikle karta bağlanır. */
  callId?: string;
  signal?: AbortSignal;
}

/** Alt ajanı çalıştırıp özet metnini döndüren köprü; engine `#agentRun` ile karşılar. */
export type AgentRunner = (input: AgentRunInput) => Promise<string>;

/** Sistem istemine giren ajan listesi: ad, açıklama ve araç kapsamı. */
function agentList(agents: AgentInfo[], lang: Locale): string {
  const d = dict(lang);
  return agents
    .map((agent) => {
      const tools =
        agent.tools && agent.tools.length > 0
          ? agent.tools.join(", ")
          : d.settings.agents.toolsAllSummary;
      // Tanımdaki varsayılan kip modele söylenir: çağrıda ayrıca istemesine gerek kalmaz.
      const flags = [
        agent.isolation === "worktree" ? d.prompt.agentFlagWorktree : "",
        agent.background ? d.prompt.agentFlagBackground : "",
      ].filter((flag) => flag !== "");
      return `- ${agent.name}: ${agent.description} (${tools})${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`;
    })
    .join("\n");
}

/**
 * Alt ajan dağıtım aracı. Model bir görevi adı verilen ajana devreder; görev ayrı bir oturumda,
 * ajanın sistem istemi, modeli ve araç kümesiyle çalışır ve ana tura yalnızca özet döner.
 * Araç listesi oturum açılışında verilir: Ajanlar sayfasında yapılan değişiklik oturum
 * tazelenince modele yansır.
 */
export function agentTool(run: AgentRunner, agents: AgentInfo[], lang: Locale = "tr") {
  const d = dict(lang);
  const names = agents.map((a) => a.name).join(", ");
  const description = [
    d.prompt.agentDesc,
    agents.length > 0 ? `\n${d.prompt.agentListHeader}\n${agentList(agents, lang)}` : "",
  ].join("");
  return defineTool({
    name: AGENT_TOOL,
    label: d.agent.tool.agent,
    description,
    promptSnippet: d.prompt.agentSnippet,
    promptGuidelines: [d.prompt.agentGuideline],
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        maxLength: AGENT_PROMPT_MAX,
        description: d.prompt.agentPrompt.replace("{{max}}", String(AGENT_PROMPT_MAX)),
      }),
      subagent_type: Type.Optional(
        Type.String({ description: d.prompt.agentType.replace("{{names}}", names) }),
      ),
      description: Type.Optional(
        Type.String({ maxLength: 120, description: d.prompt.agentDescription }),
      ),
      background: Type.Optional(Type.Boolean({ description: d.prompt.agentBackground })),
      isolation: Type.Optional(Type.Literal("worktree", { description: d.prompt.agentIsolation })),
    }),
    async execute(id, params, signal) {
      const agentType = params.subagent_type?.trim() || DEFAULT_AGENT_TYPE;
      const summary = (
        await run({
          agentType,
          prompt: params.prompt.trim(),
          ...(params.description ? { description: params.description.trim() } : {}),
          ...(params.background === undefined ? {} : { background: params.background }),
          ...(params.isolation ? { isolation: params.isolation } : {}),
          callId: id,
          ...(signal ? { signal } : {}),
        })
      ).trim();
      const text =
        summary.length > AGENT_MAX_CHARS ? `${summary.slice(0, AGENT_MAX_CHARS)}\n\n[…]` : summary;
      return {
        content: [{ type: "text", text: text || d.prompt.agentEmpty }],
        details: { agent: agentType, chars: summary.length },
      };
    },
  });
}
