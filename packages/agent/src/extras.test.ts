import { describe, expect, it } from "vitest";
import { mergeExtraSystem } from "./extras.js";

describe("mergeExtraSystem", () => {
  it("iki taraf da doluysa boş satırla birleştirir (öncelik ezmesi yok)", () => {
    expect(mergeExtraSystem("tür kuralı", "sözleşme")).toBe("tür kuralı\n\nsözleşme");
  });
  it("boş ve boşluk dolu parçaları eler", () => {
    expect(mergeExtraSystem("a", undefined, "   ", "b")).toBe("a\n\nb");
  });
  it("hepsi boşsa undefined döner (istem girmez)", () => {
    expect(mergeExtraSystem(undefined, "  ")).toBeUndefined();
  });
  it("tek dolu parçada onu döner", () => {
    expect(mergeExtraSystem(undefined, "sözleşme")).toBe("sözleşme");
  });
});
