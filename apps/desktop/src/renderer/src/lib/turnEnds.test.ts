import type { AssistantItem, ToolCallItem, TranscriptItem, UserItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { findTurnEnds } from "./turnEnds";

function user(id: string): UserItem {
  return { type: "user", id, text: "soru", at: 1 };
}

function assistant(id: string, text: string, streaming = false): AssistantItem {
  return { type: "assistant", id, text, streaming, at: 2 };
}

function tool(id: string): ToolCallItem {
  return {
    type: "tool",
    id,
    toolName: "read",
    kind: "read",
    status: "done",
    title: "Okundu",
    startedAt: 1,
    endedAt: 2,
  };
}

function boundary(id: string): TranscriptItem {
  return { type: "boundary", id, kind: "background", at: 2 };
}

const ids = (set: Set<string>) => [...set].sort();

describe("findTurnEnds", () => {
  it("araçsız ardışık kapanış mesajlarını birlikte sonuç sayar", () => {
    // Arka plan bitince model aynı turda ikinci bir kapanış yazıyor: asıl rapor da görünmeli.
    const items: TranscriptItem[] = [
      user("u1"),
      tool("t1"),
      assistant("a1", "İki iş bitti: …"),
      assistant("a2", "Bu, az önce sözünü ettiğim DMG yenilemesinin tamamlanma bildirimi…"),
    ];
    const ends = findTurnEnds(items, false);
    expect(ids(ends.results)).toEqual(["a1", "a2"]);
    expect([...ends.finals]).toEqual(["a2"]);
    expect(ends.last).toBe("a2");
  });

  it("araç araya girince önceki metni sonuç saymaz", () => {
    const items: TranscriptItem[] = [
      user("u1"),
      assistant("a1", "Şimdi dosyaya bakıyorum."),
      tool("t1"),
      assistant("a2", "Sonuç: dosya güncellendi."),
      user("u2"),
      tool("t2"),
      assistant("a3", "İkinci tur kapandı."),
    ];
    const ends = findTurnEnds(items, false);
    expect(ids(ends.results)).toEqual(["a2", "a3"]);
    expect(ids(ends.finals)).toEqual(["a2", "a3"]);
    expect(ends.last).toBe("a3");
  });

  it("dürtme sınırı önceki raporu kurtarır, finals yine son kapanışta kalır", () => {
    // Arka plan bildirimi yeni bir doğrulama koşusu doğurdu: sınır olmasa asıl rapor (a1)
    // araç yüzünden katlanmış diziye gömülürdü.
    const items: TranscriptItem[] = [
      user("u1"),
      tool("t1"),
      assistant("a1", "Tüm doğrulamalar tamam."),
      boundary("b1"),
      tool("t2"),
      assistant("a2", "Bildirim: eski koşu temiz geçti."),
    ];
    const ends = findTurnEnds(items, false);
    expect(ids(ends.results)).toEqual(["a1", "a2"]);
    expect([...ends.finals]).toEqual(["a2"]);
    expect(ends.last).toBe("a2");
  });

  it("sınır, dürtme turu araç çağırmasa da sonucu değiştirmez", () => {
    const items: TranscriptItem[] = [
      user("u1"),
      tool("t1"),
      assistant("a1", "Rapor."),
      boundary("b1"),
      assistant("a2", "Bildirim."),
    ];
    const ends = findTurnEnds(items, false);
    expect(ids(ends.results)).toEqual(["a1", "a2"]);
    expect([...ends.finals]).toEqual(["a2"]);
    expect(ends.last).toBe("a2");
  });

  it("dürtme yanıtı sürerken önceki rapor görünür kalır, finals beklemede kalır", () => {
    const items: TranscriptItem[] = [
      user("u1"),
      tool("t1"),
      assistant("a1", "Tüm doğrulamalar tamam."),
      boundary("b1"),
      assistant("a2", "akan yanıt", true),
    ];
    const ends = findTurnEnds(items, true);
    expect([...ends.results]).toEqual(["a1"]);
    expect(ends.finals.size).toBe(0);
    expect(ends.last).toBeUndefined();
  });

  it("süren turun ucundaki kapanışı saymaz, önceki turun kapanışını korur", () => {
    const done: TranscriptItem[] = [user("u1"), tool("t1"), assistant("a1", "İlk tur.")];
    const running: TranscriptItem[] = [...done, user("u2"), tool("t2")];
    const ends = findTurnEnds(running, true);
    expect([...ends.results]).toEqual(["a1"]);
    expect([...ends.finals]).toEqual(["a1"]);
    expect(ends.last).toBe("a1");
  });

  it("boş metinli, yalnızca düşünmeli ve akmakta olan mesajları atlar", () => {
    const items: TranscriptItem[] = [
      user("u1"),
      tool("t1"),
      { ...assistant("a0", " "), thinking: "düşünme" },
      assistant("a1", "akan", true),
      assistant("a2", "asıl sonuç"),
    ];
    const ends = findTurnEnds(items, false);
    expect([...ends.results]).toEqual(["a2"]);
    expect([...ends.finals]).toEqual(["a2"]);
  });

  it("araçla biten, kapanış metni olmayan turun sonu yoktur", () => {
    const ends = findTurnEnds([user("u1"), tool("t1")], false);
    expect(ends.results.size).toBe(0);
    expect(ends.finals.size).toBe(0);
    expect(ends.last).toBeUndefined();
  });
});
