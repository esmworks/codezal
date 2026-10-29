import { describe, expect, it } from "vitest";
import { anchorDelta, isUserScroll, locateAnchor, planScrollAction } from "./scrollAnchor";

/** Test okuması: sıralı satır kutularından indeksli rect; taşan indeks boş kutu döner. */
function rectAt(list: ReadonlyArray<{ top: number; bottom: number }>) {
  return (index: number) => list[index] ?? { top: 0, bottom: 0 };
}

describe("locateAnchor", () => {
  const rows = [
    { top: -120, bottom: -60 },
    { top: -60, bottom: -10 },
    { top: -10, bottom: 50 },
    { top: 50, bottom: 110 },
  ];

  it("görünür alana giren ilk satırı bulur", () => {
    // Üstte kalan iki satır pencere dışında; görünen ilk satır üçüncüsü.
    expect(locateAnchor(rows.length, rectAt(rows), 0)).toBe(2);
  });

  it("üst kenar tam satır sınırındaysa alttaki satırı seçer", () => {
    // Satırın bottom'u viewportTop'a eşitse artık görünmüyor sayılır.
    expect(locateAnchor(rows.length, rectAt(rows), 50)).toBe(3);
  });

  it("hepsi görünürse ilk satırı döner", () => {
    expect(locateAnchor(rows.length, rectAt(rows), -500)).toBe(0);
  });

  it("hepsi üstte kaldıysa -1 döner", () => {
    expect(locateAnchor(rows.length, rectAt(rows), 500)).toBe(-1);
  });

  it("boş listede -1 döner", () => {
    expect(locateAnchor(0, rectAt([]), 0)).toBe(-1);
  });

  it("rect okuması satır sayısının logaritmasıyla yapılır", () => {
    const list = Array.from({ length: 1024 }, (_, i) => ({ top: i * 10, bottom: i * 10 + 10 }));
    let reads = 0;
    const counted = (index: number) => {
      reads++;
      return rectAt(list)(index);
    };
    expect(locateAnchor(list.length, counted, 5000)).toBe(500);
    expect(reads).toBeLessThan(24);
  });
});

describe("anchorDelta", () => {
  it("aynı satır kaydıysa farkı döner", () => {
    expect(anchorDelta({ key: "g-1", top: 40 }, { key: "g-1", top: 28 })).toBe(-12);
  });

  it("satır değiştiyse telafi yok", () => {
    expect(anchorDelta({ key: "g-1", top: 40 }, { key: "g-2", top: 10 })).toBe(0);
  });

  it("ölçüm eksikse telafi yok", () => {
    expect(anchorDelta(null, { key: "g-1", top: 10 })).toBe(0);
    expect(anchorDelta({ key: "g-1", top: 10 }, null)).toBe(0);
  });

  it("yarım pikselin altındaki oynama yok sayılır", () => {
    expect(anchorDelta({ key: "g-1", top: 10 }, { key: "g-1", top: 10.3 })).toBe(0);
  });
});

describe("isUserScroll", () => {
  it("programatik yazımdan sonraki aynı konum kullanıcı sayılmaz", () => {
    expect(isUserScroll(500, 500)).toBe(false);
  });

  it("yarım pikselin altındaki sapma yok sayılır", () => {
    expect(isUserScroll(500.3, 500)).toBe(false);
  });

  it("konum defterden farklıysa kullanıcı kaydırmıştır", () => {
    expect(isUserScroll(420, 500)).toBe(true);
    expect(isUserScroll(640, 500)).toBe(true);
  });
});

describe("planScrollAction", () => {
  it("dipteyken dibe yapıştırır", () => {
    expect(planScrollAction({ prev: null, now: null, pinned: true })).toEqual({ type: "follow" });
  });

  it("dipteyken katlanma da olsa dibe yapışık kalır", () => {
    // Canlı turda kartlar tek satıra katlanınca içerik kısalır; dipteki kullanıcı en son
    // içeriği izlemeye devam eder (ekranın altı boşalmaz).
    expect(
      planScrollAction({
        prev: { key: "g-1", top: 20 },
        now: { key: "g-1", top: 70 },
        pinned: true,
      }),
    ).toEqual({ type: "follow" });
  });

  it("dipte değilken görünen satırı korur", () => {
    expect(
      planScrollAction({
        prev: { key: "g-2", top: 30 },
        now: { key: "g-2", top: 45 },
        pinned: false,
      }),
    ).toEqual({ type: "nudge", delta: 15 });
  });

  it("kullanıcı kaydırmasından sonra çapa sıfırlanır: sonraki kare geri itmez", () => {
    // Yukarı kaydırma anında çapa null'lanır (isUserScroll true). Bir sonraki apply prev=null
    // ile karar verir; kullanıcının kaydırması telafi edilip dibe dönülmez.
    expect(planScrollAction({ prev: null, now: { key: "g-2", top: 150 }, pinned: false })).toEqual({
      type: "none",
    });
  });

  it("dipte değilken çapa oynamadıysa yazım yapılmaz", () => {
    expect(
      planScrollAction({
        prev: { key: "g-2", top: 30 },
        now: { key: "g-2", top: 30 },
        pinned: false,
      }),
    ).toEqual({ type: "none" });
  });

  it("dipte değilken çapa değiştiyse dokunulmaz", () => {
    expect(
      planScrollAction({
        prev: { key: "g-2", top: 30 },
        now: { key: "g-3", top: 200 },
        pinned: false,
      }),
    ).toEqual({ type: "none" });
  });
});
