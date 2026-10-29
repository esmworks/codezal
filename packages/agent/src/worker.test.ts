import { describe, expect, it } from "vitest";
import { builtInAgentInfos } from "./agents/profile.js";
import {
  type WorkerEvent,
  type WorkerRuntime,
  WorkerSession,
  type WorktreeService,
} from "./worker.js";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 };
const profile = builtInAgentInfos("tr")[0] ?? builtInAgentInfos("en")[0];

function input(title: string, overrides: { isolated?: boolean; background?: boolean } = {}) {
  if (!profile) throw new Error("gömülü ajan yok");
  return {
    parentSessionId: "parent-1",
    cwd: "/tmp/repo",
    profile,
    title,
    task: "iş",
    isolated: overrides.isolated ?? true,
    background: overrides.background ?? false,
  };
}

function deps(options: { run?: () => Promise<void>; abort?: () => void } = {}) {
  const events: WorkerEvent[] = [];
  const runtime: WorkerRuntime = {
    open: async () => "session-1",
    run: options.run ?? (async () => {}),
    abort: options.abort ?? (() => {}),
    usage: () => usage,
    lastText: () => "iş bitti: 2 dosya",
    close: () => {},
  };
  const worktrees: WorktreeService = {
    create: async () => "/tmp/wt",
    remove: async () => {},
    changedFiles: async () => ["a.ts", "b.ts"],
    diff: async () => "diff --git a/a.ts b/a.ts",
    apply: async () => {},
    dirty: async () => false,
  };
  return {
    events,
    deps: {
      runtime,
      worktrees,
      buildPrompt: (task: string, isolated: boolean) => (isolated ? `[wt] ${task}` : task),
      onEvent: (event: WorkerEvent) => events.push(event),
    },
  };
}

