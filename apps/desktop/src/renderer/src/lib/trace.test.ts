import type { AgentEvent, AgentEventInput } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  applyTrace,
  emptyTrace,
  MAX_TRACE_RECORDS,
  stepThroughput,
  stepTtft,
  type TraceRecord,
  type TraceState,
  type TraceStep,
  toolDuration,
  traceSummary,
} from "./trace";

const apply = (events: AgentEventInput[]): TraceState =>
  events.reduce((state, ev) => applyTrace(state, withTestEnvelope(ev)), emptyTrace());

/**
 * Test olaylarına zarfı ekler: gerçek akışta `AgentEventBus` bu alanları üretir; bus'sız kuran
 * testlerde sabit zarf yeterlidir çünkü iz katmanı sıra alanını kullanmaz.
 */
const withTestEnvelope = (e: AgentEventInput): AgentEvent =>
  ({ ...e, seq: 1, epoch: "test" }) as AgentEvent;

const runStart = (at: number): AgentEventInput => ({
  type: "run_start",
  sessionId: "s1",
  at,
  runId: "r1",
});
const text = (at: number, messageId = "m1"): AgentEventInput => ({
  type: "text_delta",
  sessionId: "s1",
  at,
  messageId,
  delta: "x",
});
const messageEnd = (at: number, stopReason = "endTurn"): AgentEventInput => ({
  type: "message_end",
  sessionId: "s1",
  at,
  messageId: "m1",
  text: "yanıt",
  model: "anthropic/claude",
  stopReason,
});
const toolStart = (at: number): AgentEventInput => ({
  type: "tool_start",
  sessionId: "s1",
  at,
  toolCallId: "t1",
  toolName: "bash",
  kind: "terminal",
  title: "ls",
});
const toolEnd = (at: number, isError = false): AgentEventInput => ({
  type: "tool_end",
  sessionId: "s1",
  at,
  toolCallId: "t1",
  isError,
});
const usage = (at: number, output = 100): AgentEventInput => ({
  type: "usage",
  sessionId: "s1",
  at,
  usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
});
const runEnd = (at: number, aborted = false): AgentEventInput => ({
  type: "run_end",
  sessionId: "s1",
  at,
  runId: "r1",
  aborted,
});

const steps = (state: TraceState): TraceStep[] =>
  state.records.filter((r): r is TraceStep => r.kind === "step");

describe("applyTrace", () => {
  it("ilk token'a kadar geçen süreyi TTFT olarak ölçer", () => {
    const state = apply([runStart(1000), text(1400), messageEnd(1900)]);
    const [step] = steps(state);
    expect(step?.at).toBe(1000);
    expect(step?.firstTokenAt).toBe(1400);
    expect(step?.endedAt).toBe(1900);
    expect(step && stepTtft(step)).toBe(400);
    expect(step?.model).toBe("anthropic/claude");
    expect(step?.stopReason).toBe("endTurn");
  });

  it("araç bitişinden sonraki isteği yeni adım sayar", () => {
    const state = apply([
      runStart(1000),
      text(1100),
      messageEnd(1200, "toolUse"),
      toolStart(1300),
      toolEnd(1600),
      text(2000, "m2"),
      messageEnd(2400),
      runEnd(2500),
    ]);
    const list = steps(state);
    expect(list).toHaveLength(2);
    const second = list[1];
    expect(second?.at).toBe(1600);
    expect(second && stepTtft(second)).toBe(400);
    const tool = state.records.find(
      (r): r is Extract<TraceRecord, { kind: "tool" }> => r.kind === "tool",
    );
    expect(tool && toolDuration(tool)).toBe(300);
  });

  it("araç hatasını kaydeder", () => {
    const state = apply([runStart(1), toolStart(2), toolEnd(3, true), runEnd(4)]);
    const tool = state.records.find((r) => r.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.isError : false).toBe(true);
  });

  it("kullanım bilgisini tamamlanan adıma bağlar ve tok/s hesaplar", () => {
    const state = apply([
      runStart(1000),
      text(2000),
      messageEnd(3000),
      usage(3100, 200),
      runEnd(3200),
    ]);
    const [step] = steps(state);
    expect(step?.usage?.output).toBe(200);
    // 200 token / (3000-2000 ms) = 200 tok/s
    expect(step && stepThroughput(step)).toBeCloseTo(200);
    const summary = traceSummary(state);
    expect(summary.steps).toBe(1);
    expect(summary.tokens.output).toBe(200);
    expect(summary.cost).toBeCloseTo(0.5);
    expect(summary.firstTtftMs).toBe(1000);
  });

  it("tur bitince açık araç ve tur kayıtlarını kapatır", () => {
    const state = apply([runStart(1000), toolStart(1100), runEnd(1500, true)]);
    const tool = state.records.find((r) => r.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.endedAt : null).toBe(1500);
    const run = state.records.find((r) => r.kind === "run");
    expect(run && run.kind === "run" ? run.aborted : false).toBe(true);
    expect(run && run.kind === "run" ? run.endedAt : null).toBe(1500);
  });

  it("kayıtları sınırlı tutar", () => {
    const events: AgentEventInput[] = [runStart(0)];
    for (let i = 0; i < MAX_TRACE_RECORDS + 50; i += 1) {
      events.push(text(i + 1, `m${i}`), messageEnd(i + 1));
    }
    const state = apply(events);
    expect(state.records).toHaveLength(MAX_TRACE_RECORDS);
  });

  it("hata ve yeniden deneme notlarını kaydeder", () => {
    const state = apply([
      runStart(1),
      {
        type: "retry",
        sessionId: "s1",
        at: 2,
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        message: "yoğunluk",
      },
      { type: "error", sessionId: "s1", at: 3, message: "kota doldu" },
    ]);
    expect(state.records.map((r) => r.kind)).toEqual(["run", "retry", "error"]);
  });

  it("kayıt üretmeyen olayda aynı durumu döner", () => {
    const state = apply([runStart(1)]);
    expect(
      applyTrace(
        state,
        withTestEnvelope({ type: "status", sessionId: "s1", at: 2, status: "idle" }),
      ),
    ).toBe(state);
  });
});
