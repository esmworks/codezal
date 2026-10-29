import { describe, expect, it } from "vitest";
import { createI18n, dict, en, LOCALE_CODES, localeOf, localeTag, tr } from "./index.js";

/** Nesne ağacının yaprak anahtar yollarını sıralı döndürür ("a.b.c"). */
function leaves(o: unknown, prefix = ""): string[] {
  if (typeof o !== "object" || o === null) return [prefix.slice(1)];
  return Object.entries(o)
    .flatMap(([k, v]) => leaves(v, `${prefix}.${k}`))
    .sort();
}

describe("sözlükler", () => {
  it("en, tr ile birebir aynı anahtar kümesine sahiptir", () => {
    expect(leaves(en)).toEqual(leaves(tr));
  });

  it("tüm değerler boş değildir", () => {
    for (const dict of [tr, en]) {
      for (const path of leaves(dict)) {
        const value = path
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], dict);
        expect(String(value).trim().length, `boş değer: ${path}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("createI18n", () => {
  it("dil değişince çeviriyi günceller", async () => {
    const i18n = createI18n("tr");
    expect(i18n.t("common.cancel")).toBe("İptal");
    await i18n.changeLanguage("en");
    expect(i18n.t("common.cancel")).toBe("Cancel");
  });

  it("fallback dil tr'dir, bilinmeyen anahtar anahtar adını döndürür", () => {
    const i18n = createI18n("en");
    expect(i18n.t("agent.tool.read")).toBe("Read");
    // @ts-expect-error bilinmeyen anahtar yazım denetiminde yasak; çalışma zamanında anahtar adı döner
    expect(i18n.t("yok.anahtar")).toBe("yok.anahtar");
  });
});

describe("localeTag", () => {
  it("dil kodunu Intl etiketine çevirir", () => {
    expect(localeTag("tr")).toBe("tr-TR");
    expect(localeTag("en")).toBe("en-US");
  });

  it("kayıt defteri sırası Ayarlar'daki dil listesiyle aynıdır", () => {
    expect(LOCALE_CODES).toEqual(["tr", "en"]);
  });
});

describe("localeOf", () => {
  it("desteklenen etiketi dile indirger", () => {
    expect(localeOf("tr-TR")).toBe("tr");
    expect(localeOf("tr")).toBe("tr");
    expect(localeOf("en-GB")).toBe("en");
    expect(localeOf("EN")).toBe("en");
  });

  it("desteklenmeyen ya da boş etikette İngilizceye düşer", () => {
    expect(localeOf("de-DE")).toBe("en");
    expect(localeOf("")).toBe("en");
    expect(localeOf(undefined)).toBe("en");
    // Prototip anahtarı dil sanılmamalı (isLocale `in` yerine Object.hasOwn kullanır).
    expect(localeOf("toString")).toBe("en");
    expect(localeOf("constructor")).toBe("en");
  });
});

describe("dict", () => {
  it("dilin sözlüğünü döndürür", () => {
    expect(dict("tr").common.cancel).toBe("İptal");
    expect(dict("en").common.cancel).toBe("Cancel");
  });
});
