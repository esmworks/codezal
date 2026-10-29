import type { AgentEventInput, WorkerInfo } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import type { WorkerRuntime, WorktreeService } from "../worker.js";
import { builtInAgentInfos } from "./profile.js";
import { AgentRunManager, type AgentRunStart, type AgentRunStore } from "./runs.js";

const profile = builtInAgentInfos("tr")[0];

/** Elle çözülen tur: testte koşunun ne zaman biteceği belirlenir. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(
  options: {
    worktrees?: WorktreeService | null;
    files?: string[];
    concurrency?: number;
    stored?: Map<string, WorkerInfo[]>;
  } = {},
) {
  const events: AgentEventInput[] = [];
  const turns: Array<ReturnType<typeof deferred>> = [];
  const opened: Array<{ cwd: string; permission: string }> = [];
  const prompts: string[] = [];
  const removed: string[] = [];
  const saved = new Map<string, WorkerInfo[]>();
  let seq = 0;
  const runtime: WorkerRuntime = {
    open: async ({ cwd, permission }) => {
      opened.push({ cwd, permission });
      seq += 1;
      return `s${seq}`;
    },
    run: (_id, prompt) => {
      prompts.push(prompt);
      const turn = deferred();
      turns.push(turn);
      return turn.promise;
    },
    abort: () => {
      for (const turn of turns) turn.resolve();
    },
    usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }),
    lastText: () => "tamam",
    close: () => {},
  };
  const worktrees: WorktreeService = {
    create: async ({ id }) => `/wt/${id}`,
    remove: async (_cwd, path) => {
      removed.push(path);
    },
    changedFiles: async () => options.files ?? ["a.ts"],
    diff: async () => "diff",
    apply: async () => {},
    dirty: async () => false,
  };
  const store: AgentRunStore = {
    load: () => options.stored ?? new Map(),
    save: (parent, runs) => saved.set(parent, runs),
  };
  const manager = new AgentRunManager({
    runtime,
    worktrees: options.worktrees === undefined ? worktrees : options.worktrees,
    emit: (event) => events.push(event),
    buildPrompt: (task) => task,
    worktreeError: (title) => `worktree yok: ${title}`,
    interruptedError: () => "yarıda kaldı",
    concurrency: () => options.concurrency ?? 3,
    permission: ({ isolated }) => (isolated ? "auto-edit" : "ask"),
    store,
  });
  return { manager, events, turns, opened, prompts, removed, saved };
}

function start(overrides: Partial<AgentRunStart> = {}): AgentRunStart {
  if (!profile) throw new Error("gömülü ajan yok");
  return {
    parentSessionId: "p1",
    cwd: "/repo",
    profile,
    title: "iş",
    task: "yap",
    background: true,
    isolation: "preferred",
    ...overrides,
  };
}

/** Havuzun asenkron adımları (worktree açma, oturum açma) tamamlansın. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentRunManager", () => {
  it("worktree koşusu ayardaki izinle açılır, değişiklik bırakınca review olur", async () => {
    const h = harness();
    const run = h.manager.start(start());
    await tick();
    expect(h.opened).toEqual([{ cwd: `/wt/${run.id}`, permission: "auto-edit" }]);
    h.turns[0]?.resolve();
    await run.ended;
    expect(run.status).toBe("review");
    expect(h.manager.list("p1").map((r) => r.status)).toEqual(["review"]);
    expect(h.events.some((e) => e.type === "worker_ended" && e.sessionId === "p1")).toBe(true);
  });

  it("değişiklik bırakmayan worktree koşusunun klasörü silinir", async () => {
    const h = harness({ files: [] });
    const run = h.manager.start(start());
    await tick();
    h.turns[0]?.resolve();
    await run.ended;
    await tick();
    expect(run.status).toBe("done");
    expect(h.removed).toEqual([`/wt/${run.id}`]);
  });

  it("yalıtımsız koşu kökte ana oturumun izniyle çalışır", async () => {
    const h = harness();
    h.manager.start(start({ isolation: "none" }));
    await tick();
    expect(h.opened).toEqual([{ cwd: "/repo", permission: "ask" }]);
  });

  it("köprü yoksa `preferred` kökte sürer, `required` başlamadan düşer", async () => {
    const h = harness({ worktrees: null });
    const preferred = h.manager.start(start());
    const required = h.manager.start(start({ isolation: "required", title: "zorunlu" }));
    await tick();
    expect(preferred.isolated).toBe(false);
    expect(h.opened[0]?.cwd).toBe("/repo");
    expect(required.status).toBe("failed");
    expect(required.info().error).toBe("worktree yok: zorunlu");
  });

  it("eşzamanlılık sınırı dolunca koşu sırada bekler, yuva boşalınca başlar", async () => {
    const h = harness({ concurrency: 1 });
    const first = h.manager.start(start());
    const second = h.manager.start(start({ title: "ikinci" }));
    await tick();
    expect(h.opened).toHaveLength(1);
    expect(second.status).toBe("starting");
    h.turns[0]?.resolve();
    await first.ended;
    await tick();
    await tick();
    expect(h.opened).toHaveLength(2);
    expect(second.status).toBe("working");
  });

  it("koşular ana oturuma bağlıdır: başka oturumdan görülmez ve durdurulamaz", async () => {
    const h = harness({ files: [] });
    const run = h.manager.start(start());
    await tick();
    expect(h.manager.list("p2")).toEqual([]);
    h.manager.stop("p2", run.id);
    expect(run.status).toBe("working");
    h.manager.stop("p1", run.id);
    await run.ended;
    expect(run.status).toBe("cancelled");
  });

  it("yeniden açılışta yarıda kalan koşu failed olur, review bekleyen karar alabilir", async () => {
    if (!profile) throw new Error("gömülü ajan yok");
    const base: WorkerInfo = {
      id: "run-a",
      parentSessionId: "p1",
      cwd: "/repo",
      agent: profile.name,
      title: "eski",
      task: "yap",
      status: "working",
      isolated: true,
      background: true,
      worktree: "/wt/run-a",
      sessionId: "s-old",
      createdAt: 1,
      stepsDone: 0,
      stepsTotal: 0,
      error: null,
    };
    const stored = new Map([
      ["p1", [base, { ...base, id: "run-b", status: "review" as const, worktree: "/wt/run-b" }]],
    ]);
    const h = harness({ stored });
    expect(h.manager.list("p1").map((r) => r.status)).toEqual(["failed", "review"]);
    await h.manager.review("p1", "run-b", "discard");
    expect(h.removed).toEqual(["/wt/run-b"]);
    expect(h.manager.list("p1")[1]?.status).toBe("cancelled");
    expect(h.saved.get("p1")?.[1]?.status).toBe("cancelled");
  });

  it("forget ana oturumun koşularını durdurur ve kaydı boşaltır", async () => {
    const h = harness({ files: [] });
    const run = h.manager.start(start());
    await tick();
    h.manager.forget("p1");
    await run.ended;
    expect(run.status).toBe("cancelled");
    expect(h.manager.list("p1")).toEqual([]);
    expect(h.saved.get("p1")).toEqual([]);
  });

  it("yuvalar bellekteki alt ajanlarla ortaktır: sınır toplamdır", async () => {
    const h = harness({ concurrency: 1 });
    const inMemory = deferred();
    const held = h.manager.slots.run(() => inMemory.promise);
    const run = h.manager.start(start());
    await tick();
    expect(h.opened).toHaveLength(0);
    expect(run.status).toBe("starting");
    inMemory.resolve();
    await held;
    await tick();
    await tick();
    expect(h.opened).toHaveLength(1);
  });

  it("sıradaki koşuya gelen yönlendirme kaybolmaz, görevle birlikte verilir", async () => {
    const h = harness({ concurrency: 1 });
    const first = h.manager.start(start());
    const second = h.manager.start(start({ title: "ikinci" }));
    await tick();
    expect(h.manager.steer("p1", second.id, "önce testleri çalıştır")).toBe(true);
    h.turns[0]?.resolve();
    await first.ended;
    await tick();
    await tick();
    expect(h.prompts[1]).toBe("yap\n\nönce testleri çalıştır");
  });

  it("durdurma bilinmeyen ya da biten koşuda false döner", async () => {
    const h = harness({ files: [] });
    const run = h.manager.start(start());
    await tick();
    expect(h.manager.stop("p1", "yok")).toBe(false);
    h.turns[0]?.resolve();
    await run.ended;
    expect(h.manager.stop("p1", run.id)).toBe(false);
  });

  it("biten koşu kayda geçer: listede kalır, oturum eşlemesi düşer", async () => {
    const h = harness({ files: [] });
    const run = h.manager.start(start());
    await tick();
    const sessionId = run.sessionId ?? "";
    expect(h.manager.parentOf(sessionId)).toBe("p1");
    h.turns[0]?.resolve();
    await run.ended;
    expect(h.manager.parentOf(sessionId)).toBeUndefined();
    expect(h.manager.get("p1", run.id)).toBeUndefined();
    expect(h.manager.list("p1").map((r) => [r.id, r.status])).toEqual([[run.id, "done"]]);
  });

  it("değişiklik bırakıp durdurulan worktree koşusu incelemeye düşer, bırakmayanın klasörü silinir", async () => {
    const h = harness();
    const kept = h.manager.start(start());
    await tick();
    h.manager.stop("p1", kept.id);
    await kept.ended;
    await tick();
    expect(kept.status).toBe("review");
    expect(h.removed).toEqual([]);

    const empty = harness({ files: [] });
    const run = empty.manager.start(start());
    await tick();
    empty.manager.stop("p1", run.id);
    await run.ended;
    await tick();
    expect(run.status).toBe("cancelled");
    expect(empty.removed).toEqual([`/wt/${run.id}`]);
  });
});
