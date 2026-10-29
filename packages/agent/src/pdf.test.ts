import { describe, expect, it } from "vitest";
import { writePdf } from "./pdf.fixture.js";
import { findMatches, readPdfContent, searchPdfContent } from "./pdf.js";

describe("readPdfContent", () => {
  it("metin katmanını sayfa sayfa çıkarır", async () => {
    const path = await writePdf([{ text: "Codezal metin katmani" }, { text: "Ikinci sayfa" }]);
    const content = await readPdfContent(path, { vision: true });
    expect(content.every((c) => c.type === "text")).toBe(true);
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(all).toContain("belge.pdf");
    expect(all).toContain("2 sayfa");
    expect(all).toContain("Codezal metin katmani");
    expect(all).toContain("Ikinci sayfa");
  });

  it("metinsiz sayfayı görüntü olarak ekler", async () => {
    const path = await writePdf([{}]);
    const content = await readPdfContent(path, { vision: true });
    const image = content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image?.type === "image" && image.mimeType).toBe("image/jpeg");
    expect(image?.type === "image" && image.data.length).toBeGreaterThan(100);
  });

  it("model görsel okuyamıyorsa görüntü göndermez, sebebini yazar", async () => {
    const path = await writePdf([{}]);
    const content = await readPdfContent(path, { vision: false });
    expect(content.some((c) => c.type === "image")).toBe(false);
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(all).toContain("taranmış");
  });

  it("etiketten ibaret çizim sayfası hem metni hem görüntüsüyle gelir", async () => {
    const path = await writePdf([{ text: "TYPE H", paths: 200 }]);
    const content = await readPdfContent(path, { vision: true });
    expect(content.some((c) => c.type === "image")).toBe(true);
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    // Etiketler görüntüyle birlikte gönderilir; model çizimdeki adı metinde de arayabilir.
    expect(all).toContain("TYPE H");
    expect(all).toContain("çizim");
  });

  it("metni sayfayı anlatan sayfa çizim taşısa da görüntüye çevrilmez", async () => {
    const path = await writePdf([{ text: "Uzun metin ".repeat(150), paths: 200 }]);
    const content = await readPdfContent(path, { vision: true });
    expect(content.some((c) => c.type === "image")).toBe(false);
  });

  it("çizimi olmayan kısa metin sayfası görüntüye çevrilmez", async () => {
    const path = await writePdf([{ text: "Kisa not" }]);
    const content = await readPdfContent(path, { vision: true });
    expect(content.some((c) => c.type === "image")).toBe(false);
  });

  it("offset verilen sayfadan başlar", async () => {
    const path = await writePdf([{ text: "Birinci" }, { text: "Ikinci" }, { text: "Ucuncu" }]);
    const content = await readPdfContent(path, { vision: true, firstPage: 3 });
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(all).toContain("Ucuncu");
    expect(all).not.toContain("Birinci");
  });

  it("pageLimit sayfa sayısıdır; kalan için devam notu düşer", async () => {
    const path = await writePdf([{ text: "Birinci" }, { text: "Ikinci" }, { text: "Ucuncu" }]);
    const content = await readPdfContent(path, { vision: true, pageLimit: 1 });
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(all).toContain("Birinci");
    expect(all).not.toContain("Ikinci");
    expect(all).toContain("offset=2");
  });

  it("render istenince metin sayfası da görüntüsüyle gelir", async () => {
    const path = await writePdf([{ text: "Uzun metin ".repeat(150) }]);
    const content = await readPdfContent(path, { vision: true, render: true });
    expect(content.some((c) => c.type === "image")).toBe(true);
    const all = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(all).toContain("sayfa görüntüsü aşağıda");
    expect(all).toContain("Uzun metin");
  });
});

const textOf = (content: readonly { type: string; text?: string }[]) =>
  content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

