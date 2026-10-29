import type { SessionSummary } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { fallbackSession } from "./sessionFallback";

function session(
  id: string,
  modifiedAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    cwd: "/repo",
    name: id,
    mode: "kodlama",
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    pinned: false,
    archived: false,
    live: false,
    projectId: null,
    auditRunId: null,
    parentSessionId: null,
    sideOf: null,
    ...extra,
  };
}

const none = new Set<string>();

describe("fallbackSession", () => {
  // Kenar çubuğu sırası: c (3) > b (2) > a (1).
  const list = [session("a", 1), session("b", 2), session("c", 3)];

  it("aynı bölümde hemen alttaki sohbeti seçer", () => {
    expect(fallbackSession(list, "b", new Set(["b"]))?.id).toBe("a");
    expect(fallbackSession(list, "c", new Set(["c"]))?.id).toBe("b");
  });

  it("en alttaki silinince üstündekine geçer", () => {
    expect(fallbackSession(list, "a", new Set(["a"]))?.id).toBe("b");
  });

  it("birlikte silinenleri atlar", () => {
    expect(fallbackSession(list, "c", new Set(["c", "b"]))?.id).toBe("a");
    expect(fallbackSession(list, "a", new Set(["a", "b", "c"]))).toBeNull();
  });

  it("başka klasöre, kipe ya da arşive atlamaz", () => {
    const mixed = [
      session("x", 5),
      session("other", 4, { cwd: "/other" }),
      session("task", 3, { mode: "asistan" }),
      session("old", 2, { archived: true }),
      session("pin", 1, { pinned: true }),
    ];
    expect(fallbackSession(mixed, "x", new Set(["x"]))).toBeNull();
  });

  it("worktree oturumu projesinin bölümünde sayılır", () => {
    const wt = [session("main", 2), session("wt", 1, { cwd: "/repo/.worktrees/feat" })];
    expect(fallbackSession(wt, "main", new Set(["main"]))?.id).toBe("wt");
  });

  it("sabitlenen sohbet sabitlenenler arasında kalır", () => {
    const pins = [
      session("p1", 3, { pinned: true }),
      session("free", 2),
      session("p2", 1, { pinned: true }),
    ];
    expect(fallbackSession(pins, "p1", new Set(["p1"]))?.id).toBe("p2");
  });

  it("Asistan görevi aynı projedeki göreve geçer", () => {
    const tasks = [
      session("t1", 3, { mode: "asistan", projectId: "p" }),
      session("t2", 2, { mode: "asistan", projectId: "q" }),
      session("t3", 1, { mode: "asistan", projectId: "p" }),
    ];
    expect(fallbackSession(tasks, "t1", new Set(["t1"]))?.id).toBe("t3");
  });

  it("listede olmayan kimlik için null döner", () => {
    expect(fallbackSession(list, "yok", none)).toBeNull();
  });
});
