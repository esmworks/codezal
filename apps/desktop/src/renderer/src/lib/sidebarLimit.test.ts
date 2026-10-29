import type { SessionSummary } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { SESSION_LIMIT, sessionToggleVisible, visibleSessions } from "./sidebarLimit";

function session(id: string, modifiedAt: number): SessionSummary {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
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
  };
}

function many(n: number): SessionSummary[] {
  return Array.from({ length: n }, (_, i) => session(`s${i}`, i));
}

describe("visibleSessions", () => {
  it("sınırı aşmayan listeyi olduğu gibi döner", () => {
    const items = many(SESSION_LIMIT);
    expect(visibleSessions(items, false, null)).toEqual({ visible: items, hidden: 0 });
  });

  it("sınırı aşan listede yalnızca ilk N sohbeti gösterir", () => {
    const items = many(SESSION_LIMIT + 3);
    const { visible, hidden } = visibleSessions(items, false, null);
    expect(visible.map((s) => s.id)).toEqual(items.slice(0, SESSION_LIMIT).map((s) => s.id));
    expect(hidden).toBe(3);
  });

  it("açık sohbet dilimin dışındaysa listeye ekler", () => {
    const items = many(SESSION_LIMIT + 4);
    const { visible, hidden } = visibleSessions(items, false, `s${SESSION_LIMIT + 2}`);
    expect(visible.map((s) => s.id)).toEqual([
      ...items.slice(0, SESSION_LIMIT).map((s) => s.id),
      `s${SESSION_LIMIT + 2}`,
    ]);
    expect(hidden).toBe(3);
  });

  it("açık sohbet dilimin içindeyse listeyi değiştirmez", () => {
    const items = many(SESSION_LIMIT + 4);
    const { visible, hidden } = visibleSessions(items, false, "s1");
    expect(visible).toHaveLength(SESSION_LIMIT);
    expect(hidden).toBe(4);
  });

  it("açık sohbet son öğeyse liste tamamlanır, gizli satır kalmaz", () => {
    const items = many(SESSION_LIMIT + 1);
    const { visible, hidden } = visibleSessions(items, false, `s${SESSION_LIMIT}`);
    expect(visible.map((s) => s.id)).toEqual(items.map((s) => s.id));
    expect(hidden).toBe(0);
  });

  it("genişletilmiş listeyi tümüyle döner", () => {
    const items = many(SESSION_LIMIT + 10);
    expect(visibleSessions(items, true, null)).toEqual({ visible: items, hidden: 0 });
  });
});

describe("sessionToggleVisible", () => {
  it("katlanmışken gizli sohbet varsa görünür", () => {
    expect(sessionToggleVisible(false, 12, 4)).toBe(true);
  });

  it("her şey görünüyorsa gizli sayısı sıfır olduğundan görünmez", () => {
    expect(sessionToggleVisible(false, 9, 0)).toBe(false);
  });

  it("açıkken sınır aşılıyorsa gizlenebilir diye görünür", () => {
    expect(sessionToggleVisible(true, 12, 0)).toBe(true);
  });

  it("açık liste sınıra sığıyorsa görünmez", () => {
    expect(sessionToggleVisible(true, SESSION_LIMIT, 0)).toBe(false);
  });
});
