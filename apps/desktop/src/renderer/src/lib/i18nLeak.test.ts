import { describe, expect, it } from "vitest";

/**
 * Çevrilmemiş metin kapısı: renderer'da kullanıcıya görünen metin `@codezal/i18n` sözlüğünden gelir.
 * Tarama; yorumları, test dosyalarını ve tip bildirimlerini atlar, Türkçeye özgü harf (`ğ ş ı İ ö ü ç`)
 * içeren satır bulursa dosya:satır ile listeler. Kapı Türkçe kapsamına odaklıdır: İngilizce bir dize
 * sızsa burada görünmez (onu sözlük anahtar eşitliği testi ve gözden geçirme yakalar).
 *
 * Kaynaklar Vite'ın ham glob'uyla okunur: renderer projesinde Node API'si yok (contextIsolation ve
 * sandbox açık), bu yüzden `node:fs` kullanılmaz. Glob kök-göreli yazılır; anahtar yol ile muafiyet
 * listesindeki dosya adları aynı biçimde kalsın diye `SRC` öneki kırpılır.
 */
const SRC = "/src/renderer/src/";
const SOURCES = import.meta.glob("/src/renderer/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TURKISH = /[ğĞşŞıİöÖüÜçÇ]/;

/**
 * Muafiyetler: bunlar kullanıcıya gösterilen metin değil, **veri değerleri**. Buraya satır eklemek
 * bilinçli bir karardır; görünen metin eklerken doğru yer sözlüktür (tr.ts + en.ts).
 */
const EXEMPT: ReadonlyArray<{ file: string; contains: string }> = [
  // Panel sekmesi kimliği (PanelTab): durum değeri, görünen ad sözlükten gelir (`panel.browser`).
  { file: "stores/panel.ts", contains: "Tarayıcı" },
  { file: "panel/Panel.tsx", contains: "Tarayıcı" },
  { file: "App.tsx", contains: "Tarayıcı" },
  // Türkçe harf taşıyan ikinci sekme kimliği (Değişiklikler); görünen ad `panel.changes`.
  { file: "stores/panel.ts", contains: "Değişiklikler" },
  { file: "panel/Panel.tsx", contains: "Değişiklikler" },
  { file: "lib/revealChanges.ts", contains: "Değişiklikler" },
  // İş dizini sekmesinin kimliği (İşler); görünen ad `panel.jobs`.
  { file: "stores/panel.ts", contains: "İşler" },
  { file: "panel/Panel.tsx", contains: "İşler" },
  { file: "lib/revealAgent.ts", contains: "İşler" },
  { file: "screens/SessionScreen.tsx", contains: "İşler" },
  // Tema değeri settings.json'a yazılır; kimliktir, görünen adı sözlükten gelir.
  { file: "stores/app.ts", contains: "koyu" },
  { file: "settings/pages/GenelPage.tsx", contains: "açık" },
  // Komut paleti anahtar sözcükleri: yalnızca arama eşleşmesi için, ekranda görünmez.
  { file: "session/chips.tsx", contains: "güvenlik denetim" },
  // Türkçe harfli komut adı deseni (/plan gibi): metin değil, düzenli ifade.
  { file: "lib/skills.ts", contains: "a-zçğıöşü" },
  // Tanılama özeti: günlük satırları gibi kasıtlı olarak çevrilmez (kopyalanıp paylaşılır).
  { file: "settings/pages/DiagnosticsPage.tsx", contains: "oturum:" },
];

/** Blok ve satır sonu yorumlarını boşaltır: yorum metni kullanıcıya görünmez, kapıya girmez. */
function stripComments(lines: readonly string[]): string[] {
  let block = false;
  return lines.map((raw) => {
    let line = raw;
    if (block) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      line = line.slice(end + 2);
      block = false;
    }
    const open = line.indexOf("/*");
    if (open !== -1) {
      const end = line.indexOf("*/", open + 2);
      if (end === -1) {
        block = true;
        line = line.slice(0, open);
      } else line = line.slice(0, open) + line.slice(end + 2);
    }
    return line.replace(/(^|\s)\/\/.*$/, "");
  });
}

/** Test ve tip bildirimi dosyaları kullanıcıya metin göstermez. */
function isSource(file: string): boolean {
  return !/\.test\.tsx?$|\.d\.ts$/.test(file);
}

describe("çevrilmemiş metin kapısı", () => {
  it("taranacak kaynak listesi boş değildir", () => {
    // Glob bozulursa kapı sessizce geçmesin: yüzden çok kaynak yoksa yol yanlış demektir.
    expect(Object.keys(SOURCES).filter(isSource).length).toBeGreaterThan(50);
  });

  it("renderer'da sözlük dışı Türkçe metin bulunmaz", () => {
    const findings: string[] = [];
    for (const [key, content] of Object.entries(SOURCES)) {
      const file = key.replace(SRC, "");
      if (!isSource(file)) continue;
      stripComments(content.split("\n")).forEach((line, index) => {
        if (!TURKISH.test(line)) return;
        const exempt = EXEMPT.some((e) => e.file === file && line.includes(e.contains));
        if (!exempt) findings.push(`${file}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(findings.join("\n")).toBe("");
  });
});
