import type { AssistantItem, ToolCallItem, TranscriptItem } from "@codezal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { emptyRuntime, type SessionRuntime } from "../stores/reduce";
import { rowKeyOf, Transcript, thoughtSummary } from "./Transcript";

/**
 * Düşünme akışının görünürlüğü: model düşünürken metin ekranda akmalı ve yanıt başlayınca
 * katlanmalı. Uzun düşünme sırasında ekranda hiçbir şey değişmediği için akış takılmış
 * sanılıyordu; bu test o davranışın geri gelmemesini tutar.
 *
 * Statik çizim kullanılır (gerçek DOM yok): efektler çalışmadığı için bileşenin başlangıç
 * durumu ölçülür — akarken açık, bitmişken katlı.
 */
const assistant = (over: Partial<AssistantItem>): AssistantItem =>
  ({ type: "assistant", id: "m1", text: "", at: 1, ...over }) as AssistantItem;

function draw(item: AssistantItem, over: Partial<SessionRuntime> = {}): string {
  const rt = emptyRuntime();
  rt.transcript = [item];
  rt.status = "working";
  rt.activeRunId = "r1";
  rt.runStartedAt = Date.now() - 12_000;
  Object.assign(rt, over);
  return renderToStaticMarkup(
    <Transcript
      rt={rt}
      onDecide={() => undefined}
      onPlanDecide={() => undefined}
      onQuestionAnswer={() => undefined}
    />,
  );
}

