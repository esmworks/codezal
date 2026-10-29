import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { ErrorBar, ErrorText, splitError } from "./ErrorBar";

/**
 * Hata yüzeyi kuralı: hata **renkle** değil, baştaki bilgi ikonu ve metinle anlatılır. Bu test
 * kuralı kilitler — kırmızı yeniden sızarsa (tuval değişse bile) burada kırılır.
 */
const RED = /text-red|bg-red|border-red/;

describe("splitError", () => {
  it("ilk satırı mesaj, kalanını ayrıntı yapar", () => {
    expect(splitError("Özet satırı\nGövde 1\nGövde 2")).toEqual({
      text: "Özet satırı",
      detail: "Gövde 1\nGövde 2",
    });
  });

  it("tek satırda ayrıntı boş kalır", () => {
    expect(splitError("  Yalnız mesaj  ")).toEqual({ text: "Yalnız mesaj", detail: "" });
  });
});

describe("ErrorBar", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  it("mesajı ve eylemleri yazar, ayrıntıyı kapalı tutar", () => {
    const html = renderToStaticMarkup(
      <ErrorBar text="Kota doldu" detail="Ham yığın izi" onDismiss={() => {}} />,
    );
    expect(html).toContain("Kota doldu");
    expect(html).toContain("Ayrıntılar");
    expect(html).toContain("Kopyala");
    expect(html).toContain("Kapat");
    // Ayrıntı gövdesi yalnız "Ayrıntılar" açılınca çizilir.
    expect(html).not.toContain("Ham yığın izi");
  });

  it("kırmızı kullanmaz", () => {
    const html = renderToStaticMarkup(
      <ErrorBar text="Komut başarısız" detail="çıktı" action={{ label: "Günlüğü aç", run() {} }} />,
    );
    expect(html).not.toMatch(RED);
  });

  it("ayrıntı yoksa Ayrıntılar düğmesi çizilmez", () => {
    const html = renderToStaticMarkup(<ErrorBar text="Yalnız mesaj" />);
    expect(html).not.toContain("Ayrıntılar");
    expect(html).toContain("Yalnız mesaj");
  });

  it("tek satıra sığmayan uzun mesajda da Ayrıntılar çıkar", () => {
    const long = "Sağlayıcı yanıt vermedi: ".repeat(8);
    expect(renderToStaticMarkup(<ErrorBar text={long} />)).toContain("Ayrıntılar");
  });

  it("satır içi biçim de kırmızı kullanmaz", () => {
    expect(renderToStaticMarkup(<ErrorText text="Dosya okunamadı" />)).not.toMatch(RED);
  });
});
