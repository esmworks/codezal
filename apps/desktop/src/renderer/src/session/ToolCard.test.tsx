import type { ToolCallItem } from "@codezal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { CommandBody, DiffLines, ToolCard, ToolGroup } from "./ToolCard";

/** Etiketler soyulunca görünen metin: sayaç rakamları ayrı yuvalarda olduğu için düz metin olarak okunur. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

/**
 * Adım listesi kartı: ZCode'un todo kartı gibi satırda "şu an ne yapılıyor" ve "3/7" yazar.
 * Kart yalnız başlıkla kalırsa uzun turda hangi adımda olunduğu sohbetten okunamıyordu.
 */
const tool = (over: Partial<ToolCallItem>): ToolCallItem =>
  ({
    type: "tool",
    id: "t1",
    toolName: "task_list",
    kind: "other",
    status: "done",
    title: "Adımlar yazıldı",
    target: "",
    startedAt: 1,
    endedAt: 2,
    ...over,
  }) as ToolCallItem;

describe("adım listesi kartı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  it("güncel adımı ve biten/toplam sayacını yazar", () => {
    const html = renderToStaticMarkup(
      <ToolCard item={tool({ output: "- [x] Oku\n- [x] Çiz\n- [-] Kaydet\n- [ ] Sına" })} />,
    );
    expect(html).toContain("Kaydet");
    expect(html).toContain("2/4");
  });

  it("hepsi bittiğinde sayacı tamamlanmış olarak yazar", () => {
    const html = renderToStaticMarkup(<ToolCard item={tool({ output: "- [x] Oku\n- [x] Çiz" })} />);
    expect(html).toContain("2/2");
    expect(html).toContain("Çiz");
  });

  it("liste yoksa kart bilinen başlıkla kalır, sayaç yazılmaz", () => {
    const html = renderToStaticMarkup(<ToolCard item={tool({ output: "" })} />);
    expect(html).toContain("Adımlar yazıldı");
    expect(html).not.toMatch(/\d+\/\d+/);
  });
});

/**
 * Satır anatomisi (ZCode'un araç satırı): içerik genişliğinde ve sola yaslı, ok metnin hemen
 * ardında ve yalnız hover'da görünür, süren iş dönen yayla değil parıltılı fiille söylenir.
 * Satır sütunu baştan sona doldurduğunda ok 720px öteye savruluyor, kısa çağrılar kocaman bir
 * boşlukla okunuyordu.
 */
describe("araç satırı anatomisi", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  it("satır içerik genişliğinde ve sola yaslıdır", () => {
    const html = renderToStaticMarkup(
      <ToolCard item={tool({ kind: "read", toolName: "read", title: "Okundu", target: "a.ts" })} />,
    );
    expect(html).toContain("inline-flex max-w-full items-center gap-2 self-start");
    // Sütunu dolduran satır sınıfı ("flex w-full") kalmadı; `max-w-full` bunun alt dizesi değil.
    expect(html).not.toContain("flex w-full items-center");
  });

  it("ok sağa bakar, durağan hâlde gizli, hover'da belirir", () => {
    const html = renderToStaticMarkup(<ToolCard item={tool({})} />);
    expect(html).toContain('d="m9 18 6-6-6-6"');
    expect(html).toContain("opacity-0 group-hover/row:opacity-100");
  });

  it("süren satır dönen yay çizmez, fiili parıldar", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        item={tool({ status: "running", kind: "terminal", toolName: "bash", command: "npm test" })}
      />,
    );
    expect(html).toContain("Çalıştırılıyor");
    expect(html).toContain("cz-shimmer");
    expect(html).not.toContain("cz-spin");
    // Durum metni ("çalışıyor…") kaldırıldı: fiil zaten sürekli biçimde ve parıltılı.
    expect(html).not.toContain("çalışıyor…");
  });

  it("komut satırı çerçeveli terminal ikonu taşır, çıplak ok taşımaz", () => {
    // Çıplak `>_` (lucide `terminal`) satır sonundaki katlanma okuyla aynı glifi tekrarlıyor,
    // komut satırı bir ok gibi okunuyordu; ikon artık kapalı çerçeveli (`square-terminal`).
    const html = renderToStaticMarkup(
      <ToolCard
        item={tool({
          kind: "terminal",
          toolName: "bash",
          title: "Çalıştırıldı",
          command: "npm test",
        })}
      />,
    );
    expect(html).toContain('d="m7 11 2-2-2-2"');
    // Kapalı dış hat: ikonu "terminal penceresi" yapan asıl şey, çerçeve dikdörtgeni.
    expect(html).toMatch(/<rect[^>]*width="18"[^>]*height="18"[^>]*>/);
    expect(html).not.toContain('d="m4 17 6-6-6-6"');
  });

  it("satır iç içe düğme kurmaz: satır div, dosya adı düğmedir", () => {
    // Satır `<button>` olsaydı içindeki "dosyayı aç" düğmesi geçersiz HTML olurdu (React
    // hydration hatası). Satır `div role="button"`; tek gerçek düğme dosya adıdır.
    const html = renderToStaticMarkup(
      <ToolCard
        item={tool({ kind: "read", toolName: "read", title: "Okundu", target: "/p/a.ts" })}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('role="button"');
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });

  it("diff rozeti iki renkli ve rakamları hizalı basılır", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        item={tool({
          kind: "edit",
          toolName: "edit",
          title: "Düzenlendi",
          target: "a.ts",
          output: "+1 a\n+2 b\n-3 c\n",
        })}
      />,
    );
    expect(html).toContain("font-mono text-[13px] tabular-nums");
    // Rakamlar çevrilebilsin diye ayrı yuvalarda çizilir (ZCode'un sayaç rozeti); okunan metin "+2 −1".
    expect(html).toContain('class="text-green"');
    expect(html).toContain('class="text-red"');
    expect(visible(html)).toContain("+2 −1");
  });

  it("yazma sürerken canlı sayacı gösterir (araç çıktısı henüz yokken)", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        item={tool({
          kind: "create",
          toolName: "write",
          title: "Oluşturuluyor",
          target: "a.ts",
          status: "running",
          added: 128,
          removed: 0,
          preview: true,
        })}
      />,
    );
    // Diff çıktısı yok: sayı yalnız canlı ölçüden gelir ve rakam yuvası olarak basılır.
    expect(visible(html)).toContain("+128");
    expect(html).toContain("cz-turn");
  });
});

