import type { ImageAttachment } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  addQuote,
  type ComposerDraft,
  emptyDraft,
  expandDraft,
  hasMessage,
  insertPaste,
  isDraftEmpty,
  mergeImages,
  normalizePaste,
  pasteLineCount,
  removeImageAt,
  removeQuoteAt,
  sameDraft,
  shouldCollapsePaste,
  syncDraft,
  uniquePlaceholder,
} from "./composerParts";

function image(name: string): ImageAttachment {
  return { mimeType: "image/png", data: "AAAA", name };
}

function draft(text: string): ComposerDraft {
  return { text, pastes: [], images: [], quotes: [] };
}

const chip = "[Yapıştırıldı ~3 satır]";

describe("shouldCollapsePaste", () => {
  it("kısa tek satırı ve 2 satırı çipe çevirmez", () => {
    expect(shouldCollapsePaste("merhaba")).toBe(false);
    expect(shouldCollapsePaste("bir\niki")).toBe(false);
  });

  it("3 satırı ve 150+ karakteri çipe çevirir", () => {
    expect(shouldCollapsePaste("bir\niki\nüç")).toBe(true);
    expect(shouldCollapsePaste("a".repeat(151))).toBe(true);
    expect(shouldCollapsePaste("a".repeat(150))).toBe(false);
  });
});

describe("pasteLineCount", () => {
  it("sondaki satır sonunu fazladan saymaz", () => {
    expect(pasteLineCount("bir\niki\n")).toBe(2);
    expect(pasteLineCount("bir\niki\nüç")).toBe(3);
  });
});

describe("normalizePaste", () => {
  it("CRLF ve tek CR'yi LF'ye indirir", () => {
    expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizePaste("a\nb")).toBe("a\nb");
  });
});

describe("insertPaste", () => {
  it("yer tutucuyu imlece koyar ve sonraki parçayı kaydırır", () => {
    const first = insertPaste(draft("baş son"), "uzun içerik", chip, 4, 4);
    expect(first.text).toBe(`baş ${chip}son`);
    expect(first.pastes.map((p) => p.start)).toEqual([4]);

    const second = insertPaste(
      first,
      "ikinci",
      "[Yapıştırıldı ~9 satır]",
      first.text.length,
      first.text.length,
    );
    expect(second.text).toBe(`baş ${chip}son[Yapıştırıldı ~9 satır]`);
    expect(second.pastes.map((p) => p.start)).toEqual([4, 4 + chip.length + 3]);
    expect(second.pastes[0]?.text).toBe("uzun içerik");
  });

  it("parçadan önce eklenen yeni parça eskisini kaydırır", () => {
    const head = "[Yapıştırıldı ~7 satır]";
    const first = insertPaste(draft("son"), "eski", chip, 0, 0);
    const second = insertPaste(first, "yeni", head, 0, 0);
    expect(second.text).toBe(`${head}${chip}son`);
    expect(second.pastes.map((p) => [p.start, p.text])).toEqual([
      [0, "yeni"],
      [head.length, "eski"],
    ]);
  });

  it("seçili metnin üstüne yapıştırınca yer tutucu o aralığa geçer", () => {
    const d = draft("sil bunu son");
    const next = insertPaste(d, "gerçek", chip, 0, 9);
    expect(next.text).toBe(`${chip}son`);
    expect(next.pastes[0]?.text).toBe("gerçek");
  });

  it("üstüne yazılan eski parçayı düşürür", () => {
    const first = insertPaste(draft(""), "eski", chip, 0, 0);
    const second = insertPaste(first, "yeni", "[Yapıştırıldı ~7 satır]", 0, first.text.length);
    expect(second.pastes).toHaveLength(1);
    expect(second.pastes[0]?.text).toBe("yeni");
    expect(second.text).toBe("[Yapıştırıldı ~7 satır]");
  });
});

describe("syncDraft", () => {
  it("aynı boyda iki yapıştırmada biri silinince kalan kendi içeriğini taşır", () => {
    const a = insertPaste(draft(""), "A içeriği", chip, 0, 0);
    const second = uniquePlaceholder(a.pastes, chip);
    expect(second).toBe(`${chip} #2`);
    const b = insertPaste(a, "B içeriği", second, a.text.length, a.text.length);
    // Birinci etiket silindi: yalnız ikincinin yer tutucusu metinde kalır.
    expect(expandDraft(syncDraft(b, second))).toBe("B içeriği");
    expect(uniquePlaceholder(b.pastes, chip)).toBe(`${chip} #3`);
  });

  it("parça öncesine yazılan metinde offseti kaydırır", () => {
    const first = insertPaste(draft("son"), "gerçek", chip, 0, 0);
    const next = syncDraft(first, `baş ${chip}son`);
    expect(next.pastes[0]?.start).toBe(4);
    expect(expandDraft(next)).toBe("baş gerçekson");
  });

  it("parça sonrasına yazılan metinde offseti korur", () => {
    const first = insertPaste(draft(""), "gerçek", chip, 0, 0);
    const next = syncDraft(first, `${chip} devam`);
    expect(next.pastes[0]?.start).toBe(0);
    expect(expandDraft(next)).toBe("gerçek devam");
  });

  it("yer tutucusu silinen parçayı düşürür", () => {
    const first = insertPaste(draft("x "), "gerçek", chip, 2, 2);
    const next = syncDraft(first, "x ");
    expect(next.pastes).toHaveLength(0);
    expect(next.text).toBe("x ");
  });

  it("aynı yer tutucudan iki tane olsa da soldan sağa eşler", () => {
    let d = insertPaste(draft(""), "birinci", chip, 0, 0);
    d = insertPaste(d, "ikinci", chip, d.text.length, d.text.length);
    const next = syncDraft(d, `baş ${chip} orta ${chip}`);
    expect(next.pastes.map((p) => [p.start, p.text])).toEqual([
      [4, "birinci"],
      [4 + chip.length + " orta ".length, "ikinci"],
    ]);
    expect(expandDraft(next)).toBe("baş birinci orta ikinci");
  });
});

