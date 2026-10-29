import type { SessionSummary } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { expiredSessions } from "./archive.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    path: "/tmp/s1.json",
    cwd: "/tmp",
    name: "Oturum",
    mode: "kodlama",
    createdAt: NOW - 30 * DAY,
    modifiedAt: NOW - 30 * DAY,
    messageCount: 4,
    pinned: false,
    archived: false,
    live: false,
    projectId: null,
    auditRunId: null,
    parentSessionId: null,
    sideOf: null,
    ...over,
  };
}

describe("expiredSessions", () => {
  it("süresi dolmuş oturumu seçer", () => {
    const list = [session({ id: "eski", modifiedAt: NOW - 8 * DAY })];
    expect(expiredSessions(list, 7, NOW)).toEqual(["eski"]);
  });

  it("süresi dolmamış oturuma dokunmaz", () => {
    const list = [session({ id: "yeni", modifiedAt: NOW - 6 * DAY })];
    expect(expiredSessions(list, 7, NOW)).toEqual([]);
  });

  it("sabitlenmiş, çalışan ve zaten arşivli oturumları atlar", () => {
    const old = NOW - 40 * DAY;
    const list = [
      session({ id: "sabit", modifiedAt: old, pinned: true }),
      session({ id: "calisan", modifiedAt: old, live: true }),
      session({ id: "arsivli", modifiedAt: old, archived: true }),
      session({ id: "uygun", modifiedAt: old }),
    ];
    expect(expiredSessions(list, 7, NOW)).toEqual(["uygun"]);
  });
});
