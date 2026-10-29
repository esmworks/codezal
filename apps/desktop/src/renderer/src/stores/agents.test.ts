import type { TranscriptItem } from "@codezal/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_TRACE_MAX, MAX_TRACE_RUNS, useAgents } from "./agents";

const tool = (id: string, status: "running" | "done" = "running"): TranscriptItem => ({
  type: "tool",
  id,
  toolName: "grep",
  kind: "search",
  status,
  title: "Arandı",
  startedAt: 1,
});

describe("agents store", () => {
  beforeEach(() => {
    useAgents.getState().reset();
  });

  it("iz öğelerini ekler ve aynı kimlikte günceller", () => {
    const { applyTrace } = useAgents.getState();
    applyTrace("s1", "run-1", tool("t1"));
    applyTrace("s1", "run-1", tool("t2"));
    expect(useAgents.getState().trace["run-1"]?.items.map((i) => i.id)).toEqual(["t1", "t2"]);

    applyTrace("s1", "run-1", tool("t1", "done"));
    expect(useAgents.getState().trace["run-1"]?.items).toHaveLength(2);
    expect(useAgents.getState().trace["run-1"]?.items[0]?.type).toBe("tool");
    const first = useAgents.getState().trace["run-1"]?.items[0];
    if (first?.type === "tool") expect(first.status).toBe("done");
  });

  it("açılış izlerini yükler; bellekteki canlı izi ve gizlenen koşuyu ezmez", () => {
    const { applyTrace, forget, seed } = useAgents.getState();
    applyTrace("s1", "canli", tool("t-canli", "done"));
    forget("s1", ["gizli"]);
    seed("s1", [
      { runId: "canli", items: [tool("eski")] },
      { runId: "gizli", items: [tool("g")] },
      { runId: "yeni", items: [tool("y", "done")] },
    ]);
    const { trace } = useAgents.getState();
    expect(trace.canli?.items.map((i) => i.id)).toEqual(["t-canli"]);
    expect(trace.gizli).toBeUndefined();
    expect(trace.yeni).toEqual({ sessionId: "s1", items: [tool("y", "done")] });
  });

  it("iz öğesi üst sınırını aşınca en eskileri düşer", () => {
    const { applyTrace } = useAgents.getState();
    for (let i = 0; i < AGENT_TRACE_MAX + 5; i += 1) applyTrace("s1", "run-1", tool(`t${i}`));
    const items = useAgents.getState().trace["run-1"]?.items ?? [];
    expect(items).toHaveLength(AGENT_TRACE_MAX);
    expect(items[0]?.id).toBe("t5");
    expect(items.at(-1)?.id).toBe(`t${AGENT_TRACE_MAX + 4}`);
  });

  it("iz sayısı üst sınırını aşınca en eski koşunun izi düşer", () => {
    for (let i = 0; i < MAX_TRACE_RUNS + 3; i += 1) {
      useAgents.getState().applyTrace("s1", `run-${i}`, tool(`t${i}`));
    }
    const keys = Object.keys(useAgents.getState().trace);
    expect(keys).toHaveLength(MAX_TRACE_RUNS);
    expect(keys[0]).toBe("run-3");
    expect(keys.at(-1)).toBe(`run-${MAX_TRACE_RUNS + 2}`);
  });

  it("seçimi tutar ve bitenleri temizlerken seçiliyi bırakır", () => {
    useAgents.getState().applyTrace("s1", "run-1", tool("t1"));
    useAgents.getState().select({ sessionId: "s1", runId: "run-1" });
    expect(useAgents.getState().selected).toEqual({ sessionId: "s1", runId: "run-1" });

    useAgents.getState().forget("s1", ["run-1"]);
    expect(useAgents.getState().trace["run-1"]).toBeUndefined();
    expect(useAgents.getState().hidden["run-1"]).toBe("s1");
    expect(useAgents.getState().selected).toBeNull();
  });

  it("temizlerken seçili olmayan koşunun seçimini korur", () => {
    useAgents.getState().applyTrace("s1", "run-1", tool("t1"));
    useAgents.getState().applyTrace("s1", "run-2", tool("t2"));
    useAgents.getState().select({ sessionId: "s1", runId: "run-2" });
    useAgents.getState().forget("s1", ["run-1"]);
    expect(useAgents.getState().selected).toEqual({ sessionId: "s1", runId: "run-2" });
  });

  it("oturum kapanınca yalnız o oturumun izlerini ve gizlemelerini bırakır", () => {
    useAgents.getState().applyTrace("s1", "run-1", tool("t1"));
    useAgents.getState().applyTrace("s2", "run-2", tool("t2"));
    useAgents.getState().forget("s1", ["run-1"]);
    useAgents.getState().select({ sessionId: "s1", runId: "run-1" });

    useAgents.getState().forgetSession("s1");
    expect(useAgents.getState().trace["run-1"]).toBeUndefined();
    expect(useAgents.getState().trace["run-2"]?.sessionId).toBe("s2");
    expect(useAgents.getState().hidden["run-1"]).toBeUndefined();
    expect(useAgents.getState().selected).toBeNull();
  });
});
