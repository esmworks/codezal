import { describe, expect, it } from "vitest";

/**
 * Tasarım ölçeği kapısı: `docs/DESIGN.md`de tanımlı tip ve yarıçap basamakları dışında değer
 * kullanılmasını engeller.
 *
 * Neden kapı: ölçek dokümanı tek başına tutmuyor. Ölçtüğümüzde tip boyutları 15 ve 17px gibi ara
 * değerlerle, yarıçaplar 13 basamakla dağılmıştı; her yeni ekran kendi değerini uydurduğunda
 * arayüz yavaşça tutarsızlaşıyor. Kural burada makineyle zorlanır: yeni bir değer ancak
 * `docs/DESIGN.md` ve bu liste birlikte güncellenerek eklenir.
 *
 * Kaynaklar Vite'ın ham glob'uyla okunur (renderer'da `node:fs` yok); `i18nLeak.test.ts` ile aynı
 * desen. Yalnız `text-[Npx]` / `rounded-[Npx]` **sabit** değerleri taranır: Tailwind'in ölçek
 * sınıfları (`text-sm`) ve `calc()`/`var()` tabanlı değerler bu kapının konusu değil.
 */
const SRC = "/src/renderer/src/";
const SOURCES = import.meta.glob("/src/renderer/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `docs/DESIGN.md` §1 tablosu. */
const TYPE_SCALE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 28]);

/**
 * `docs/DESIGN.md` §2 merdiveni + adlandırılmış istisnalar.
 *
 * 18 (karşılama kartı) tek kullanımlık istisnadır ve gerekçesi dokümanda yazar; yeni bir istisna
 * eklemek bilinçli bir karardır.
 */
const RADIUS_SCALE = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18]);

/**
 * Ham nötr renk için adlandırılmış istisnalar (`docs/DESIGN.md` §3): temayı izlememesi gereken
 * içerik yüzeyleri. Her satır bir gerekçe taşır; listeye eklemek bilinçli bir karardır.
 */
const RAW_COLOR_EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
  { file: "panel/BrowserTab.tsx", reason: "web önizlemesi: sayfa arka planı temayı izlemez" },
  {
    file: "screens/asistan/OutputViewer.tsx",
    reason: "HTML çıktı önizlemesi: belge arka planı temayı izlemez",
  },
  { file: "components/Lightbox.tsx", reason: "görsel üstü kaplama: tema ne olursa olsun koyu" },
  { file: "session/Composer.tsx", reason: "görsel üstü kaldır düğmesi: kaplama koyu kalmalı" },
];

const RAW_COLOR = /(?:bg|text|border)-(?:white|black)(?:\/\d+)?/;

/** Test ve tip dosyaları kullanıcıya metin göstermez; üretilen kodu taramayız. */
function isSource(file: string): boolean {
  return !/\.test\.tsx?$|\.d\.ts$/.test(file);
}

function scan(
  pattern: RegExp,
  allowed: Set<number>,
  unit: string,
): { file: string; line: number; value: number; text: string }[] {
  const out: { file: string; line: number; value: number; text: string }[] = [];
  for (const [key, content] of Object.entries(SOURCES)) {
    const file = key.replace(SRC, "");
    if (!isSource(file)) continue;
    content.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(pattern)) {
        const value = Number(match[1]);
        if (allowed.has(value)) continue;
        out.push({ file, line: index + 1, value, text: text.trim() });
      }
    });
  }
  return out.map((f) => ({ ...f, unit }));
}

describe("tasarım ölçeği kapısı", () => {
  it("taranacak kaynak listesi boş değildir", () => {
    // Glob bozulursa kapı sessizce geçmesin.
    expect(Object.keys(SOURCES).filter(isSource).length).toBeGreaterThan(50);
  });

  it("tip boyutları DESIGN.md ölçeğinden seçilir", () => {
    const found = scan(/text-\[(\d+)px\]/g, TYPE_SCALE, "px");
    expect(
      found.map((f) => `${f.file}:${f.line} text-[${f.value}px]`),
      "ölçek dışı tip boyutu (docs/DESIGN.md §1)",
    ).toEqual([]);
  });

  it("yarıçaplar DESIGN.md merdiveninden seçilir", () => {
    const found = scan(/rounded-\[(\d+)px\]/g, RADIUS_SCALE, "px");
    expect(
      found.map((f) => `${f.file}:${f.line} rounded-[${f.value}px]`),
      "merdiven dışı yarıçap (docs/DESIGN.md §2)",
    ).toEqual([]);
  });

  it("ham nötr renk yalnız adlandırılmış istisnalarda kullanılır", () => {
    const allowed = new Set(RAW_COLOR_EXEMPT.map((e) => e.file));
    const findings: string[] = [];
    for (const [key, content] of Object.entries(SOURCES)) {
      const file = key.replace(SRC, "");
      if (!isSource(file) || allowed.has(file)) continue;
      content.split("\n").forEach((text, index) => {
        const hit = RAW_COLOR.exec(text);
        if (hit) findings.push(`${file}:${index + 1} ${hit[0]}`);
      });
    }
    expect(
      findings,
      "ham renk: temayı izlememesi gereken bir yüzey değilse belirteç kullan (docs/DESIGN.md §3)",
    ).toEqual([]);
  });

  it("istisna listesi gerçekten kullanılıyor (ölü muafiyet kalmasın)", () => {
    const unused = RAW_COLOR_EXEMPT.filter((e) => {
      const content = SOURCES[`${SRC}${e.file}`];
      return !content || !RAW_COLOR.test(content);
    });
    expect(
      unused.map((e) => e.file),
      "muafiyet artık gereksiz: ham renk kalktıysa istisnayı da sil",
    ).toEqual([]);
  });
});
