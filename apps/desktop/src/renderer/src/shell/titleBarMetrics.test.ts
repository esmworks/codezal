import { describe, expect, it } from "vitest";
import { FIRST_BUTTON_LEFT, TITLE_BAR_HEIGHT, titleLeftInset } from "./titleBarMetrics";

describe("başlık şeridi ölçüleri", () => {
  it("başlık, dört düğmenin sağından başlar", () => {
    // Kenar çubuğu, arama, tema, ayar: arama artık gizlenmediği için dördü de yer kaplar.
    expect(titleLeftInset()).toBeGreaterThan(FIRST_BUTTON_LEFT + 4 * 23);
  });

  it("şerit yüksekliği pencere kontrolleriyle aynı kalır", () => {
    expect(TITLE_BAR_HEIGHT).toBe(34);
  });
});
