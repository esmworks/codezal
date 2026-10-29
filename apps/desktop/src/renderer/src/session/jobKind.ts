import type { TranslationKey } from "@codezal/i18n";
import type { AgentJobRow } from "../lib/jobs";

/** İşin tür etiketi: sağ paneldeki iş kartının ve ayrıntı satırının türü ("Keşif", "Avcı"). */
export const KIND_LABEL: Record<AgentJobRow["kind"], TranslationKey> = {
  explore: "agents.kindExplore",
  agent: "agents.kindAgent",
  "audit-hunter": "agents.kindHunter",
  "audit-verifier": "agents.kindVerifier",
  review: "agents.kindReview",
  "review-verifier": "agents.kindReviewVerifier",
  worker: "agents.kindWorker",
  background: "env.backgroundTitle",
};
