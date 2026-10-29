import type { TranscriptItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import type { RunGroup } from "./openRuns";
import {
  findMatches,
  firstMatchFrom,
  MAX_FIND_MATCHES,
  pickMatch,
  stepMatch,
} from "./transcriptFind";

const user = (id: string, text: string, at: number): TranscriptItem => ({
  type: "user",
  id,
  text,
  at,
});
const assistant = (id: string, text: string, at: number, thinking?: string): TranscriptItem => ({
  type: "assistant",
  id,
  text,
  at,
  streaming: false,
  ...(thinking ? { thinking } : {}),
});
const tool = (id: string): TranscriptItem => ({
  type: "tool",
  id,
  toolName: "read",
  kind: "read",
  status: "done",
  title: "IPC dosyası okundu",
  startedAt: 1,
});

describe("findMatches", () => {
  const groups: RunGroup[] = [
    user("u1", "IPC zaman aşımı neden oluyor?", 1),
    // Çalışma dizisi: ara anlatım aranır, araç kartı ve düşünme aranmaz.
    [tool("t1"), assistant("n1", "ipc kanalına bakıyorum", 2, "ipc düşüncesi"), tool("t2")],
    assistant("a1", "Sorun ıpc kanalında; İPC zaman aşımı 30 sn.", 3),
    user("u2", "Teşekkürler", 4),
  ];

  it("Türkçe ve ASCII yazımdan bağımsız sayar, satır içi sırayı tutar", () => {
    const matches = findMatches(groups, "ipc");
    expect(matches.map((m) => [m.row, m.itemId, m.inRow])).toEqual([
      [0, "u1", 0],
      [1, "n1", 0],
      [2, "a1", 0],
      [2, "a1", 1],
    ]);
  });

  it("dizideki tur sonu mesajını atlar (metni ayrı satırda çizilir)", () => {
    const run: RunGroup[] = [[assistant("e1", "ipc sonucu", 5)]];
    expect(findMatches(run, "ipc")).toHaveLength(1);
    expect(findMatches(run, "ipc", new Set(["e1"]))).toHaveLength(0);
  });

  it("kullanıcı metninde gönderim bloklarını balondaki gibi çözer", () => {
    const sent = '<codezal-command name="plan">gizli talimat ipc</codezal-command> giriş';
    expect(findMatches([user("u", sent, 1)], "ipc")).toHaveLength(0);
    expect(findMatches([user("u", sent, 1)], "/plan")).toHaveLength(1);
  });

  it("boş sorguda eşleşme yok; sınırda durur", () => {
    expect(findMatches(groups, "  ")).toEqual([]);
    const many: RunGroup[] = [assistant("x", "a".repeat(MAX_FIND_MATCHES + 50), 1)];
    expect(findMatches(many, "a")).toHaveLength(MAX_FIND_MATCHES);
  });
});

describe("pickMatch", () => {
  const transcript: TranscriptItem[] = [
    user("u1", "ankara", 10),
    assistant("a1", "ankara tamam", 20),
    user("u2", "ankara yine", 30),
  ];
  const groups: RunGroup[] = transcript;
  const matches = findMatches(groups, "ankara");

  it("rol ve zaman damgasıyla hedef mesajı bulur", () => {
    expect(pickMatch(matches, { role: "user", at: 30, ordinal: 1 }, transcript)).toBe(2);
  });

  it("zaman damgası tutmazsa sıraya, o da tutmazsa ilk eşleşmeye düşer", () => {
    expect(pickMatch(matches, { role: "assistant", at: 999, ordinal: 2 }, transcript)).toBe(1);
    expect(pickMatch(matches, { role: "assistant", at: 999, ordinal: 99 }, transcript)).toBe(0);
  });

  it("eşleşme yoksa -1", () => {
    expect(pickMatch([], { role: "user", at: 1, ordinal: 1 }, transcript)).toBe(-1);
  });
});

describe("gezinme", () => {
  const matches = findMatches([user("u1", "x", 1), user("u2", "y", 2), user("u3", "x", 3)], "x");

  it("görünen satırdan sonraki ilk eşleşmeyi seçer, yoksa sonuncuyu", () => {
    expect(firstMatchFrom(matches, 1)).toBe(1);
    expect(firstMatchFrom(matches, 5)).toBe(1);
    expect(firstMatchFrom([], 0)).toBe(-1);
  });

  it("uçlarda sarar", () => {
    expect(stepMatch(1, 2, 1)).toBe(0);
    expect(stepMatch(0, 2, -1)).toBe(1);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
