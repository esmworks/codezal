import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlipNumber, turnSlots } from "./FlipNumber";

/** Etiketler soyulunca görünen metin: rakam yuvaları ayrı öğeler olduğu için düz metin olarak okunur. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

describe("turnSlots", () => {
  it("ilk çizimde hiçbir yuva çevrilmez", () => {
    expect(turnSlots(null, "42")).toEqual([
      { place: 2, char: "4", turn: false },
      { place: 1, char: "2", turn: false },
    ]);
  });

  it("yalnız değişen rakamı çevirir, yerinde kalanı bırakır", () => {
    expect(turnSlots("1204", "1209")).toEqual([
      { place: 4, char: "1", was: "1", turn: false },
      { place: 3, char: "2", was: "2", turn: false },
      { place: 2, char: "0", was: "0", turn: false },
      { place: 1, char: "9", was: "4", turn: true },
    ]);
  });

  it("basamak eklenince birler basamağı yerinde kalır, yeni yuva solda doğar", () => {
    expect(turnSlots("9", "10")).toEqual([
      { place: 2, char: "1", turn: true },
      { place: 1, char: "0", was: "9", turn: true },
    ]);
  });

  it("basamak düşünce artan yuva çevrilir", () => {
    expect(turnSlots("120", "20")).toEqual([
      { place: 2, char: "2", was: "2", turn: false },
      { place: 1, char: "0", was: "0", turn: false },
    ]);
  });

  it("aynı değerde hiçbir yuva çevrilmez", () => {
    expect(turnSlots("7", "7")).toEqual([{ place: 1, char: "7", was: "7", turn: false }]);
  });
});

describe("FlipNumber", () => {
  it("sayıyı rakam yuvalarına böler", () => {
    const html = renderToStaticMarkup(<FlipNumber value={1204} />);
    expect(visible(html)).toBe("1204");
    expect(html.match(/cz-turn/g)?.length).toBe(4);
  });

  it("ilk çizim sessizdir: çevirme sınıfı ve eski rakam çizilmez", () => {
    const html = renderToStaticMarkup(<FlipNumber value={42} />);
    expect(html).not.toContain("cz-turn-in");
    expect(html).not.toContain("cz-turn-out");
  });
});