describe("WorkerSession", () => {
  it("başarıyla biten worktree koşusu review durumuna geçer, özet ve dosyalar toplanır", async () => {
    const h = deps();
    const worker = new WorkerSession(input("hata düzelt"), h.deps);
    await worker.start("/tmp/wt", "auto-edit");

    expect(worker.status).toBe("review");
    expect(worker.sessionId).toBe("session-1");
    const info = worker.info();
    expect(info.result).toBe("iş bitti: 2 dosya");
    expect(info.filesChanged).toBe(2);
    expect(info.usage).toEqual(usage);
    expect(info.error).toBeNull();
    const ended = h.events.find((e) => e.kind === "ended");
    expect(ended?.kind === "ended" ? ended.info.status : null).toBe("done");
  });

  it("rapor olayı yayınlanır: biten koşuda sonuç, süren işte son eylem (F20)", async () => {
    const h = deps();
    const worker = new WorkerSession(input("w"), h.deps);
    await worker.start("/tmp/wt", "auto-edit");

    // Panel özet kartı yalnız `report` olayıyla dolar; olay çıkmazsa kart boş kalırdı.
    expect(h.events.some((e) => e.kind === "report")).toBe(true);
    expect(worker.report.done.join(" ")).toContain("iş bitti");
    expect(worker.report.active).toEqual([]);
  });

  it("durdurulan koşu cancelled olur (F8)", async () => {
    let aborted = false;
    const h = deps({
      run: () =>
        new Promise<void>((resolve) => {
          // Durdurma sinyali gelince tur çözülür; `start` bunu `stopped` bayrağıyla görür.
          setTimeout(resolve, 5);
        }),
      abort: () => {
        aborted = true;
      },
    });
    const worker = new WorkerSession(input("uzun iş"), h.deps);
    const started = worker.start("/tmp/wt", "auto-edit");
    await new Promise((resolve) => setTimeout(resolve, 1));
    worker.stop();
    await started;

    expect(aborted).toBe(true);
    // Worktree'de değişiklik kaldı: iş kaybolmasın diye inceleme bekler; bitiş bilgisi iptaldir.
    expect(worker.status).toBe("review");
    const ended = h.events.find((e) => e.kind === "ended");
    expect(ended?.kind === "ended" ? ended.info.status : null).toBe("cancelled");
  });

  it("değişiklik bırakmadan durdurulan koşu cancelled olur", async () => {
    const h = deps({ run: () => new Promise<void>((resolve) => setTimeout(resolve, 5)) });
    h.deps.worktrees.changedFiles = async () => [];
    const worker = new WorkerSession(input("uzun iş"), h.deps);
    const started = worker.start("/tmp/wt", "auto-edit");
    await new Promise((resolve) => setTimeout(resolve, 1));
    worker.stop();
    await started;
    expect(worker.status).toBe("cancelled");
  });

  it("oturum açılamazsa worker failed olur ve koşu başlamaz", async () => {
    const h = deps();
    const failing = {
      ...h.deps,
      runtime: {
        ...h.deps.runtime,
        open: async () => {
          throw new Error("worktree açılamadı");
        },
      },
    };
    const worker = new WorkerSession(input("w"), failing);
    await worker.start("/tmp/wt", "auto-edit");

    expect(worker.status).toBe("failed");
    expect(worker.info().error).toBe("worktree açılamadı");
  });

  it("worktree'siz koşu kökte çalışır, değişiklik sayılmaz ve doğrudan done olur", async () => {
    const h = deps();
    let opened = "";
    let prompt = "";
    const worker = new WorkerSession(input("oku", { isolated: false }), {
      ...h.deps,
      runtime: {
        ...h.deps.runtime,
        open: async ({ cwd }) => {
          opened = cwd;
          return "session-1";
        },
        run: async (_id, text) => {
          prompt = text;
        },
      },
    });
    await worker.start("", "ask");

    expect(opened).toBe("/tmp/repo");
    expect(prompt).toBe("iş");
    expect(worker.isolated).toBe(false);
    expect(worker.status).toBe("done");
    expect(worker.info().filesChanged).toBeUndefined();
  });

  it("bitişi bekleyen `ended` her sonuçta çözülür", async () => {
    const h = deps();
    const worker = new WorkerSession(input("w"), h.deps);
    void worker.start("/tmp/wt", "auto-edit");
    await worker.ended;
    expect(worker.status).toBe("review");
  });

  it("kuyrukta durdurulan koşu oturum açmadan cancelled olur", async () => {
    const h = deps();
    const worker = new WorkerSession(input("w"), h.deps);
    worker.stop();
    await worker.ended;
    expect(worker.status).toBe("cancelled");
    expect(worker.sessionId).toBeNull();
  });

  it("oturum açılırken gelen durdurma koşuyu bir kez bitirir, tur açılmaz", async () => {
    const h = deps();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turns = 0;
    h.deps.runtime.open = async () => {
      await gate;
      return "session-1";
    };
    h.deps.runtime.run = async () => {
      turns += 1;
    };
    const worker = new WorkerSession(input("w"), h.deps);
    const started = worker.start("/tmp/wt", "auto-edit");
    worker.stop();
    expect(worker.status).toBe("starting");
    release();
    await started;
    expect(worker.status).toBe("cancelled");
    expect(turns).toBe(0);
    expect(h.events.filter((e) => e.kind === "ended")).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "started")).toBe(false);
  });

  it("onay beklerken gelen yönlendirme koşuyu beklemeden çıkarmaz", async () => {
    const turns: Array<() => void> = [];
    const h = deps({
      run: () =>
        new Promise<void>((resolve) => {
          turns.push(resolve);
        }),
    });
    const worker = new WorkerSession(input("w"), h.deps);
    void worker.start("/tmp/wt", "auto-edit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.setWaiting(true);
    void worker.steer("devam et");
    expect(worker.status).toBe("waiting");
    worker.setWaiting(false);
    expect(worker.status).toBe("working");
    for (const resolve of turns) resolve();
    await worker.ended;
  });
});
