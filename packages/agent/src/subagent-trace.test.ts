import type { AgentEvent, SubagentRun } from "@codezal/contracts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentEventBus } from "./event-bus.js";
import {
  clipTrace,
  MAX_FINISHED_RUNS,
  RATE_WINDOW_MS,
  SUBAGENT_RUN_TYPE,
  type SubagentRecord,
  SubagentTracker,
  subagentRecordsOf,
  TOOL_UPDATE_MIN_MS,
  TRACE_KEEP_CHARS,
  TRACE_KEEP_ITEMS,
  TRACE_OUTPUT_MAX,
} from "./subagent-trace.js";

/** Sahte alt oturum: dinleyiciyi tutar, test istediğinde olay pompalar. */
function fakeSession() {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    session: {
      subscribe(fn: (event: AgentSessionEvent) => void) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    emit(event: AgentSessionEvent) {
      listener?.(event);
    },
  };
}

const toolStart = (toolCallId: string, toolName: string, args: Record<string, unknown> = {}) =>
  ({ type: "tool_execution_start", toolCallId, toolName, args }) as unknown as AgentSessionEvent;

const toolEnd = (toolCallId: string, toolName: string, result: unknown, isError = false) =>
  ({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError,
  }) as unknown as AgentSessionEvent;

const toolUpdate = (toolCallId: string, output: string) =>
  ({
    type: "tool_execution_update",
    toolCallId,
    partialResult: { content: [{ type: "text", text: output }] },
  }) as unknown as AgentSessionEvent;

const assistantEnd = (text: string, outputTokens: number) =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 10,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
      model: "test-model",
      provider: "test",
      stopReason: "stop",
      timestamp: 0,
    },
  }) as unknown as AgentSessionEvent;