describe("PDF yer imleri", () => {
  const outline = [
    { title: "Giris", page: 1 },
    {
      title: "Evaporatorler",
      page: 3,
      children: [{ title: "GS serisi", page: 4, children: [{ title: "Derin", page: 4 }] }],
    },
  ];

  it("okumaya sığmayan belgenin ilk açılışında içindekileri sayfa numarasıyla verir", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ text: `Sayfa ${i + 1}` }));
    const path = await writePdf(pages, "katalog.pdf", outline);
    const all = textOf(await readPdfContent(path, { vision: true, pageLimit: 2 }));
    expect(all).toContain("İçindekiler");
    expect(all).toContain("- Giris (s. 1)");
    expect(all).toContain("- Evaporatorler (s. 3)");
    expect(all).toContain("  - GS serisi (s. 4)");
    expect(all).toContain("    - Derin (s. 4)");
    expect(all).toContain("search");
  });

  it("ilk okumada offset: 1 verilse de içindekiler gelir", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ text: `Sayfa ${i + 1}` }));
    const path = await writePdf(pages, "katalog.pdf", outline);
    const all = textOf(await readPdfContent(path, { vision: true, firstPage: 1, pageLimit: 2 }));
    expect(all).toContain("İçindekiler");
  });

  it("belge tek okumaya sığıyorsa ya da devam okumasıysa içindekiler ve ipucu eklenmez", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ text: `Sayfa ${i + 1}` }));
    const path = await writePdf(pages, "katalog.pdf", outline);
    expect(textOf(await readPdfContent(path, { vision: true }))).not.toContain("İçindekiler");
    const later = textOf(await readPdfContent(path, { vision: true, firstPage: 2, pageLimit: 1 }));
    expect(later).not.toContain("İçindekiler");
    expect(later).not.toContain("search");
  });

  it("yer imi olmayan uzun belgede yalnızca arama ipucu gelir", async () => {
    const path = await writePdf([{ text: "Bir" }, { text: "Iki" }, { text: "Uc" }]);
    const all = textOf(await readPdfContent(path, { vision: true, pageLimit: 1 }));
    expect(all).not.toContain("İçindekiler");
    expect(all).toContain("search");
  });
});

describe("PDF içinde arama", () => {
  it("eşleşen sayfaları sayı ve alıntıyla döndürür", async () => {
    const path = await writePdf([
      { text: "Kondenser tablosu" },
      { text: "GS-450 evaporator kapasitesi 12 kW. GS-450 icin fan 2 adet." },
      { text: "Baska urun" },
      { text: "Aksesuar: gs-450 montaj seti" },
    ]);
    const all = textOf(await searchPdfContent(path, "GS-450"));
    expect(all).toContain("4 sayfa");
    expect(all).toContain("2 sayfada 3 eşleşme");
    expect(all).toContain("--- sayfa 2 (2 eşleşme) ---");
    expect(all).toContain("--- sayfa 4 (1 eşleşme) ---");
    expect(all).toContain("kapasitesi 12 kW");
    expect(all).not.toContain("sayfa 1 (");
  });

  it("çok sayfada eşleşen genel terimde sayfa başına tek alıntı verir", async () => {
    const page = { text: `kod X1 ${"-".repeat(120)} kod X1` };
    const path = await writePdf(Array.from({ length: 12 }, () => page));
    const all = textOf(await searchPdfContent(path, "X1"));
    expect(all).toContain("12 sayfada 24 eşleşme");
    expect(all.match(/kod X1/g)).toHaveLength(12);
  });

  it("bulunamayınca söyler, metinsiz sayfaları aranamadı diye listeler", async () => {
    const path = await writePdf([{ text: "Metin" }, {}, { text: "Metin" }, {}]);
    const all = textOf(await searchPdfContent(path, "yok-boyle-kod"));
    expect(all).toContain("bulunamadı");
    expect(all).toContain("2 sayfada metin katmanı yok");
    expect(all).toContain(": 2, 4.");
  });

  it("iptal edilince durur", async () => {
    const path = await writePdf([{ text: "Metin" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(searchPdfContent(path, "Metin", { signal: controller.signal })).rejects.toThrow();
  });
});

describe("findMatches", () => {
  it("büyük/küçük harf, Türkçe karakter ve satır sonu farkını yok sayar", () => {
    expect(findMatches("SOĞUTMA ÜNİTESİ", "soğutma").count).toBe(1);
    expect(findMatches("Soğutma ünitesi", "SOGUTMA UNITESI").count).toBe(1);
    expect(findMatches("KAPASİTE", "kapasite").count).toBe(1);
    expect(findMatches("ısıl yük", "ISIL").count).toBe(1);
    expect(findMatches("GS\n450", "GS 450").count).toBe(1);
    expect(findMatches("metin", "   ").count).toBe(0);
  });

  it("alıntıyı özgün metinden keser, yakın eşleşmeleri tek alıntıda gösterir", () => {
    const text = `${"a".repeat(200)} Soğutucu R404A ve R404A dolum ${"b".repeat(200)}`;
    const found = findMatches(text, "r404a");
    expect(found.count).toBe(2);
    expect(found.snippets).toHaveLength(1);
    expect(found.snippets[0]).toContain("Soğutucu R404A ve R404A dolum");
    expect(found.snippets[0]?.startsWith("…")).toBe(true);
    expect(found.snippets[0]?.endsWith("…")).toBe(true);
  });

  it("sayfa başına en çok üç alıntı verir ama hepsini sayar", () => {
    const text = Array.from({ length: 6 }, () => `kod X1 ${"-".repeat(200)}`).join(" ");
    const found = findMatches(text, "X1");
    expect(found.count).toBe(6);
    expect(found.snippets).toHaveLength(3);
  });
});
