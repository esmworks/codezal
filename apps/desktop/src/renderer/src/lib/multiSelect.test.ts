import { describe, expect, it } from "vitest";
import { type MarkState, markClick, noMarks, pruneMarks } from "./multiSelect";

const order = ["a", "b", "c", "d"];
const click = (state: MarkState, key: string, mods: Partial<{ toggle: boolean; range: boolean }>) =>
  markClick(state, order, key, { toggle: false, range: false, ...mods });

describe("markClick", () => {
  it("Cmd/Ctrl ile satır ekler ve aynı satırda çıkarır", () => {
    const one = click(noMarks, "b", { toggle: true });
    expect(one.keys).toEqual(["b"]);
    const two = click(one, "d", { toggle: true });
    expect(two.keys).toEqual(["b", "d"]);
    expect(click(two, "b", { toggle: true }).keys).toEqual(["d"]);
  });

  it("işaretler listedeki sıraya dizilir", () => {
    const state = click(click(noMarks, "d", { toggle: true }), "a", { toggle: true });
    expect(state.keys).toEqual(["a", "d"]);
  });

  it("Shift çapadan tıklanana kadarki aralığı seçer, yönü fark etmez", () => {
    const anchored = click(noMarks, "c", { toggle: true });
    expect(click(anchored, "a", { range: true }).keys).toEqual(["a", "b", "c"]);
    expect(click(anchored, "d", { range: true }).keys).toEqual(["c", "d"]);
  });

  it("Shift aralığı öncekilerin yerine geçer; çapa son işaretlenen satırdır", () => {
    const state = click(click(noMarks, "a", { toggle: true }), "d", { toggle: true });
    const ranged = click(state, "c", { range: true });
    expect(ranged.keys).toEqual(["c", "d"]);
    expect(ranged.anchor).toBe("d");
  });

  it("çapa yokken Shift yalnızca tıklanan satırı seçer", () => {
    expect(click(noMarks, "c", { range: true }).keys).toEqual(["c"]);
  });

  it("listede olmayan satır durumu değiştirmez", () => {
    const state = click(noMarks, "b", { toggle: true });
    expect(click(state, "yok", { toggle: true })).toBe(state);
  });
});

describe("pruneMarks", () => {
  it("listeden düşen satırların işaretini bırakır", () => {
    const state: MarkState = { keys: ["a", "c"], anchor: "c" };
    expect(pruneMarks(state, ["a", "b"])).toEqual({ keys: ["a"], anchor: null });
  });

  it("değişiklik yoksa aynı nesneyi döndürür", () => {
    const state: MarkState = { keys: ["a", "b"], anchor: "b" };
    expect(pruneMarks(state, order)).toBe(state);
  });

  it("bölüm değişip liste tümden yenilenince seçim boşalır", () => {
    const state: MarkState = { keys: ["a", "b"], anchor: "a" };
    expect(pruneMarks(state, ["x", "y"])).toEqual(noMarks);
  });
});
