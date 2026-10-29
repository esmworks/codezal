import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Kalıcı hedef (`/goal`) yardımcıları.
 *
 * Direktif bilinçli olarak sistem promptuna DEĞİL, her turda gizli kullanıcı mesajıyla taşınır:
 * sayaç her tur değiştiği için sistem promptuna konursa önbellek her tur bozulurdu. Kullanıcı
 * mesajı konuşmanın sonunda olduğu için yalnızca kuyruk yeniden değerlendirilir.
 */

/** Model hedefi tamamen bitirdiğinde son mesajını tek başına bu satırla bitirmeli. */
export const GOAL_DONE_TOKEN = "[GOAL_DONE]";
/** Hedef imkânsız ya da kullanıcı girdisi bekliyorsa bu satırla bitirir. */
export const GOAL_BLOCKED_TOKEN = "[GOAL_BLOCKED]";

// Legacy ile aynı: yalnızca kendi satırında geçen sentinel sayılır; metin ortasında anılan
// token örnekleri (doküman, açıklama) döngüyü tetiklememeli.
export const GOAL_DONE_RE = /^[ \t]*\[GOAL_DONE\][ \t]*$/m;
export const GOAL_BLOCKED_RE = /^[ \t]*\[GOAL_BLOCKED\]/m;

export interface GoalDirectiveInput {
  text: string;
  /** Geçen otomatik devam sayısı; gösterimde +1'li durum bildirilir. */
  iter: number;
  maxIter: number;
  paused?: boolean;
}

/** Modele verilen ACTIVE GOAL direktif bloğu (model istemi olduğu için İngilizce). */
export function buildGoalDirective(g: GoalDirectiveInput): string {
  if (g.paused) {
    return [
      "## ACTIVE GOAL (PAUSED)",
      `User-defined persistent goal: ${g.text}`,
      `Iteration: ${g.iter}/${g.maxIter}`,
      "",
      "This goal is currently PAUSED by the user. Do NOT pursue it autonomously and do NOT emit `[GOAL_DONE]` or `[GOAL_BLOCKED]` — the harness will NOT auto-continue while paused. Address the user's current message normally; the goal stays on hold until the user resumes it.",
    ].join("\n");
  }
  return [
    "## ACTIVE GOAL",
    `User-defined persistent goal: ${g.text}`,
    `Iteration: ${g.iter + 1}/${g.maxIter}`,
    "",
    "Work autonomously toward this goal across multiple turns. After every assistant turn the harness will automatically send `Continue.` until you signal completion.",
    "",
    "Completion protocol:",
    `- When the goal is FULLY complete (all subtasks done, verification passed), end your final assistant message with the exact token \`${GOAL_DONE_TOKEN}\` on its own line. The harness greps for this token — anything else will trigger another iteration.`,
    "- If the goal is impossible, blocked, or requires user input you cannot resolve, end your message with `[GOAL_BLOCKED]` and explain what is needed.",
    "- Do NOT emit either sentinel while work remains. Do NOT emit them speculatively.",
    "- If you hit the iteration cap, the harness will stop the loop and surface a notice to the user — no action needed from you.",
  ].join("\n");
}

export type GoalSentinel = "done" | "blocked";

/** Son asistan mesajındaki sentinel; yok ya da mesaj asistan değilse undefined. */
export function analyzeGoalEnd(messages: readonly AgentMessage[]): GoalSentinel | undefined {
  const last = findLastAssistant(messages);
  if (!last) return undefined;
  const text = textOf(last);
  if (GOAL_DONE_RE.test(text)) return "done";
  if (GOAL_BLOCKED_RE.test(text)) return "blocked";
  return undefined;
}

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m as AssistantMessage;
  }
  return undefined;
}

function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}
