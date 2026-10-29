import type { AssistantItem, BoundaryItem, ToolCallItem, UserItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { findExpandedRuns, findLiveRows } from "./openRuns";

const tool = (id: string): ToolCallItem => ({
  type: "tool",
  id,
  toolName: "read",
  kind: "read",
  status: "done",
  title: "Okundu",
  startedAt: 0,
});

const reply = (id: string, stopReason?: string): AssistantItem => ({
  type: "assistant",
  id,
  text: "Sonuç",
  streaming: false,
  at: 0,
  ...(stopReason ? { stopReason } : {}),
});

const user = (id: string): UserItem => ({ type: "user", id, text: "soru", at: 0 });

const boundary = (id: string): BoundaryItem => ({
  type: "boundary",
  id,
  kind: "background",
  at: 0,
});

describe("findExpandedRuns", () => {
  it("kapanış metni gelmeyen diziyi açık tutar", () => {
    const groups = [[tool("t1")], user("u1"), [tool("t2")]];
    expect(findExpandedRuns(groups, -1, new Set())).toEqual(new Set([0, 2]));
  });

  it("hata ya da kesmeyle biten turu katlanmaz sayar", () => {
    const groups = [
      [tool("t1")],
      reply("a1", "error"),
      user("u1"),
      [tool("t2")],
      reply("a2", "aborted"),
      user("u2"),
      [tool("t3")],
      reply("a3", "stop"),
    ];
    expect(findExpandedRuns(groups, -1, new Set(["a1", "a2", "a3"]))).toEqual(new Set([0, 3]));
  });

  it("süren diziyi açık kabul edip kümeye almaz", () => {
    const groups = [[tool("t1")], user("u1"), [tool("t2")]];
    expect(findExpandedRuns(groups, 2, new Set())).toEqual(new Set([0]));
  });

  it("tur içi ara rapor ve dürtme sınırı katlanmayı engellemez", () => {
    // Dürtmeden sonra iş aynı turda sürüyor: karar turun son kapanışına bakar.
    const groups = [[tool("t1"), tool("t2")], reply("a1"), boundary("b1"), reply("a2")];
    expect(findExpandedRuns(groups, -1, new Set(["a2"]))).toEqual(new Set());
  });

  it("birleşik diziyi, turun kapanışı hatalıysa açık tutar", () => {
    const groups = [[tool("t1"), tool("t2")], reply("a1"), boundary("b1"), reply("a2", "error")];
    expect(findExpandedRuns(groups, -1, new Set(["a2"]))).toEqual(new Set([0]));
  });

  it("dürtmeden sonra kapanış gelmeden biten turu açık tutar", () => {
    const groups = [[tool("t1")], reply("a1"), boundary("b1"), [tool("t2")]];
    expect(findExpandedRuns(groups, -1, new Set())).toEqual(new Set([0, 3]));
  });

  it("süren turda canlı bölümden önceki diziyi katlar", () => {
    const groups = [[tool("t1")], reply("a1"), boundary("b1"), [tool("t2")]];
    expect(findExpandedRuns(groups, 3, new Set(), 2)).toEqual(new Set());
    // Canlı bölüm bilinmiyorsa dizi kapanmamış sayılır.
    expect(findExpandedRuns(groups, 3, new Set())).toEqual(new Set([0]));
  });
});

describe("findLiveRows", () => {
  it("dürtmeden sonra ilk araçtan önce eski diziyi canlı saymaz", () => {
    // Model dürtmeden sonra düşünürken canlı başlık akan öğededir, raporun üstündeki dizide değil.
    const streaming: AssistantItem = { ...reply("s1"), text: "", streaming: true };
    const groups = [user("u1"), [tool("t1")], reply("a1"), boundary("b1"), streaming];
    expect(findLiveRows(groups, new Set(), 3)).toEqual({ liveRun: -1, liveHead: 4 });
  });

  it("canlı bölümdeki son diziyi seçer", () => {
    const groups = [user("u1"), [tool("t1")], reply("a1"), boundary("b1"), [tool("t2")]];
    expect(findLiveRows(groups, new Set(), 3)).toEqual({ liveRun: 4, liveHead: -1 });
  });

  it("yeni turda önceki turun dizisini canlı saymaz", () => {
    const groups = [[tool("t1")], reply("a1"), user("u2"), reply("s2")];
    expect(findLiveRows(groups, new Set(["a1"]), -1)).toEqual({ liveRun: -1, liveHead: 3 });
  });
});