function harness() {
  let now = 1_000;
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const tracker = new SubagentTracker(bus, "s1", "tr", () => now);
  const snapshots = () =>
    events.filter((e) => e.type === "subagents").map((e) => (e.type === "subagents" ? e.runs : []));
  const traces = () =>
    events.flatMap((e) => (e.type === "subagent_trace" ? [{ runId: e.runId, item: e.item }] : []));
  const lastRun = (): SubagentRun | undefined => snapshots().at(-1)?.at(-1);
  return {
    tracker,
    events,
    snapshots,
    traces,
    lastRun,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SubagentTracker (kalıcı iz)", () => {
  function persisting() {
    const bus = new AgentEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const records: SubagentRecord[] = [];
    let now = 1_000;
    const tracker = new SubagentTracker(bus, "s1", "tr", () => now, {
      onFinish: (record) => records.push(record),
    });
    const lastRuns = () => events.filter((e) => e.type === "subagents").at(-1);
    return {
      tracker,
      records,
      lastRuns,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("koşu izini biriktirir; bitişte sıkıştırılmış kaydı motora verir", () => {
    const h = persisting();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "agent", label: "Yazıcı", task: "yaz" });
    handle.watch(session);
    emit(toolStart("t1", "bash", { command: "ls" }));
    emit(toolEnd("t1", "bash", { content: [{ type: "text", text: "x".repeat(5_000) }] }));
    emit(assistantEnd("bitti", 5));
    // Süren koşunun izi canlı (kırpılmamış) hâliyle döner.
    const live = h.tracker.traces()[0]?.items ?? [];
    expect(live.map((i) => i.type)).toEqual(["tool", "assistant"]);
    expect(h.records).toEqual([]);

    handle.end("done");
    expect(h.records).toHaveLength(1);
    const record = h.records[0];
    expect(record?.run).toMatchObject({
      id: handle.id,
      label: "Yazıcı",
      status: "done",
      task: "yaz",
    });
    expect(record?.run.tokensPerSec).toBeUndefined();
    const tool = record?.items[0];
    expect(tool?.type === "tool" ? tool.status : "").toBe("done");
    expect(tool?.type === "tool" ? (tool.output?.length ?? 0) : 0).toBeLessThan(
      TRACE_KEEP_CHARS + 10,
    );
  });

  it("biten koşu izi son öğelerle sınırlanır", () => {
    const h = persisting();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "agent", label: "Tarama" });
    handle.watch(session);
    for (let i = 0; i < TRACE_KEEP_ITEMS + 20; i += 1) {
      emit(toolStart(`t${i}`, "read", { path: `f${i}` }));
      emit(toolEnd(`t${i}`, "read", { content: [{ type: "text", text: "a" }] }));
    }
    handle.end("done");
    const items = h.records[0]?.items ?? [];
    expect(items).toHaveLength(TRACE_KEEP_ITEMS);
    expect(items.at(-1)?.id).toBe(`t${TRACE_KEEP_ITEMS + 19}`);
  });

  it("kayıttan yüklenen koşu sonraki yayında da listede kalır", () => {
    const first = persisting();
    const handle = first.tracker.begin({ kind: "agent", label: "Eski" });
    handle.end("done");
    const record = first.records[0];
    if (!record) throw new Error("kayıt yok");

    const h = persisting();
    h.tracker.restore([record]);
    // Aynı kayıt iki kez gelse de tek koşu.
    h.tracker.restore([record]);
    expect(h.tracker.runs.map((r) => r.label)).toEqual(["Eski"]);
    h.tracker.begin({ kind: "agent", label: "Yeni" });
    const runs = h.lastRuns();
    expect(runs?.type === "subagents" ? runs.runs.map((r) => r.label) : []).toEqual([
      "Eski",
      "Yeni",
    ]);
  });

  it("keşif ve denetim koşuları kaydedilmez, eski kayıtları da yüklenmez", () => {
    const h = persisting();
    for (const kind of ["explore", "audit-hunter", "audit-verifier", "review", "agent"] as const)
      h.tracker.begin({ kind, label: kind }).end("done");
    expect(h.records.map((r) => r.run.kind)).toEqual(["review", "agent"]);

    const run = { id: "r1", label: "Keşif", kind: "explore", status: "done", startedAt: 1 };
    const loaded = subagentRecordsOf([
      { type: "custom", customType: SUBAGENT_RUN_TYPE, data: { run, items: [] } },
    ]);
    expect(loaded).toEqual([]);
  });

  it("geri sarmada kesme noktasından sonra başlamış biten koşular düşer, sürenler kalır", () => {
    const h = persisting();
    const old = h.tracker.begin({ kind: "agent", label: "Önce" });
    old.end("done");
    h.advance(1_000);
    const later = h.tracker.begin({ kind: "agent", label: "Sonra" });
    later.end("done");
    h.tracker.begin({ kind: "agent", label: "Süren" });
    h.tracker.dropAfter(1_500);
    expect(h.tracker.runs.map((r) => r.label)).toEqual(["Önce", "Süren"]);
  });

  it("oturum kayıtlarından yalnız geçerli biten koşuları okur", () => {
    const run = { id: "r1", label: "A", kind: "agent", status: "done", startedAt: 1 };
    const records = subagentRecordsOf([
      { type: "custom", customType: SUBAGENT_RUN_TYPE, data: { run, items: [{ bozuk: 1 }] } },
      {
        type: "custom",
        customType: SUBAGENT_RUN_TYPE,
        data: { run: { ...run, status: "running" } },
      },
      { type: "custom", customType: SUBAGENT_RUN_TYPE, data: { run: { id: 3 } } },
      { type: "custom", customType: "başka", data: { run } },
      { type: "message" },
    ]);
    expect(records).toEqual([{ run, items: [] }]);
  });
});

