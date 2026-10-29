import type { WorkerInfo, WorkerReport, WorkerReviewDecision } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";
import { i18n } from "../lib/i18n";

/** Koşu satırı: `agentRuns:list` kaydı + olaylardan gelen canlı rapor ve dosya listesi. */
export interface AgentRunRow extends WorkerInfo {
  /** Yapışkan özet: tamamlanan, süren ve kullanıcıyı bekleyen maddeler. */
  report?: WorkerReport;
  /** Koşunun değiştirdiği dosyalar (depo-göreli); bitiş olayından gelir. */
  files?: string[];
}

const EMPTY: AgentRunRow[] = [];

interface AgentRunsState {
  /** Ana oturum kimliği → o oturumun ayrık ajan koşuları (eskiden yeniye). */
  runs: Record<string, AgentRunRow[]>;
  /** İşlem süren koşu kimliği; satır düğmeleri bunu gösterir. */
  busy: string | null;
  /** İnceleme ekranında açık koşu ve diff'i; null ise kapalı. */
  diff: { sessionId: string; runId: string; text: string } | null;
  load: (sessionId: string) => Promise<void>;
  stop: (sessionId: string, runId: string) => Promise<void>;
  review: (sessionId: string, runId: string, decision: WorkerReviewDecision) => Promise<void>;
  loadDiff: (sessionId: string, runId: string) => Promise<void>;
  clearDiff: () => void;
}

/**
 * Ayrık ajan koşuları (arka plan / worktree). Liste oturum açılınca IPC'den gelir; satırların
 * canlı durumu `agent:event` üzerinden gelen `worker_*` olaylarıyla güncellenir. Olaylar ana
 * oturumun kimliğiyle akar, bu yüzden liste ana oturum başına tutulur.
 */
export const useAgentRuns = create<AgentRunsState>((set, get) => ({
  runs: {},
  busy: null,
  diff: null,
  load: async (sessionId) => {
    const list = await invoke("agentRuns:list", { sessionId });
    set((s) => {
      // Olaydan gelen rapor ve dosya listesi kayıtta yok; tazelemede kaybolmasın.
      const previous = new Map((s.runs[sessionId] ?? EMPTY).map((r) => [r.id, r]));
      const rows = list.map((run) => {
        const old = previous.get(run.id);
        return {
          ...run,
          ...(old?.report ? { report: old.report } : {}),
          ...(old?.files ? { files: old.files } : {}),
        };
      });
      return { runs: { ...s.runs, [sessionId]: rows } };
    });
  },
  stop: async (sessionId, runId) => {
    set({ busy: runId });
    try {
      await invoke("agentRuns:stop", { sessionId, runId });
    } finally {
      set({ busy: null });
    }
  },
  review: async (sessionId, runId, decision) => {
    set({ busy: runId });
    try {
      await invoke("agentRuns:review", { sessionId, runId, decision });
      const diff = get().diff;
      if (diff?.runId === runId) set({ diff: null });
      await get().load(sessionId);
    } finally {
      set({ busy: null });
    }
  },
  loadDiff: async (sessionId, runId) => {
    const { diff } = await invoke("agentRuns:diff", { sessionId, runId });
    set({ diff: { sessionId, runId, text: diff } });
  },
  clearDiff: () => set({ diff: null }),
}));

/** Oturumun koşuları; seçici her render'da yeni dizi üretmesin diye sabit boş dizi döner. */
export function selectRuns(sessionId: string) {
  return (s: AgentRunsState): AgentRunRow[] => s.runs[sessionId] ?? EMPTY;
}

function patchRun(sessionId: string, runId: string, patch: (row: AgentRunRow) => AgentRunRow) {
  const state = useAgentRuns.getState();
  const rows = state.runs[sessionId];
  if (!rows?.some((r) => r.id === runId)) return false;
  useAgentRuns.setState({
    runs: { ...state.runs, [sessionId]: rows.map((r) => (r.id === runId ? patch(r) : r)) },
  });
  return true;
}

function notify(title: string, body: string): void {
  void invoke("notify", { title, body }).catch(() => {});
}

/**
 * Koşu olayları: satırlar tam liste yerine olayla güncellenir, böylece canlı durum ve son eylem
 * tur beklemeden görünür. Bilinmeyen koşunun ilk olayı listeyi tazeler (satır kaydı IPC'dedir).
 */
on("agent:event", (event) => {
  switch (event.type) {
    case "worker_started":
      void useAgentRuns
        .getState()
        .load(event.sessionId)
        .catch(() => {});
      return;
    case "worker_status": {
      const rows = useAgentRuns.getState().runs[event.sessionId] ?? EMPTY;
      const row = rows.find((r) => r.id === event.workerId);
      // Onay beklemeye geçiş bildirilir; aynı durumda tekrar bildirilmez.
      if (event.status === "waiting" && row && row.status !== "waiting") {
        notify(i18n.t("agentRuns.notifyWaitingTitle"), row.title);
      }
      const known = patchRun(event.sessionId, event.workerId, (r) => ({
        ...r,
        status: event.status,
        ...(event.activity ? { activity: event.activity } : {}),
      }));
      if (!known) {
        void useAgentRuns
          .getState()
          .load(event.sessionId)
          .catch(() => {});
      }
      return;
    }
    case "worker_report":
      patchRun(event.sessionId, event.workerId, (r) => ({ ...r, report: event.report }));
      return;
    case "worker_ended": {
      const row = (useAgentRuns.getState().runs[event.sessionId] ?? EMPTY).find(
        (r) => r.id === event.workerId,
      );
      // Arka plan koşusu kullanıcının gözü önünde bitmeyebilir; bekletilen koşunun sonucu zaten
      // sohbete döner. Kullanıcının durdurduğu koşu haber gerektirmez.
      if (row?.background && event.info.status !== "cancelled") {
        const failed = event.info.status === "failed";
        notify(
          i18n.t(failed ? "agentRuns.notifyFailedTitle" : "agentRuns.notifyDoneTitle"),
          event.title,
        );
      }
      patchRun(event.sessionId, event.workerId, (r) => ({
        ...r,
        endedAt: event.at,
        files: event.info.files,
        ...(event.info.usage ? { usage: event.info.usage } : {}),
      }));
      // Son durum (`review`/`done`) ve sonuç özeti kayıttan gelir.
      void useAgentRuns
        .getState()
        .load(event.sessionId)
        .catch(() => {});
      return;
    }
    default:
      return;
  }
});