describe("expandDraft", () => {
  it("birden çok parçayı sondan başa genişletir", () => {
    let d = insertPaste(draft("A "), "BİR\nİKİ\nÜÇ", chip, 2, 2);
    d = insertPaste(d, "SON", "[Yapıştırıldı ~2 satır]", d.text.length, d.text.length);
    expect(expandDraft(d)).toBe("A BİR\nİKİ\nÜÇSON");
    expect(d.text).toContain(chip);
  });

  it("offset kaymışsa eşleşmeden kurtarır", () => {
    const first = insertPaste(draft("x"), "gerçek", chip, 1, 1);
    const stale: ComposerDraft = {
      ...first,
      pastes: first.pastes.map((p) => ({ ...p, start: 99, end: 150 })),
    };
    expect(expandDraft(stale)).toBe(`xgerçek`);
  });

  it("yer tutucu bozulmuşsa metni olduğu gibi bırakır", () => {
    const first = insertPaste(draft(""), "gerçek", chip, 0, 0);
    expect(expandDraft({ ...first, text: "yer tutucu yok" })).toBe("yer tutucu yok");
  });
});

describe("mergeImages", () => {
  it("sınıra kadar ekler, fazlasını reddeder", () => {
    const cur: ComposerDraft = { ...emptyDraft(), images: [image("a"), image("b")] };
    const r = mergeImages(cur, [image("c"), image("d")], 3);
    expect(r.added).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.draft.images).toHaveLength(3);

    const full = mergeImages(r.draft, [image("e")], 3);
    expect(full.added).toBe(0);
    expect(full.draft.images).toBe(r.draft.images);
  });
});

describe("yardımcılar", () => {
  it("removeImageAt yalnız hedef görseli çıkarır", () => {
    const d: ComposerDraft = { ...emptyDraft(), images: [image("a"), image("b")] };
    const next = removeImageAt(d, 0);
    expect(next.images.map((i) => i.name)).toEqual(["b"]);
  });

  it("isDraftEmpty boş metin ve görselle doğru döner", () => {
    expect(isDraftEmpty(emptyDraft())).toBe(true);
    expect(isDraftEmpty({ ...emptyDraft(), text: "  " })).toBe(true);
    expect(isDraftEmpty({ ...emptyDraft(), images: [image("a")] })).toBe(false);
    expect(isDraftEmpty(draft("x"))).toBe(false);
  });

  it("sameDraft metin, parça ve görsel değişimini yakalar", () => {
    const a = insertPaste(draft("x"), "gerçek", chip, 1, 1);
    expect(sameDraft(a, { ...a, text: a.text })).toBe(true);
    expect(sameDraft(a, syncDraft(a, "xy"))).toBe(false);
    expect(sameDraft(a, { ...a, images: [image("a")] })).toBe(false);
  });
});

describe("alıntılar", () => {
  it("alıntıyı normalleştirip ekler, boş ve tekrar eden alıntıyı yok sayar", () => {
    const one = addQuote(emptyDraft(), "  a\r\nb  ");
    expect(one.quotes).toEqual(["a\nb"]);
    expect(addQuote(one, "a\nb")).toBe(one);
    expect(addQuote(one, "   ")).toBe(one);
    expect(removeQuoteAt(addQuote(one, "c"), 0).quotes).toEqual(["c"]);
  });

  it("tek başına alıntı saklanır ama gönderilecek mesaj sayılmaz", () => {
    const quoted = addQuote(emptyDraft(), "a");
    expect(isDraftEmpty(quoted)).toBe(false);
    expect(hasMessage(quoted)).toBe(false);
    expect(hasMessage({ ...quoted, text: "neden?" })).toBe(true);
  });

  it("yazım ve yapıştırma alıntıları korur", () => {
    const quoted = addQuote(draft(""), "a");
    expect(syncDraft(quoted, "x").quotes).toBe(quoted.quotes);
    expect(insertPaste(quoted, "uzun\nmetin\nburada", chip, 0, 0).quotes).toBe(quoted.quotes);
    expect(sameDraft(quoted, addQuote(quoted, "b"))).toBe(false);
  });
});
