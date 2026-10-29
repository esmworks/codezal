import type { AgentEvent, Usage } from "@codezal/contracts";

/**
 * Oturum tanılama izi: olay akışından türetilen kayıtlar. Sunucu tarafında ek ölçüm yok; her olay
 * `at` taşıdığı için TTFT, adım süresi ve akış hızı burada hesaplanır (deepseek Trajectory deseni).
 * Yalnızca sınır olayları kayda girer (delta'lar girmez), böylece 400 kayıt bir oturumu özetler.
 */

export interface TraceStep {
  kind: "step";
  id: string;
  /** İstek sınırı: tur başlangıcı ya da son araç çağrısının bitişi. */
  at: number;
  /** İlk token (metin ya da düşünme) zamanı; hiç gelmediyse null. */
  firstTokenAt: number | null;
  endedAt: number | null;
  messageId: string;
  model?: string;
  stopReason?: string;
  usage?: Usage;
}

export interface TraceTool {
  kind: "tool";
  id: string;
  at: number;
  name: string;
  toolKind: string;
  endedAt: number | null;
  isError: boolean;
}

export interface TraceRun {
  kind: "run";
  id: string;
  at: number;
  endedAt: number | null;
  aborted: boolean;
}

export interface TraceContext {
  kind: "context";
  at: number;
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface TraceNote {
  kind: "error" | "retry";
  at: number;
  text: string;
  /** Sabit hata sebebi (varsa); tanı paketi bununla sayım yapar. */
  reason?: string | undefined;
}

export type TraceRecord = TraceStep | TraceTool | TraceRun | TraceContext | TraceNote;

export interface TraceState {
  records: TraceRecord[];
  /** Açık adım: token bekleyen istek. */
  openStep: string | null;
  /** Son istek sınırı (son araç bitişi); ilk token bunun üzerine adım açar. */
  pendingStart: number | null;
  seq: number;
}

/** Panelde bir oturum için tutulan en fazla kayıt; eskiler düşer. */
export const MAX_TRACE_RECORDS = 400;

export function emptyTrace(): TraceState {
  return { records: [], openStep: null, pendingStart: null, seq: 0 };
}

function push(state: TraceState, record: TraceRecord): TraceState {
  const records = [...state.records, record];
  return { ...state, records: records.slice(-MAX_TRACE_RECORDS), seq: state.seq + 1 };
}

function patchRecord(
  state: TraceState,
  id: string,
  fn: (record: TraceRecord) => TraceRecord,
): TraceState {
  const idx = state.records.findIndex((r) => "id" in r && r.id === id);
  if (idx < 0) return state;
  const records = state.records.slice();
  const current = records[idx];
  if (current) records[idx] = fn(current);
  return { ...state, records };
}

/** Olayı ize uygular; kayıt üretmeyen olaylarda aynı nesne döner (gereksiz render olmasın). */
export function applyTrace(state: TraceState, ev: AgentEvent): TraceState {
  switch (ev.type) {
    case "run_start": {
      const running = closeOpen(state, ev.at);
      const next = push(running, {
        kind: "run",
        id: ev.runId,
        at: ev.at,
        endedAt: null,
        aborted: false,
      });
      return { ...next, openStep: null, pendingStart: ev.at };
    }

    case "thinking_delta":
    case "text_delta": {
      const open = state.openStep ? findRecord(state, state.openStep) : null;
      // Aynı istekte ikinci delta: yalnızca TTFT zaten ölçülmemişse yazılır.
      if (open && open.kind === "step" && open.messageId === ev.messageId) {
        if (open.firstTokenAt !== null) return state;
        return patchRecord(state, open.id, (r) =>
          r.kind === "step" ? { ...r, firstTokenAt: ev.at } : r,
        );
      }
      // Yeni istek: adım ilk token'la doğar, başlangıcı son istek sınırından gelir.
      const id = `step-${state.seq + 1}`;
      const next = push(state, {
        kind: "step",
        id,
        at: state.pendingStart ?? ev.at,
        firstTokenAt: ev.at,
        endedAt: null,
        messageId: ev.messageId,
      });
      return { ...next, openStep: id, pendingStart: null };
    }

    case "message_end": {
      if (!state.openStep) return state;
      const id = state.openStep;
      const ended = patchRecord(state, id, (r) =>
        r.kind === "step"
          ? {
              ...r,
              endedAt: r.endedAt ?? ev.at,
              ...(ev.model ? { model: ev.model } : {}),
              ...(ev.stopReason ? { stopReason: ev.stopReason } : {}),
            }
          : r,
      );
      return { ...ended, openStep: null };
    }

    case "tool_start": {
      // message_end gelmediyse adım burada kapanır: araç çağrısı isteğin çıktısıdır.
      const closed = closeOpen(state, ev.at);
      const next = push(closed, {
        kind: "tool",
        id: ev.toolCallId,
        at: ev.at,
        name: ev.toolName,
        toolKind: ev.kind,
        endedAt: null,
        isError: false,
      });
      return { ...next, openStep: null };
    }

    case "tool_end": {
      const ended = patchRecord(state, ev.toolCallId, (r) =>
        r.kind === "tool" ? { ...r, endedAt: ev.at, isError: ev.isError } : r,
      );
      // Sıradaki istek bu andan sayılır; paralel araçlarda son biten kazanır.
      return { ...ended, pendingStart: ev.at };
    }

    case "usage": {
      const target = lastStepWithoutUsage(state);
      if (!target) return state;
      return patchRecord(state, target.id, (r) =>
        r.kind === "step" ? { ...r, usage: ev.usage } : r,
      );
    }

    case "context":
      return push(state, {
        kind: "context",
        at: ev.at,
        tokens: ev.tokens,
        contextWindow: ev.contextWindow,
        percent: ev.percent,
      });

    case "error":
      return push(state, {
        kind: "error",
        at: ev.at,
        text: ev.message,
        reason: ev.reason ?? "unknown",
      });

    case "retry":
      return push(state, { kind: "retry", at: ev.at, text: `${ev.attempt}/${ev.maxAttempts}` });

    case "run_end": {
      const closed = closeOpen(state, ev.at);
      // Tur biterken açık kalan araç kayıtları kapatılır; yoksa panelde sonsuz "çalışıyor" kalırdı.
      const records = closed.records.map((r) =>
        r.kind === "tool" && r.endedAt === null ? { ...r, endedAt: ev.at } : r,
      );
      const withRun = patchRecord({ ...closed, records }, ev.runId, (r) =>
        r.kind === "run" ? { ...r, endedAt: ev.at, aborted: ev.aborted } : r,
      );
      return { ...withRun, openStep: null, pendingStart: null };
    }

    default:
      return state;
  }
}

function findRecord(state: TraceState, id: string): TraceRecord | null {
  return state.records.find((r) => "id" in r && r.id === id) ?? null;
}

/** Açık adımı verilen anda kapatır (araç başlarken ya da tur bitince). */
function closeOpen(state: TraceState, at: number): TraceState {
  if (!state.openStep) return state;
  return patchRecord(state, state.openStep, (r) =>
    r.kind === "step" ? { ...r, endedAt: r.endedAt ?? at } : r,
  );
}

/** `usage` olayı isteğe aittir; henüz kullanım yazılmamış son adıma bağlanır. */
function lastStepWithoutUsage(state: TraceState): TraceStep | null {
  for (let i = state.records.length - 1; i >= 0; i -= 1) {
    const r = state.records[i];
    if (!r) continue;
    if (r.kind === "step" && !r.usage && r.firstTokenAt !== null) return r;
    if (r.kind === "run") break;
  }
  return null;
}

/** Adım süresi: istek sınırından yanıtın bitişine. */
export function stepDuration(step: TraceStep): number | null {
  return step.endedAt === null ? null : Math.max(0, step.endedAt - step.at);
}

/** TTFT: istek sınırından ilk token'a kadar geçen süre. */
export function stepTtft(step: TraceStep): number | null {
  return step.firstTokenAt === null ? null : Math.max(0, step.firstTokenAt - step.at);
}

/** Üretim hızı: yalnızca ilk token sonrası çıktı tokenı üzerinden. */
export function stepThroughput(step: TraceStep): number | null {
  if (!step.usage || step.firstTokenAt === null || step.endedAt === null) return null;
  const seconds = (step.endedAt - step.firstTokenAt) / 1000;
  if (seconds <= 0) return null;
  return step.usage.output / seconds;
}

export function toolDuration(tool: TraceTool): number | null {
  return tool.endedAt === null ? null : Math.max(0, tool.endedAt - tool.at);
}

export interface TraceSummary {
  runs: number;
  steps: number;
  tools: number;
  toolErrors: number;
  /** Tur başlangıç–bitiş toplamı; süren tur varsa hesaba katılmaz. */
  runMs: number;
  firstTtftMs: number | null;
  avgTtftMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  /** Adım bazlı ortalama üretim hızı (tok/s). */
  throughput: number | null;
  /**
   * Hata sebebine göre sayım (`quota_exhausted: 2`). Serbest metin sayılamaz: aynı hata her
   * seferinde farklı yazılır; sabit kod bu yüzden var.
   */
  errorReasons: Record<string, number>;
}

/** Panelin üst şeridi: toplamlar ve ortalamalar. */
export function traceSummary(state: TraceState): TraceSummary {
  let runs = 0;
  let steps = 0;
  let tools = 0;
  let toolErrors = 0;
  let runMs = 0;
  let firstTtftMs: number | null = null;
  let ttftTotal = 0;
  let ttftCount = 0;
  let throughputTotal = 0;
  let throughputCount = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  const errorReasons: Record<string, number> = {};

  for (const r of state.records) {
    if (r.kind === "run") {
      runs += 1;
      if (r.endedAt !== null) runMs += Math.max(0, r.endedAt - r.at);
    } else if (r.kind === "error") {
      const key = r.reason ?? "unknown";
      errorReasons[key] = (errorReasons[key] ?? 0) + 1;
    } else if (r.kind === "tool") {
      tools += 1;
      if (r.isError) toolErrors += 1;
    } else if (r.kind === "step") {
      steps += 1;
      const ttft = stepTtft(r);
      if (ttft !== null) {
        if (firstTtftMs === null) firstTtftMs = ttft;
        ttftTotal += ttft;
        ttftCount += 1;
      }
      const speed = stepThroughput(r);
      if (speed !== null) {
        throughputTotal += speed;
        throughputCount += 1;
      }
      if (r.usage) {
        tokens.input += r.usage.input;
        tokens.output += r.usage.output;
        tokens.cacheRead += r.usage.cacheRead;
        tokens.cacheWrite += r.usage.cacheWrite;
        cost += r.usage.cost;
      }
    }
  }

  return {
    runs,
    steps,
    tools,
    toolErrors,
    runMs,
    firstTtftMs,
    avgTtftMs: ttftCount > 0 ? ttftTotal / ttftCount : null,
    tokens,
    cost,
    throughput: throughputCount > 0 ? throughputTotal / throughputCount : null,
    errorReasons,
  };
}
