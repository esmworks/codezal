import type {
  AssistantItem,
  BoundaryItem,
  MarkerItem,
  ToolCallItem,
  UserItem,
} from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { liveSegmentStart, mergeTurnRuns } from "./turnRuns";

const tool = (id: string): ToolCallItem => ({
  type: "tool",
  id,
  toolName: "read",
  kind: "read",
  status: "done",
  title: "Okundu",
  startedAt: 0,
});

const reply = (id: string, text = "rapor"): AssistantItem => ({
  type: "assistant",
  id,
  text,
  streaming: false,
  at: 0,
});

const user = (id: string): UserItem => ({ type: "user", id, text: "soru", at: 0 });

const boundary = (id: string): BoundaryItem => ({
  type: "boundary",
  id,
  kind: "background",
  at: 0,
});

const marker = (id: string): MarkerItem => ({
  type: "marker",
  id,
  kind: "permission",
  from: "ask",
  to: "full",
  at: 0,
});

const ids = (g: ReadonlyArray<unknown>) => g.map((i) => (i as { id: string }).id);

const flat = (out: ReadonlyArray<unknown>) =>
  out.map((g) => (Array.isArray(g) ? ids(g).join("+") : (g as { id: string }).id));

describe("mergeTurnRuns", () => {
  it("dürtmeyle bölünen turu tek diziye indirir", () => {
    const out = mergeTurnRuns([
      [tool("t1")],
      reply("a1"),
      boundary("b1"),
      [tool("t2")],
      reply("a2"),
    ]);
    expect(out).toHaveLength(4);
    expect(Array.isArray(out[0])).toBe(true);
    expect(ids(out[0] as ReadonlyArray<unknown>)).toEqual(["t1", "t2"]);
    // Ara rapor ve sınır birleşik dizinin ardında, kendi sırasıyla durur.
    expect(ids(out.slice(1))).toEqual(["a1", "b1", "a2"]);
  });

  it("kullanıcı mesajı turları bölmeye devam eder", () => {
    const out = mergeTurnRuns([[tool("t1")], reply("a1"), user("u1"), [tool("t2")], reply("a2")]);
    expect(out.map((g) => (Array.isArray(g) ? ids(g) : [])).filter((v) => v.length > 0)).toEqual([
      ["t1"],
      ["t2"],
    ]);
  });

  it("yalnız aynı turdaki dizileri birleştirir", () => {
    const out = mergeTurnRuns([
      [tool("t1")],
      reply("a1"),
      boundary("b1"),
      [tool("t2")],
      reply("a2"),
      user("u1"),
      [tool("t3")],
      reply("a3"),
    ]);
    expect(out.map((g) => (Array.isArray(g) ? ids(g) : [])).filter((v) => v.length > 0)).toEqual([
      ["t1", "t2"],
      ["t3"],
    ]);
  });

  it("tur başındaki akan anlatımı diziye katmaz", () => {
    // Canlı turda metin önce akar, araç sonra gelir; sıra değişirse satır yerinden kayardı.
    const streaming: AssistantItem = { ...reply("s1", "Kontrol ediyorum…"), streaming: true };
    const out = mergeTurnRuns([streaming, [tool("t1")], reply("a1"), boundary("b1"), [tool("t2")]]);
    expect(out[0]).toMatchObject({ type: "assistant", id: "s1" });
    expect(Array.isArray(out[0])).toBe(false);
    expect(ids(out[1] as ReadonlyArray<unknown>)).toEqual(["t1", "t2"]);
  });

  it("tur ortasındaki işaret birleşik dizinin önüne alınır", () => {
    // İzin değişimi turun başında yazılır; sonraki parçalar dizinin içine katlandığı için işaret
    // yerinde bırakılırsa akan turun hep en altında görünüyordu.
    const out = mergeTurnRuns([user("u1"), [tool("t1")], marker("m1"), reply("a1"), [tool("t2")]]);
    expect(out.map((g) => (Array.isArray(g) ? ids(g).join("+") : g.id))).toEqual([
      "u1",
      "m1",
      "t1+t2",
      "a1",
    ]);
  });

  it("tur bittikten sonraki işaret yerinde kalır", () => {
    const out = mergeTurnRuns([[tool("t1")], reply("a1"), marker("m1"), user("u2"), [tool("t2")]]);
    expect(out.map((g) => (Array.isArray(g) ? ids(g).join("+") : g.id))).toEqual([
      "t1",
      "a1",
      "m1",
      "u2",
      "t2",
    ]);
  });

  it("dizisiz turu değiştirmez", () => {
    const groups = [reply("a1"), user("u1"), reply("a2")];
    expect(mergeTurnRuns(groups)).toEqual(groups);
  });

  it("süren turda canlı bölümü önceki diziye katmaz", () => {
    // Canlı iş eski raporun üstüne taşınınca "Düşünüyor" satırı raporun üstünde, dönen durum
    // satırı altında kalıyordu; iş raporun altında akmalı.
    const groups = [user("u1"), [tool("t1")], reply("a1"), boundary("b1"), [tool("t2")]];
    const from = liveSegmentStart(groups, new Set(["a1"]));
    expect(from).toBe(3);
    expect(flat(mergeTurnRuns(groups, from))).toEqual(["u1", "t1", "a1", "b1", "t2"]);
    // Tur bitince aynı parçalar tek diziye iner.
    expect(flat(mergeTurnRuns(groups))).toEqual(["u1", "t1+t2", "a1", "b1"]);
  });

  it("canlı bölümde yalnız son rapordan sonrası ayrılır, kendi içinde birleşir", () => {
    const groups = [
      user("u1"),
      [tool("t1")],
      reply("a1"),
      boundary("b1"),
      [tool("t2")],
      reply("a2"),
      boundary("b2"),
      [tool("t3")],
      marker("m1"),
      [tool("t4")],
    ];
    const from = liveSegmentStart(groups, new Set(["a1", "a2"]));
    expect(flat(mergeTurnRuns(groups, from))).toEqual([
      "u1",
      "t1+t2",
      "a1",
      "b1",
      "a2",
      "b2",
      "m1",
      "t3+t4",
    ]);
  });

  it("canlı bölüm başlangıcı yalnız son turdaki rapora bakar", () => {
    // Önceki turun raporu yeni turu bölmez: tur başında dizi yoksa bile başlangıç yoktur.
    expect(liveSegmentStart([[tool("t1")], reply("a1"), user("u2")], new Set(["a1"]))).toBe(-1);
    expect(
      liveSegmentStart([[tool("t1")], reply("a1"), user("u2"), [tool("t2")]], new Set(["a1"])),
    ).toBe(-1);
    // Rapor yoksa (yalnız işaret) bölüm yoktur, parçalar tek canlı dizide kalır.
    const groups = [user("u1"), [tool("t1")], marker("m1"), [tool("t2")]];
    expect(liveSegmentStart(groups, new Set())).toBe(-1);
    expect(flat(mergeTurnRuns(groups, -1))).toEqual(["u1", "m1", "t1+t2"]);
  });

  it("girdiyi değiştirmez", () => {
    const first = [tool("t1")];
    mergeTurnRuns([first, reply("a1"), boundary("b1"), [tool("t2")]]);
    expect(ids(first)).toEqual(["t1"]);
  });
});
