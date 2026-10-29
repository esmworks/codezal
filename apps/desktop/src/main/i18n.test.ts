import { AppSettings } from "@codezal/contracts";
import { LOCALE_CODES } from "@codezal/i18n";
import { describe, expect, it } from "vitest";

/**
 * Dil kayıt defteri bekçisi: `@codezal/i18n` LOCALES ile ayar şeması ayrı yerlerde durur (contracts
 * paketine i18n bağımlılığı eklenmesin diye). Yeni bir dil eklenip enum güncellenmezse burada kırılır.
 */
describe("dil kayıt defteri", () => {
  it("AppSettings.language desteklenen dillerle birebir aynıdır", () => {
    // `.default()` alanı sarmalar; seçenek kümesi iç şemadan okunur.
    expect(AppSettings.shape.language.removeDefault().options).toEqual(LOCALE_CODES);
  });
});