describe("SubagentTracker", () => {
  it("durdurulan çağrı (plan engeli, hook reddi) hata yerine kendi durumuyla biter", () => {
    const bus = new AgentEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const stops = new Map([
      ["p1", "blocked" as const],
      ["h1", "denied" as const],
    ]);
    const asked: string[] = [];
    const tracker = new SubagentTracker(bus, "s1", "tr", Date.now, {
      stopOf: (id) => {
        asked.push(id);
        return stops.get(id);
      },
    });
    const { session, emit } = fakeSession();
    tracker.begin({ kind: "agent", label: "Yazıcı" }).watch(session);
    const fail = { content: [{ type: "text", text: "engellendi" }] };
    for (const id of ["p1", "h1", "e1", "ok"]) emit(toolStart(id, "bash", { command: "x" }));
    emit(toolEnd("p1", "bash", fail, true));
    emit(toolEnd("h1", "bash", fail, true));
    emit(toolEnd("e1", "bash", fail, true));
    emit(toolEnd("ok", "bash", { content: [{ type: "text", text: "" }] }));
    const ended = events.flatMap((e) =>
      e.type === "subagent_trace" && e.item.type === "tool" && e.item.status !== "running"
        ? [[e.item.id, e.item.status]]
        : [],
    );
    expect(ended).toEqual([
      ["p1", "blocked"],
      ["h1", "denied"],
      ["e1", "error"],
      ["ok", "done"],
    ]);
    // Başarılı çağrı için işaret sorulmaz (tüketilecek bir şey yok).
    expect(asked).toEqual(["p1", "h1", "e1"]);
  });

  it("koşu başlarken başlığı yayar ve çalışıyor durumunda kalır", () => {
    const h = harness();
    const handle = h.tracker.begin({ kind: "explore", label: "İzin kapısı", task: "nerede?" });
    expect(h.tracker.size).toBe(1);
    const run = h.lastRun();
    expect(run?.id).toBe(handle.id);
    expect(run?.kind).toBe("explore");
    expect(run?.label).toBe("İzin kapısı");
    expect(run?.task).toBe("nerede?");
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBe(1_000);
    expect(run?.steps).toBe(0);
  });

  it("araç olaylarını iz öğesine çevirir: başlangıç, kırpılmış çıktı, bitiş", () => {
    const h = harness();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "explore", label: "Tarama" });
    handle.watch(session);

    emit(toolStart("t1", "grep", { pattern: "izin", path: "src" }));
    const started = h.traces().at(-1);
    expect(started?.item.type).toBe("tool");
    if (started?.item.type === "tool") {
      expect(started.item.status).toBe("running");
      expect(started.item.toolName).toBe("grep");
    }
    expect(h.lastRun()?.steps).toBe(1);
    expect(h.lastRun()?.activity).toBeDefined();

    emit(toolEnd("t1", "grep", { content: [{ type: "text", text: "src/a.ts:12" }] }));
    const ended = h.traces().at(-1);
    if (ended?.item.type === "tool") {
      expect(ended.item.status).toBe("done");
      expect(ended.item.output).toBe("src/a.ts:12");
      expect(ended.item.endedAt).toBeDefined();
    }
    expect(h.lastRun()?.steps).toBe(1);
  });

  it("pdf_create bitince iz öğesinin hedefi aracın çözdüğü yola döner", () => {
    const h = harness();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "agent", label: "Rapor" });
    handle.watch(session);
    emit(toolStart("p1", "pdf_create", { path: "rapor", html: "<h1>x</h1>" }));
    emit(
      toolEnd("p1", "pdf_create", {
        content: [{ type: "text", text: "PDF oluşturuldu" }],
        details: { path: "/belgeler/Çıktılar/rapor.pdf" },
      }),
    );
    const ended = h.traces().at(-1)?.item;
    expect(ended?.type === "tool" && ended.target).toBe("/belgeler/Çıktılar/rapor.pdf");
  });

  it("kısmi çıktıyı throttle eder ama son durumu kaybetmez", () => {
    const h = harness();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "explore", label: "Tarama" });
    handle.watch(session);
    emit(toolStart("t1", "read", { path: "a.ts" }));

    emit(toolUpdate("t1", "satır 1"));
    const afterFirst = h.traces().length;
    emit(toolUpdate("t1", "satır 2"));
    expect(h.traces().length).toBe(afterFirst);

    h.advance(TOOL_UPDATE_MIN_MS + 1);
    emit(toolUpdate("t1", "satır 3"));
    expect(h.traces().length).toBe(afterFirst + 1);
    const last = h.traces().at(-1);
    if (last?.item.type === "tool") expect(last.item.output).toBe("satır 3");
  });

  it("tur sonunda tüketimi biriktirip çıktı hızını hesaplar", () => {
    const h = harness();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "explore", label: "Tarama", model: "test-model" });
    handle.watch(session);

    emit(assistantEnd("birinci tur", 300));
    h.advance(1_000);
    emit(assistantEnd("ikinci tur", 200));

    const run = h.lastRun();
    expect(run?.tokens).toBe(500);
    expect(run?.usage?.input).toBe(20);
    expect(run?.tokensPerSec).toBeGreaterThan(0);

    const texts = h.traces().flatMap((t) => (t.item.type === "assistant" ? [t.item.text] : []));
    expect(texts).toEqual(["birinci tur", "ikinci tur"]);

    // Pencere dışına çıkınca hız ölçülemez olur, son değer sıfırlanır.
    h.advance(RATE_WINDOW_MS + 1);
    emit(assistantEnd("üçüncü tur", 10));
    expect(h.lastRun()?.tokensPerSec).toBeUndefined();
  });

  it("koşuyu kapatır ve ikinci kez kapatmaz", () => {
    const h = harness();
    const handle = h.tracker.begin({ kind: "review", label: "İnceleme" });
    handle.end("stopped");
    expect(h.lastRun()?.status).toBe("stopped");
    expect(h.lastRun()?.endedAt).toBeDefined();
    const count = h.snapshots().length;
    handle.end("done");
    expect(h.snapshots().length).toBe(count);
    expect(h.lastRun()?.status).toBe("stopped");
  });

  it("kapanan koşunun geç olaylarını yok sayar", () => {
    const h = harness();
    const { session, emit } = fakeSession();
    const handle = h.tracker.begin({ kind: "explore", label: "Tarama" });
    handle.watch(session);
    handle.end("done");
    const before = h.traces().length;
    emit(toolStart("t9", "ls"));
    expect(h.traces().length).toBe(before);
  });

  it("paralel koşular tek snapshot'ta birikir, biri diğerini ezmez", () => {
    const h = harness();
    const a = h.tracker.begin({ kind: "audit-hunter", label: "Avcı · A" });
    const b = h.tracker.begin({ kind: "audit-verifier", label: "Doğrulayıcı · B" });
    expect((h.snapshots().at(-1) ?? []).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    a.end("done");
    const after = h.snapshots().at(-1) ?? [];
    expect(after.map((r) => r.status)).toEqual(["done", "running"]);
  });

  it("bitmiş koşu üst sınırını aşınca en eskiler düşer, süren kalır", () => {
    const h = harness();
    const live = h.tracker.begin({ kind: "explore", label: "süren" });
    for (let i = 0; i < MAX_FINISHED_RUNS + 3; i += 1) {
      const done = h.tracker.begin({ kind: "explore", label: `b${i}` });
      done.end("done");
      h.advance(10);
    }
    const runs = h.snapshots().at(-1) ?? [];
    expect(runs.some((r) => r.id === live.id)).toBe(true);
    expect(runs).toHaveLength(MAX_FINISHED_RUNS + 1);
  });

  it("kırpma sınırı aşılırsa işaret koyar", () => {
    const long = "a".repeat(TRACE_OUTPUT_MAX + 10);
    expect(clipTrace(long).endsWith("[…]")).toBe(true);
    expect(clipTrace("kısa")).toBe("kısa");
  });
});
