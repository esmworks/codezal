import { beforeEach, describe, expect, it } from "vitest";
import {
  atHistoryEdge,
  historyFor,
  historyNext,
  historyPrev,
  MAX_HISTORY,
  rememberPrompt,
} from "./promptHistory";

/**
 * `dom-shim.ts` yalnızca `.tsx` bileşen testlerine bağlanıyor (bkz. `vitest.config.ts`); bu dosya
 * düz Node projesinde koştuğu için depolama burada kurulur.
 */
const store = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

describe("istem geçmişi", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("en yeni istemi başa yazar", () => {
    rememberPrompt("p1", "birinci");
    rememberPrompt("p1", "ikinci");
    expect(historyFor("p1")).toEqual(["ikinci", "birinci"]);
  });

  it("aynı istemi ikinci kez eklemez, başa alır", () => {
    rememberPrompt("p1", "tekrar");
    rememberPrompt("p1", "başka");
    rememberPrompt("p1", "tekrar");
    expect(historyFor("p1")).toEqual(["tekrar", "başka"]);
  });

  it("boş istemi ve proje karışmasını engeller", () => {
    rememberPrompt("p1", "   ");
    rememberPrompt("p1", "a");
    rememberPrompt("p2", "b");
    expect(historyFor("p1")).toEqual(["a"]);
    expect(historyFor("p2")).toEqual(["b"]);
  });

  it("listeyi üst sınırda tutar", () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) rememberPrompt("p1", `istek-${i}`);
    const list = historyFor("p1");
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0]).toBe(`istek-${MAX_HISTORY + 4}`);
  });

  it("↑ ile eskiden yeniye doğru gezinir ve taslağı saklar", () => {
    rememberPrompt("p1", "eski");
    rememberPrompt("p1", "yeni");
    const list = historyFor("p1");

    const first = historyPrev(list, { index: null, draft: "" }, "yazıyordum");
    expect(first.text).toBe("yeni");
    const second = historyPrev(list, first.cursor, first.text);
    expect(second.text).toBe("eski");
    // Listenin başında kalır.
    const third = historyPrev(list, second.cursor, second.text);
    expect(third.text).toBe("eski");
    expect(third.cursor.index).toBe(1);
  });

  it("↓ ile listenin sonunda taslağa döner ve taslağı imleçte taşır", () => {
    rememberPrompt("p1", "eski");
    rememberPrompt("p1", "yeni");
    const list = historyFor("p1");
    // Taslak metin değil **nesne**: yapıştırma parçaları ve görseller de geri gelmeli.
    const draft = { text: "taslak", pastes: ["p1"], images: ["i1"] };

    const up1 = historyPrev(list, { index: null, draft }, draft);
    const up2 = historyPrev(list, up1.cursor, draft);
    const down1 = historyNext(list, up2.cursor);
    expect(down1.text).toBe("yeni");
    const down2 = historyNext(list, down1.cursor);
    // Metin boş döner; taslak `cursor.draft`tan geri yüklenir (çağıran `applyDraft` çağırır).
    expect(down2.cursor.index).toBeNull();
    expect(down2.cursor.draft).toEqual(draft);
  });

  it("gezinme yokken ↓ kutuyu boşaltmaz", () => {
    // Regresyon: `index === null` iken ↓ çağrılırsa boş metin dönüyordu ve çağıran kutuyu
    // temizliyordu; oysa o durumda ↓ normal satır gezinmesidir.
    const step = historyNext(historyFor("p1"), { index: null, draft: { text: "yazdım" } });
    expect(step.cursor.index).toBeNull();
    expect(step.text).toBe("");
  });

  it("geçmiş boşken ↑ hiçbir şeyi değiştirmez", () => {
    const step = historyPrev([], { index: null, draft: "taslak" }, "taslak");
    expect(step.cursor.index).toBeNull();
  });
});

describe("atHistoryEdge", () => {
  it("tek satırlı metinde her iki yönde de geçmişe izin verir", () => {
    expect(atHistoryEdge("tek satır", 9, 9, "up")).toBe(true);
    expect(atHistoryEdge("tek satır", 9, 9, "down")).toBe(true);
  });

  it("çok satırlı metinde yalnız ilk/son satırdayken geçmişe izin verir", () => {
    const value = "ilk satır\nikinci satır";
    // İlk satırın sonunda: ↑ geçmişe gider, ↓ satır içinde kalır.
    expect(atHistoryEdge(value, 3, 3, "up")).toBe(true);
    expect(atHistoryEdge(value, 3, 3, "down")).toBe(false);
    // Son satırın sonunda: ↓ geçmişe gider, ↑ satır içinde kalır.
    expect(atHistoryEdge(value, value.length, value.length, "up")).toBe(false);
    expect(atHistoryEdge(value, value.length, value.length, "down")).toBe(true);
  });

  it("seçim varken geçmişe gitmez", () => {
    expect(atHistoryEdge("metin", 1, 3, "up")).toBe(false);
  });
});