describe("düşünme bloğu", () => {
  beforeAll(async () => {
    // Görünen metni iddia eden testler dili kendisi sabitler (bkz. lib/i18n notu).
    await i18n.changeLanguage("tr");
  });

  it("düşünmesi de metni de olan ara anlatımda düşünme satırı kaybolmaz", () => {
    // Ajan çoğu turda aynı mesajda hem düşünüp hem ara anlatım yazıyor. Satır yalnız "metin yok"
    // hâlinde çizildiği için bu düşünmeler görünmez oluyordu: aynı sohbette bazı düşünmeler
    // görünüp bazıları kayboluyordu.
    const html = draw(assistant({ thinking: "araya düşünme", text: "Ara anlatım metni" }));
    expect(html).toContain("Düşündü");
    expect(html).toContain("Ara anlatım metni");
  });

  it("düşünme satırı araç dizisini böler: her dizi kendi grubunda kalır", () => {
    // Model araç çağrılarını kısa düşünme turlarıyla bölüyor. Düşünme satırı listeden
    // çıkarıldığında iki ayrı dizi tek gruba yutuluyordu ("5 çalıştırıldı"); ZCode düşünme
    // satırını dizide tutar, gruplar oradan bölünür.
    const read = (id: string): ToolCallItem =>
      ({
        type: "tool",
        id,
        toolName: "read",
        kind: "read",
        status: "done",
        title: "Okundu",
        target: `/p/${id}.ts`,
        startedAt: 1,
        endedAt: 2,
      }) as ToolCallItem;
    const rt = emptyRuntime();
    rt.status = "working";
    rt.activeRunId = "r1";
    rt.runStartedAt = Date.now() - 5_000;
    rt.transcript = [
      { type: "user", id: "u1", text: "iş", at: 1 },
      read("t1"),
      read("t2"),
      assistant({ id: "a1", text: "", thinking: "araya düşünme" }),
      read("t3"),
      read("t4"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
    // İki dizinin ikisi de kendi grubunda: kapanan dizi sayacını yazar, turun kuyruğu ZCode'un
    // canlı satırıdır (tür etiketi + kendi adları). Birleşselerdi tek satır "4 okundu" derdi.
    expect(html).toContain("Düşündü");
    expect(html).toContain("2 okundu");
    expect(html).not.toContain("4 okundu");
    expect(html).toContain("t1.ts, t2.ts");
    expect(html).toContain("t3.ts, t4.ts");
  });

  it("düşünme akarken tek satır özet akar, tam metin açılmaz", () => {
    const html = draw(
      assistant({ streaming: true, thinking: "Önce depoyu tarayayım\nsonra testleri koşturayım" }),
    );
    // Satır ZCode'daki gibi okunur: "Düşünüyor · <akışın son satırı>". Tam metin açılmaz:
    // düşünmeli modeller araçlar arasında kısa döngüler kuruyor, açılan blok yanıp sönüyordu.
    expect(html).toContain("Düşünüyor");
    expect(html).toContain("sonra testleri koşturayım");
    expect(html).not.toContain("Önce depoyu tarayayım");
  });

  it("düşünme satırı beyin ikonuyla ve okla çizilir, tam metin katlı kalır", () => {
    const live = draw(assistant({ streaming: true, thinking: "düşünüyorum" }));
    // Beyin ikonu (lucide `brain` geometrisi) satırın başında durur; ok sağa bakar.
    expect(live).toContain("M12 18V5");
    expect(live).toContain('d="m9 18 6-6-6-6"');
    // Gövde kapalı: satır yalnız etiketi ve akan son satırı yazar, tam metni açmaz.
    expect(live).toContain("düşünüyorum");
    expect(live).not.toContain("max-h-60 overflow-auto");
  });

  it("yanıt metni başlayınca katlanır: düşünme metni DOM'da kalmaz", () => {
    const html = draw(
      assistant({ streaming: true, thinking: "Önce depoyu tarayayım", text: "Merhaba" }),
    );
    expect(html).not.toContain("Önce depoyu tarayayım");
    // Ölçülemeyen (geçmişten gelen) düşünme yalnız "Düşündü" der: tur başlığındaki kesin sürenin
    // yanında muğlak ikinci bir süre ("birkaç saniye") yazılmaz.
    expect(html).toContain("Düşündü");
    expect(html).not.toContain("birkaç saniye");
    expect(html).toContain("Merhaba");
  });

  it("durum satırı yalnız dönen simgeyi çizer, yazı yazmaz (ZCode'un tur sonu göstergesi)", () => {
    // ZCode turun altında yalnız dönen simgeyi çizer; süren işi araç satırı söyler
    // ("Çalıştırılıyor cd … && pnpm test"). Satırda bir de "Çalışıyor…" yazmak — eskiden
    // "Esc durdurur" ipucu da oradaydı — aynı şeyi iki kez söylüyordu.
    const html = draw(assistant({ streaming: true, thinking: "düşünüyorum" }));
    expect(html).toContain("cz-spin");
    // Etiket yalnız ekran okuyucuya gider; görünür metin olarak yazılmaz.
    expect(html).toContain('aria-label="Çalışıyor…"');
    expect(html).not.toContain(">Çalışıyor");
    expect(html).not.toContain("Esc");
  });

  it("onay/soru kartı beklerken durum satırı gizlenir (kart ilerlemenin kendisi)", () => {
    const html = draw(assistant({ streaming: true, thinking: "düşünüyorum" }), {
      permissions: [
        {
          requestId: "p1",
          sessionId: "s1",
          toolName: "bash",
          kind: "terminal",
          command: "rm -rf build",
          dangerous: true,
        },
      ],
    });
    expect(html).not.toContain("Çalışıyor");
  });

  it("katlanmış düşünme özeti son dolu satırın kuyruğunu verir", () => {
    expect(thoughtSummary("birinci satır\n\n  ikinci satır  ")).toBe("ikinci satır");
    const long = "a".repeat(200);
    const summary = thoughtSummary(`baş\n${long}`);
    expect(summary.startsWith("…")).toBe(true);
    expect(summary.length).toBe(120);
    expect(summary.endsWith(long.slice(-10))).toBe(true);
  });
});

/**
 * Çalışma dizisi başlığı ("4 sn çalıştı"): ZCode'da olduğu gibi ok etiketin hemen yanında durur
 * ve durağan hâlde de görünür (araç satırlarının oku yalnız hover'da çıkar). Ok sağa bakar,
 * açılınca 90° döner; eskiden sağa savrulmuş aşağı oku 180° dönüyordu.
 */
/**
 * Başlık ZCode'un satırıdır: tur sürerken "12 sn çalışıyor" der, dizi açık kalır ve **ok
 * çizilmez**; tur bitince "6 dk 36 sn çalıştı" olur, ok çıkar ve dizi katlanır. Başlıkta işlem
 * sayısı yazmaz: kaç çağrı olduğu açılan dizideki grup satırlarında okunur.
 */
describe("çalışma dizisi başlığı", () => {
  const readTool = (id: string, status: "done" | "running" = "done") =>
    ({
      type: "tool",
      id,
      toolName: "read",
      kind: "read",
      status,
      title: "Okundu",
      target: `/p/${id}.ts`,
      startedAt: Date.now() - 12_000,
      ...(status === "done" ? { endedAt: Date.now() - 10_000 } : {}),
    }) as ToolCallItem;

  function drawRun(items: TranscriptItem[], status: "working" | "idle"): string {
    const rt = emptyRuntime();
    rt.status = status;
    rt.activeRunId = status === "working" ? "r1" : null;
    rt.runStartedAt = Date.now() - 12_000;
    rt.transcript = items;
    return renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
  }

  it("süren turda dizi yokken de başlık en başta çizilir", () => {
    // Kullanıcı yeni turu gönderdiğinde model düşünüyor ya da metin akıyor olabilir; henüz çalışma
    // dizisi (araçlar) yokken başlık çizilmiyordu, dizi oluşunca sonradan belirip içeriği aşağı
    // kaydırıyordu. ZCode satırı tur boyunca tutar, o yüzden başlık ilk andan görünür.
    const html = drawRun(
      [
        { type: "user", id: "u1", text: "bak", at: 1 },
        assistant({ id: "m1", text: "bakıyorum", streaming: true }),
      ],
      "working",
    );
    expect(html).toContain("12 sn çalışıyor");
  });

  it("dizi oluştuğunda başlık tek kalır (dizi başlığına devredilir)", () => {
    const html = drawRun(
      [
        { type: "user", id: "u1", text: "iş", at: 1 },
        assistant({ id: "m1", text: "bakıyorum" }),
        readTool("t1"),
      ],
      "working",
    );
    expect(html.match(/sn çalışıyor/g)?.length).toBe(1);
  });

  it("araç çalışmayan turda da başlık çizilir (ZCode her turda çizer)", () => {
    // "merhaba" gibi araçsız bir turda bile ZCode "Worked for 5s" satırını gösterir; süre turun
    // kendisinden (kullanıcı mesajı → yanıt) gelir.
    const html = drawRun(
      [
        { type: "user", id: "u1", text: "merhaba", at: 1 },
        assistant({ id: "m1", text: "Merhaba!", durationMs: 5_000 }),
      ],
      "idle",
    );
    expect(html).toContain("5 sn çalıştı");
    expect(html).toContain("Merhaba!");
  });

  it("başlık ile yanıt altındaki süre aynı sayıyı yazar", () => {
    // Eskiden başlık yalnız araçların aralığını ("1 sn"), yanıt altındaki satır turun tamamını
    // ("6,1 sn") yazıyordu: aynı turda iki farklı süre görünüyordu.
    const html = drawRun(
      [
        { type: "user", id: "u1", text: "iş", at: 1 },
        readTool("t1"),
        assistant({ id: "m1", text: "bitti", durationMs: 6_100 }),
      ],
      "idle",
    );
    expect(html).toContain("6 sn çalıştı");
    expect(html).toContain("· 6 sn");
    expect(html).not.toContain("6,1");
  });

  it("eylem satırı (model · süre) fareyle belirir, son görünen öğe metin kalır", () => {
    // ZCode'un eylem satırı da durağan hâlde görünmez. Hep görünürken yanıtın altındaki boşluk
    // composer'a doğru daralıyor, ZCode'daki havadan farklı duruyordu.
    const html = drawRun(
      [
        { type: "user", id: "u1", text: "iş", at: 1 },
        assistant({ id: "m1", text: "bitti", durationMs: 4_000, model: "m", provider: "p" }),
      ],
      "idle",
    );
    expect(html).toContain("opacity-0 transition-opacity group-hover/turn:opacity-100");
    expect(html).toContain("4 sn");
  });

  it("süren turda başlık açık ve oksuzdur", () => {
    const html = drawRun(
      [{ type: "user", id: "u1", text: "iş", at: 1 }, readTool("t1"), readTool("t2", "running")],
      "working",
    );
    expect(html).toContain("çalışıyor");
    expect(html).toMatch(/\d+ sn/);
    // Açık tutulan grupta ok hiç çizilmez (ZCode kuralı).
    expect(html).not.toContain("transition-all duration-200 opacity-70");
  });

  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  it("katlanan turda başlık, süre ve her zaman görünen ok çizilir", () => {
    const rt = emptyRuntime();
    rt.status = "idle";
    rt.transcript = [
      { type: "user", id: "u1", text: "iş", at: 1 },
      {
        type: "tool",
        id: "t1",
        toolName: "read",
        kind: "read",
        status: "done",
        title: "Okundu",
        target: "src/app.ts",
        startedAt: 2,
        endedAt: 5_000,
      },
      assistant({ id: "m1", text: "bitti" }),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
    expect(html).toContain("çalıştı");
    // Ok sağa bakar ve durağan hâlde görünür (araç satırlarının oku hover bekler).
    expect(html).toContain('d="m9 18 6-6-6-6"');
    expect(html).toContain('transition-all duration-200 opacity-70"');
  });

  it("arka plan komutu başlatan tur bitince katlanmaz, komut satırı görünür kalır", () => {
    const rt = emptyRuntime();
    rt.status = "idle";
    rt.transcript = [
      { type: "user", id: "u1", text: "sunucuyu başlat", at: 1 },
      {
        type: "tool",
        id: "t1",
        toolName: "bash_background",
        kind: "terminal",
        status: "done",
        title: "Arka planda çalıştırıldı",
        command: "pnpm dev",
        startedAt: 2,
        endedAt: 3_000,
      },
      assistant({ id: "m1", text: "sunucu arka planda" }),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
    expect(html).toContain("çalıştı");
    expect(html).toContain("pnpm dev");
  });
});

describe("uzun oturumda tur penceresi", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  /** `turns` kadar kullanıcı+asistan turu olan bir runtime üretir. */
  function longRuntime(turns: number): SessionRuntime {
    const rt = emptyRuntime();
    rt.status = "idle";
    const items: TranscriptItem[] = [];
    for (let i = 1; i <= turns; i++) {
      items.push({ type: "user", id: `u${i}`, text: `istek ${i}`, at: i });
      items.push({
        type: "assistant",
        id: `a${i}`,
        text: `yanıt ${i}`,
        at: i,
        streaming: false,
      } as AssistantItem);
    }
    rt.transcript = items;
    return rt;
  }

  function drawRuntime(rt: SessionRuntime): string {
    return renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
  }

  /** Kolonun kendi sınıfı: satır aralığı `gap` ile mi veriliyor? */
  const columnClass = (html: string): string =>
    /data-testid="chat-column" class="([^"]*)"/.exec(html)?.[1] ?? "";
  /** Çizilen satırların (kaydırma çapası taşıyan kutuların) sınıfları. */
  const rowClasses = (html: string): string[] =>
    [...html.matchAll(/data-anchor-key="[^"]*"[^>]*class="([^"]*)"/g)].map((m) => m[1] ?? "");

  /**
   * Sanallaştırmanın asıl iddiası: uzun oturumda bütün turlar DOM'a basılmaz. Eşiğin altındaki
   * sohbetler etkilenmez (davranış birebir aynı kalır), üstündekiler pencerelenir.
   */
  it("eşiğin üstünde yalnız pencereyi çizer", () => {
    const html = drawRuntime(longRuntime(300));
    // 300 turun tamamı çizilseydi her yanıt metni DOM'da olurdu.
    expect(html).toContain("yanıt 300");
    expect(html).not.toContain("yanıt 10");
    // Boşluklar toplam yüksekliği korur (kaydırma çapası geometriye güvenir).
    expect(html).toMatch(/<div aria-hidden="true" style="height:\d+px"><\/div>/);
  });

  it("eşiğin altındaki sohbette hiçbir şey değişmez", () => {
    const html = drawRuntime(longRuntime(20));
    expect(html).toContain("yanıt 1");
    expect(html).toContain("yanıt 20");
    // Kısa sohbette boşluk div'i oluşmaz: davranış sanallaştırmadan öncekiyle aynı.
    expect(html).not.toMatch(/<div aria-hidden="true" style="height:/);
    // Aralık hâlâ kolonun `gap`i: kısa sohbette satırlar kendi dolgusunu taşımaz.
    expect(columnClass(html)).toContain("gap-5");
    expect(rowClasses(html).length).toBeGreaterThan(0);
    expect(rowClasses(html).some((c) => c.split(" ").includes("pb-5"))).toBe(false);
  });

  /**
   * Satır aralığı sanallaştırmada satırın kendisine verilir: atlanan her satır `gap` ile birlikte
   * 20px'lik boşluğunu da götürür, toplam yükseklik pencere her kaydığında oynardı (kaydırma
   * çubuğu ve "dipte miyim" ölçüsü içerikle tutarsız kalırdı).
   */
  it("pencerelenmiş sohbette aralık satıra taşınır", () => {
    const html = drawRuntime(longRuntime(300));
    expect(columnClass(html)).not.toContain("gap-5");
    const rows = rowClasses(html);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.split(" ").includes("pb-5"))).toBe(true);
  });

  /**
   * Pencere hesabı, ölçüm önbelleği ve DOM'daki `data-anchor-key` aynı anahtarı kullanmak
   * zorunda. Kullanıcı ve işaret satırları bir dönem `a-` anahtarıyla hesaplanıp `u-`/`m-`
   * anahtarıyla çiziliyordu: ölçülen yükseklikleri önbellekte bulunamıyor, bu satırlar hep
   * tahminle temsil ediliyordu.
   */
  it("satır anahtarları çizimle aynı", () => {
    const user = { type: "user", id: "u1", text: "merhaba", at: 1 } as TranscriptItem;
    const marker = { type: "marker", id: "mk1", kind: "compact", at: 2 } as TranscriptItem;
    const reply = { type: "assistant", id: "a1", text: "yanıt", at: 3 } as TranscriptItem;
    const run = [
      {
        type: "tool",
        id: "t1",
        toolCallId: "c1",
        toolName: "bash",
        kind: "terminal",
        status: "done",
        title: "kabuk",
        startedAt: 4,
        at: 4,
      } as TranscriptItem,
    ];
    expect(rowKeyOf(user, 0)).toBe("u-u1");
    expect(rowKeyOf(marker, 1)).toBe("m-mk1");
    expect(rowKeyOf(reply, 2)).toBe("a-a1");
    expect(rowKeyOf(run, 3)).toBe("g-t1");
    // Aynı anahtarlar DOM'da da durur.
    const html = drawRuntime(longRuntime(300));
    expect(html).toContain('data-anchor-key="u-u300"');
    expect(html).toContain('data-anchor-key="a-a300"');
  });
});

/**
 * Komut sonucu işaretleri (ZCode'un timelineMarker satırı): `/model`, `/mod`, `/düşünme` ve
 * `/compact` modele gitmediği için sohbette kullanıcı balonu yoktur; geriye kalan tek iz bu
 * ayraç satırıdır. Satır kayıttan (yeniden açılan oturumda meta'dan) gelir, gösterilen metin
 * arayüz dilinde kurulur.
 */
describe("komut işareti satırı", () => {
  function drawItems(items: TranscriptItem[]): string {
    const rt = emptyRuntime();
    rt.transcript = items;
    return renderToStaticMarkup(
      <Transcript
        rt={rt}
        onDecide={() => undefined}
        onPlanDecide={() => undefined}
        onQuestionAnswer={() => undefined}
      />,
    );
  }

  const marker = (over: Partial<TranscriptItem>): TranscriptItem =>
    ({ type: "marker", id: "mk-1", kind: "compact", at: 5, ...over }) as TranscriptItem;

  it("özetleme sonucunu üç hâlde de söyler", () => {
    expect(drawItems([marker({ outcome: "done" })])).toContain(i18n.t("marker.compact"));
    expect(drawItems([marker({ outcome: "noop" })])).toContain(i18n.t("marker.compactNoop"));
    expect(drawItems([marker({ outcome: "failed" })])).toContain(i18n.t("marker.compactFailed"));
  });

  it("izin modunu görünen adlarla yazar", () => {
    const html = drawItems([
      marker({ kind: "permission", from: "ask", to: "plan", outcome: undefined }),
    ]);
    expect(html).toContain(i18n.t("permissionMode.ask"));
    expect(html).toContain(i18n.t("permissionMode.plan"));
  });
});
