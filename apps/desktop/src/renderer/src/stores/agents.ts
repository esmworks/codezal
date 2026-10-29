import type { SubagentTrace, TranscriptItem } from "@codezal/contracts";
import { create } from "zustand";

/**
 * Koşu başına tutulan canlı iz öğesi üst sınırı. Uzun bir avcı turu yüzlerce araç çağrısı
 * üretebilir; panel son bölümü gösterir, bellek ve çizim maliyeti sabit kalır.
 */
export const AGENT_TRACE_MAX = 300;

/**
 * Aynı anda bellekte tutulan koşu izi üst sınırı. Uzun oturumda her koşu için bir girdi
 * birikmesin diye en eski iz düşer; gizleme (`forget`) ve oturum silme ana yollardır, bu
 * yalnız emniyet kemeridir.
 */
export const MAX_TRACE_RUNS = 40;

/** İz kaydı: hangi oturuma ait olduğu oturum kapanışında temizlik için gerekir. */
export interface AgentTraceEntry {
  sessionId: string;
  items: TranscriptItem[];
}

/** Panelde seçili koşu: yerli alt ajan için runId, worker için worker'ın oturum kimliği. */
export interface AgentSelection {
  sessionId: string;
  runId: string;
}

interface AgentsState {
  /**
   * runId → iz. Canlı akışla dolar; biten koşuların izi oturum açılışında motordan da gelir
   * (oturum dosyasında saklanır).
   */
  trace: Record<string, AgentTraceEntry>;
  /** Kullanıcının listeden düşürdüğü koşular (runId → oturum); motor snapshot'ı gelse de görünmez. */
  hidden: Record<string, string>;
  selected: AgentSelection | null;
  /** İz öğesi uygular: aynı kimlik varsa günceller, yoksa ekler (append semantiği). */
  applyTrace: (sessionId: string, runId: string, item: TranscriptItem) => void;
  /**
   * Oturum açılışındaki izleri yükler. Bellekte izi olan koşuya dokunulmaz (canlı akışın kırpılmamış
   * hâli daha zengin); kullanıcının listeden düşürdüğü koşu geri gelmez.
   */
  seed: (sessionId: string, traces: readonly SubagentTrace[]) => void;
  select: (selection: AgentSelection | null) => void;
  /** Biten koşuları listeden ve izlerden düşürür ("Bitenleri temizle"). */
  forget: (sessionId: string, runIds: string[]) => void;
  /** Oturum kapandığında/silindiğinde o oturumun tüm izlerini bırakır. */
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

/**
 * Alt ajan canlı izleri. Koşu başlıkları `SessionRuntime.subagents` içinde tutulur (oturum
 * bazlı); burada yalnız hacimli iz durur, böylece transcript indirgeyicisi şişmez.
 */
export const useAgents = create<AgentsState>((set, get) => ({
  trace: {},
  hidden: {},
  selected: null,

  applyTrace: (sessionId, runId, item) => {
    const current = get().trace[runId]?.items ?? [];
    const idx = current.findIndex((i) => i.id === item.id);
    let items: TranscriptItem[];
    if (idx >= 0) {
      items = current.slice();
      items[idx] = item;
    } else {
      items = [...current, item];
      if (items.length > AGENT_TRACE_MAX) items = items.slice(items.length - AGENT_TRACE_MAX);
    }
    const trace = { ...get().trace, [runId]: { sessionId, items } };
    // Emniyet kemeri: oturum boyunca her koşu için bir girdi birikmesin. Eski girdiler düşer
    // (nesne anahtarı sırası ekleme sırasıdır); gizlenen koşular zaten `forget` ile silinir.
    const ids = Object.keys(trace);
    if (ids.length > MAX_TRACE_RUNS) {
      for (const old of ids.slice(0, ids.length - MAX_TRACE_RUNS)) {
        if (old !== runId) delete trace[old];
      }
    }
    set({ trace });
  },
  seed: (sessionId, traces) => {
    const { trace, hidden } = get();
    const fresh = traces.filter((t) => !(t.runId in trace) && !(t.runId in hidden));
    if (fresh.length === 0) return;
    const next = { ...trace };
    for (const t of fresh) next[t.runId] = { sessionId, items: t.items.slice(-AGENT_TRACE_MAX) };
    const ids = Object.keys(next);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_TRACE_RUNS))) delete next[old];
    set({ trace: next });
  },
  select: (selected) => set({ selected }),

  forget: (sessionId, runIds) => {
    const trace = { ...get().trace };
    const hidden = { ...get().hidden };
    for (const id of runIds) {
      delete trace[id];
      hidden[id] = sessionId;
    }
    const selected = get().selected;
    set({
      trace,
      hidden,
      selected: selected && runIds.includes(selected.runId) ? null : selected,
    });
  },

  forgetSession: (sessionId) => {
    const trace: Record<string, AgentTraceEntry> = {};
    for (const [runId, entry] of Object.entries(get().trace)) {
      if (entry.sessionId !== sessionId) trace[runId] = entry;
    }
    const hidden: Record<string, string> = {};
    for (const [runId, owner] of Object.entries(get().hidden)) {
      if (owner !== sessionId) hidden[runId] = owner;
    }
    const selected = get().selected;
    set({ trace, hidden, selected: selected?.sessionId === sessionId ? null : selected });
  },

  reset: () => set({ trace: {}, hidden: {}, selected: null }),
}));