/**
 * Katlanmış grup satırı: ZCode'un komut grubu gibi **yalnızca sayıyı** yazar. İki komut virgülle
 * birleştirilince satır komut çöplüğüne dönüyordu; okumada ise dosya adları bilgi verir, kalır.
 * Süren grupta ise sayaç değil **komut** yazılır (ZCode sayacı çalışma bitince yazar).
 */
describe("grup satırı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  const entry = (item: ToolCallItem) => ({ item, attempts: [], anchorId: item.id });

  it("süren terminal grubu ZCode biçimini yazar: etiket · fiil · komut (sayaç yok)", () => {
    const html = renderToStaticMarkup(
      <ToolGroup
        entries={[
          entry(
            tool({
              id: "a",
              kind: "terminal",
              toolName: "bash",
              title: "Çalıştırıldı",
              command: "pnpm lint",
            }),
          ),
          entry(
            tool({
              id: "b",
              kind: "terminal",
              toolName: "bash",
              title: "Çalıştırıldı",
              command: "cd /p && pnpm test 2>&1 | tail -40",
              status: "running",
            }),
          ),
        ]}
        cwd="/p"
        lang="tr"
        live
      />,
    );
    expect(html).toContain("Terminal");
    expect(html).toContain("Çalıştırılıyor");
    // Komut kırpılabilir tek parça olarak yazılır (fiili yutmaz) ve `cd /p &&` öneki düşer.
    expect(html).toContain("pnpm test 2&gt;&amp;1 | tail -40");
    // Çalışırken sayaç yok: "1 çalıştırıldı" ve "0 hata" yazılmaz.
    expect(html).not.toContain("çalıştırıldı");
    expect(html).not.toContain("0 hata");
    // Etiket süren grupta parlar (ZCode süren grubun tür etiketini parıldatır).
    expect(html).toContain("cz-shimmer");
  });

  it("süren keşif grubu tür etiketiyle yazılır", () => {
    const html = renderToStaticMarkup(
      <ToolGroup
        entries={[
          entry(
            tool({ id: "a", kind: "read", toolName: "read", title: "Okundu", target: "/p/a.ts" }),
          ),
          entry(
            tool({
              id: "b",
              kind: "read",
              toolName: "read",
              title: "Okundu",
              target: "/p/b.ts",
              status: "running",
            }),
          ),
        ]}
        lang="tr"
        live
      />,
    );
    expect(html).toContain("Keşif");
    expect(html).toContain("Okunuyor");
    expect(html).toContain("b.ts");
  });

  it("terminal grubunda komutlar listelenmez, sayaç yazılır", () => {
    const html = renderToStaticMarkup(
      <ToolGroup
        entries={[
          entry(
            tool({
              id: "a",
              kind: "terminal",
              toolName: "bash",
              title: "Çalıştırıldı",
              command: "npm test",
            }),
          ),
          entry(
            tool({
              id: "b",
              kind: "terminal",
              toolName: "bash",
              title: "Çalıştırıldı",
              command: "npm run lint",
            }),
          ),
        ]}
        lang="tr"
      />,
    );
    expect(html).toContain("2 çalıştırıldı");
    expect(html).not.toContain("npm test");
    expect(html).not.toContain("npm run lint");
  });

  it("keşif grubunda dosya adları listelenir", () => {
    const html = renderToStaticMarkup(
      <ToolGroup
        entries={[
          entry(
            tool({ id: "c", kind: "read", toolName: "read", title: "Okundu", target: "/p/a.ts" }),
          ),
          entry(
            tool({ id: "d", kind: "read", toolName: "read", title: "Okundu", target: "/p/b.ts" }),
          ),
        ]}
        lang="tr"
      />,
    );
    expect(html).toContain("2 okundu");
    expect(html).toContain("a.ts, b.ts");
  });
});

