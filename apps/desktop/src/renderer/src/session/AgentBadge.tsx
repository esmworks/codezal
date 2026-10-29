import type { SubagentRun } from "@codezal/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { revealAgent } from "../lib/revealAgent";
import { useSessions } from "../stores/sessions";

interface AgentBadgeValue {
  sessionId: string;
  /** Koşunun canlı izini sağ paneldeki Ajanlar sekmesinde açar. */
  open: (run: SubagentRun) => void;
}

const AgentBadgeContext = createContext<AgentBadgeValue | null>(null);

/**
 * Sohbetteki araç kartlarına alt ajan rozetini bağlar. Bağlam değeri yalnız `sessionId` ile
 * değişir (açma eylemi store'lardan doğrudan okunur); koşu verisi de buradan değil, her kartın
 * kendi seçicisinden gelir (`useAgentRun`). Böylece yeni bir alt ajan olayı yalnız ilgili kartı
 * yeniden çizer, bütün transcript'i değil.
 */
export function AgentBadgeProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const value = useMemo<AgentBadgeValue>(
    () => ({
      sessionId,
      open: (run) => revealAgent(sessionId, run.id),
    }),
    [sessionId],
  );
  return <AgentBadgeContext.Provider value={value}>{children}</AgentBadgeContext.Provider>;
}

/** Sağlayıcı yoksa (panel, önizleme) null döner: rozet çizilmez, kart davranışı değişmez. */
export function useAgentBadge(): AgentBadgeValue | null {
  return useContext(AgentBadgeContext);
}

/**
 * Araç çağrısına bağlı alt ajan koşusu. Zustand seçicisi koşu nesnesinin **referansını**
 * karşılaştırır: değişmeyen kartlar yeniden çizilmez.
 */
export function useAgentRun(toolCallId: string): SubagentRun | undefined {
  const sessionId = useContext(AgentBadgeContext)?.sessionId;
  return useSessions((s) => {
    if (!sessionId) return undefined;
    return s.runtime[sessionId]?.subagents.find((r) => r.parentToolCallId === toolCallId);
  });
}
