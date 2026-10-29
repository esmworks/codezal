import { describe, expect, it } from "vitest";
import { menuPos } from "./menuPos";

const VIEW = { width: 1200, height: 800 };

describe("menuPos", () => {
  it("yer varsa öğenin altına açar", () => {
    const p = menuPos({ top: 100, bottom: 120, left: 300 }, { width: 220, height: 160 }, VIEW);
    expect(p.top).toBe(124);
    expect(p.left).toBe(300);
  });

  it("altta yer yoksa üstüne çevirir; alt ucu pencere içinde kalır", () => {
    // Composer'daki mod menüsü: dört açıklamalı satır, tutunduğu düğme pencerenin altında.
    const menu = { width: 340, height: 220 };
    const p = menuPos({ top: 740, bottom: 760, left: 560 }, menu, VIEW);
    expect(p.top).toBe(516);
    expect(p.top + menu.height).toBeLessThanOrEqual(VIEW.height);
  });

  it("iki yöne de sığmazsa geniş tarafa yaslar ve yüksekliği sınırlar", () => {
    const p = menuPos({ top: 380, bottom: 400, left: 20 }, { width: 220, height: 900 }, VIEW);
    expect(p.top).toBe(404);
    expect(p.maxHeight).toBe(388);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEW.height);
  });

  it("sağ kenardan taşan menüyü içeri çeker, sol kenarı da aşmaz", () => {
    const wide = menuPos({ top: 100, bottom: 120, left: 1150 }, { width: 300, height: 100 }, VIEW);
    expect(wide.left).toBe(892);
    const narrow = menuPos({ top: 100, bottom: 120, left: 10 }, { width: 1400, height: 100 }, VIEW);
    expect(narrow.left).toBe(8);
  });
});