/**
 * Arama kartı: sonucun hangi yolla geldiği satırda yazar. Yerleşik arama desteklemeyen modelde
 * sessizce DuckDuckGo'ya düşülüyordu ve iki yolun çıktısı ekranda aynı görünüyordu; kullanıcı
 * hangi aramanın çalıştığını ancak kayıtlardan çıkarabiliyordu.
 */
describe("arama kartı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  const search = (over: Partial<ToolCallItem> = {}) =>
    renderToStaticMarkup(
      <ToolCard
        item={tool({
          kind: "search",
          toolName: "web_search",
          title: "Web'de arandı",
          target: "ZCode coding agent",
          output: "1. Sonuç\n   https://a.example\n   özet",
          ...over,
        })}
      />,
    );

  it("yerleşik aramada yol etiketini ölçünün önüne yazar", () => {
    const visibleHtml = visible(search({ searchBackend: "native" }));
    expect(visibleHtml).toContain("Yerleşik arama");
    expect(visibleHtml).toContain("3 eşleşme");
    expect(visibleHtml).toContain("Yerleşik arama · 3 eşleşme");
  });

  it("DuckDuckGo uç noktalarını tek etikette toplar", () => {
    expect(visible(search({ searchBackend: "html" }))).toContain("DuckDuckGo · 3 eşleşme");
    expect(visible(search({ searchBackend: "lite" }))).toContain("DuckDuckGo · 3 eşleşme");
  });

  it("Ayarlar'da seçilen sağlayıcının adını yazar", () => {
    expect(visible(search({ searchBackend: "searxng" }))).toContain("SearXNG · 3 eşleşme");
    expect(visible(search({ searchBackend: "brave" }))).toContain("Brave · 3 eşleşme");
  });

  it("etiket yoksa yalnız ölçü yazılır (eski kayıtlar)", () => {
    const visibleHtml = visible(search());
    expect(visibleHtml).toContain("3 eşleşme");
    expect(visibleHtml).not.toContain("DuckDuckGo");
    expect(visibleHtml).not.toContain("Yerleşik arama");
  });
});

/**
 * Komut kartı (ZCode'un komut görünümü): `$ komut` satırı ve mono çıktı bloğu. Eskiden komut
 * çıktısı diff gibi satır numaralarıyla çiziliyordu; terminal çıktısı diff değildir.
 */
describe("komut kartı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  const body = (over: Partial<Parameters<typeof CommandBody>[0]> = {}) =>
    renderToStaticMarkup(
      <CommandBody
        command="npm test -- web-search"
        output="PASS src/web-search.test.ts\nTests 12 passed"
        running={false}
        waiting="çıktı bekleniyor…"
        empty="çıktı yok"
        {...over}
      />,
    );

  it("komutu $ imiyle ve çıktıyı mono blokta yazar", () => {
    const html = body();
    expect(html).toContain("$");
    expect(html).toContain("npm test -- web-search");
    expect(html).toContain("PASS src/web-search.test.ts");
    // Komut çıktısı kod yüzeyidir: arabirim yazı tipi değil, kod yazı tipi kullanılır.
    expect(html).toContain("font-code");
    // Satır numarası oluğu yok: çıktı diff değil.
    expect(html).not.toContain("tabular-nums");
    expect(html).not.toContain("border-r");
  });

  it("süren komutta boş çıktı yerine bekleme satırı, bitende 'çıktı yok' yazar", () => {
    expect(body({ output: "", running: true })).toContain("çıktı bekleniyor…");
    expect(body({ output: "", running: false })).toContain("çıktı yok");
  });

  it("çıktıyı beş satırda sınırlar (kart sohbeti uzatmasın)", () => {
    expect(body()).toContain("max-h-[5lh]");
  });
});

/**
 * Diff kartı: cetvel tek sütundur. Pi satır başına tek numara yazar; iki sütunlu cetvel aynı sayıyı
 * yan yana iki kez basıyordu. Atlanan bağlam girintili `...` metni değil, ayraç satırıdır.
 */
describe("diff satırları", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  const diff = [
    " 103           </button>",
    '-104           <div className="a">',
    '+104           <div className="b">',
    "     ...",
    " 121             <span />",
  ].join("\n");

  it("her satırın numarasını bir kez yazar", () => {
    const html = visible(renderToStaticMarkup(<DiffLines output={diff} kind="edit" empty="" />));
    expect(html.match(/104/g)).toHaveLength(2);
    expect(html.match(/103/g)).toHaveLength(1);
  });

  it("atlanan bağlamı sayısıyla ayraç satırına çevirir", () => {
    const html = visible(renderToStaticMarkup(<DiffLines output={diff} kind="edit" empty="" />));
    expect(html).toContain("16 satır değişmedi");
    expect(html).not.toContain("...");
  });

  it("ortak girintiyi atar: kod cetvelin hemen yanından başlar", () => {
    const html = visible(renderToStaticMarkup(<DiffLines output={diff} kind="edit" empty="" />));
    expect(html).toContain("103&lt;/button&gt;");
    expect(html).toContain("121  &lt;span /&gt;");
  });
});
