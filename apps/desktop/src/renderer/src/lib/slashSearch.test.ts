import { describe, expect, it } from "vitest";
import {
  bestIndex,
  filterSuggestions,
  type SlashSuggestion,
  scoreMatch,
  uniqueSuggestions,
} from "./slashSearch";

function item(value: string, extra: Partial<SlashSuggestion> = {}): SlashSuggestion {
  return {
    id: value,
    kind: "command",
    value,
    label: value,
    description: "",
    keywords: [],
    icon: "terminal",
    runOnPick: false,
    ...extra,
  };
}

describe("scoreMatch", () => {
  it("önek > alt dize > harf sırası; eşleşme yoksa null", () => {
    const prefix = scoreMatch("model", "mo");
    const inside = scoreMatch("demo", "mo");
    const scattered = scoreMatch("mcp-tools", "mt");
    expect(prefix).not.toBeNull();
    expect(inside).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix ?? 0).toBeLessThan(inside ?? 0);
    expect(inside ?? 0).toBeLessThan(scattered ?? 0);
    expect(scoreMatch("plan", "xyz")).toBeNull();
  });

  it("Türkçe harfleri ve büyük harfi katlar", () => {
    expect(scoreMatch("düşünme", "DUSUN")).not.toBeNull();
    expect(scoreMatch("İncele", "incele")).toBe(0);
  });
});

describe("filterSuggestions", () => {
  const items = [
    item("/help", { description: "Komut listesini göster", keywords: ["yardım"] }),
    item("/model", { description: "Model seçiciyi aç" }),
    item("/mode", { description: "İzin modunu değiştir", keywords: ["mod"] }),
    item("/skill:demo", { kind: "skill", label: "demo", description: "Örnek beceri" }),
  ];

  it("boş sorgu katalog sırasını korur", () => {
    expect(filterSuggestions(items, "").map((i) => i.value)).toEqual(items.map((i) => i.value));
  });

  it("ada tam uyan satır, açıklamada geçenin önüne gelir", () => {
    const out = filterSuggestions(items, "mode").map((i) => i.value);
    expect(out[0]).toBe("/mode");
  });

  it("takma ad (Türkçe yazım) aramada bulunur ama addan sonra sıralanır", () => {
    expect(filterSuggestions(items, "yardım").map((i) => i.value)).toEqual(["/help"]);
  });

  it("açıklamada harf sırası eşleşmesi sayılmaz", () => {
    // "zgt" hiçbir adda yok; açıklamalarda dağınık harf olarak geçse de satır gelmez.
    expect(filterSuggestions(items, "zgt")).toEqual([]);
  });

  it("bestIndex bütün listenin en iyi eşleşmesini seçer", () => {
    const list = [item("/review-all", { description: "demo" }), item("/demo")];
    expect(bestIndex(list, "demo")).toBe(1);
    expect(bestIndex(list, "")).toBe(0);
  });

  it("aynı değerden yalnız ilki kalır", () => {
    const dup = [item("/review"), item("/review", { kind: "skill" })];
    expect(uniqueSuggestions(dup).map((i) => i.kind)).toEqual(["command"]);
  });
});
