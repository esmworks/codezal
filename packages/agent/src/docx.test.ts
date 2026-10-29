import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocx, buildZip, num, p, r, style } from "./docx.fixture.js";
import { convertDocx, docxToMarkdown, isDocx, readDocxContent } from "./docx.js";

const md = (body: string) => docxToMarkdown(buildDocx(body));

describe("isDocx", () => {
  it("Word paket uzantılarını tanır, eski .doc'u tanımaz", () => {
    expect(isDocx("a/Rapor.DOCX")).toBe(true);
    expect(isDocx("sablon.dotx")).toBe(true);
    expect(isDocx("makro.docm")).toBe(true);
    expect(isDocx("eski.doc")).toBe(false);
    expect(isDocx("docx.txt")).toBe(false);
  });
});

describe("docxToMarkdown", () => {
  it("başlıkları stil adından bulur (Türkçe kimlik, Title, basedOn zinciri, outlineLvl)", () => {
    const out = md(
      [
        p(r("Yıllık Rapor"), style("KonuBal")),
        p(r("Giriş"), style("Balk1")),
        p(r("Alt bölüm"), style("OzelBaslik")),
        p(r("Doğrudan"), '<w:outlineLvl w:val="2"/>'),
        p(r("Şirketimiz çağ dışı değil.")),
      ].join(""),
    );
    expect(out).toBe(
      "# Yıllık Rapor\n\n# Giriş\n\n## Alt bölüm\n\n### Doğrudan\n\nŞirketimiz çağ dışı değil.",
    );
  });

  it("parçalanmış run'ları birleştirir; vurgu işaretleri boşluğun dışında kalır", () => {
    const out = md(
      p(
        r("Bu ") +
          r("çok ", "<w:b/>") +
          r("önemli", "<w:b/>") +
          r(" bir ") +
          r("not", '<w:i/><w:b w:val="0"/>') +
          r("eski", "<w:strike/>"),
      ),
    );
    expect(out).toBe("Bu **çok önemli** bir *not*~~eski~~");
  });

  it("madde ve numaralı listeleri düzeyleriyle yazar, alt sayaç üst düzeyde sıfırlanır", () => {
    const out = md(
      [
        p(r("Giriş paragrafı")),
        p(r("Elma"), num(1)),
        p(r("Yeşil"), num(1, 1)),
        p(r("Armut"), style("Madde")),
        p(r("Bir"), num(2)),
        p(r("a şıkkı"), num(2, 1)),
        p(r("b şıkkı"), num(2, 1)),
        p(r("İki"), num(2)),
        p(r("yine a"), num(2, 1)),
        p(r("Numarasız"), '<w:numPr><w:numId w:val="0"/></w:numPr>'),
      ].join(""),
    );
    expect(out).toBe(
      [
        "Giriş paragrafı",
        "",
        "- Elma\n  - Yeşil\n- Armut\n1. Bir\n  1. a şıkkı\n  2. b şıkkı\n2. İki\n  1. yine a",
        "",
        "Numarasız",
      ].join("\n"),
    );
  });

  it("tabloyu Markdown tablosuna çevirir: birleşik hücre, çok paragraflı hücre, dikey çizgi", () => {
    const tc = (inner: string, span?: number) =>
      `<w:tc>${span ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ""}${inner}</w:tc>`;
    const out = md(
      `<w:tbl><w:tblPr/><w:tblGrid/>` +
        `<w:tr>${tc(p(r("Ürün")))}${tc(p(r("Adet")))}${tc(p(r("Fiyat")))}</w:tr>` +
        `<w:tr>${tc(p(r("Kondenser")) + p(r("12 kW")))}${tc(p(r("2")))}${tc(p(r("a|b")))}</w:tr>` +
        `<w:tr>${tc(p(r("Toplam")), 2)}${tc(p(r("100 ₺", "<w:b/>")))}</w:tr>` +
        `</w:tbl>`,
    );
    expect(out).toBe(
      [
        "| Ürün | Adet | Fiyat |",
        "| --- | --- | --- |",
        "| Kondenser<br>12 kW | 2 | a\\|b |",
        "| Toplam |  | **100 ₺** |",
      ].join("\n"),
    );
  });

  it("bağlantı, izlenen değişiklik, sekme/satır sonu ve görsel yer tutucusu", () => {
    const out = md(
      p(
        r("Site: ") +
          `<w:hyperlink r:id="rId9">${r("codezal")}</w:hyperlink>` +
          `<w:ins w:id="1" w:author="E">${r(" eklendi")}</w:ins>` +
          `<w:del w:id="2" w:author="E"><w:r><w:delText>silindi</w:delText></w:r></w:del>` +
          `<w:r><w:tab/><w:t>A</w:t><w:br/><w:t>B</w:t><w:br w:type="page"/></w:r>` +
          `<w:r><w:instrText> PAGE </w:instrText></w:r>` +
          `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Resim 1" descr="Şema"/></wp:inline></w:drawing></w:r>`,
      ),
    );
    expect(out).toBe(
      "Site: [codezal](https://codezal.app/?a=1&b=2){++ eklendi++}{--silindi--}\tA\nB[görsel: Şema]",
    );
  });

  it("üst/alt bilgi, dipnot/son not, yorum ve izli değişiklik sayıları", () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const rel = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const out = convertDocx(
      buildDocx(
        p(
          r("Teklif ") +
            '<w:commentRangeStart w:id="7"/>' +
            r("bedeli") +
            '<w:commentRangeEnd w:id="7"/>' +
            '<w:r><w:commentReference w:id="7"/></w:r>' +
            r(" KDV hariç") +
            '<w:r><w:footnoteReference w:id="2"/></w:r>' +
            '<w:ins w:id="9" w:author="A">' +
            r(" net") +
            "</w:ins>" +
            '<w:r><w:endnoteReference w:id="1"/></w:r>',
        ) + p(`<w:r><w:commentReference w:id="8"/></w:r>${r("Aralıksız yorum")}`),
        {
          rels:
            rel("rId20", "header", "header1.xml") +
            rel("rId21", "header", "header2.xml") +
            rel("rId22", "footer", "footer1.xml") +
            rel("rId23", "footnotes", "footnotes.xml") +
            rel("rId24", "endnotes", "endnotes.xml") +
            rel("rId25", "comments", "comments.xml"),
          parts: {
            "word/header1.xml": `<w:hdr ${W}>${p(r("Örnek Ltd."))}${p(r("Teklif No: 42"))}</w:hdr>`,
            // İlk sayfa üst bilgisi çoğu kez aynıdır; bir kez yazılır.
            "word/header2.xml": `<w:hdr ${W}>${p(r("Örnek Ltd."))}${p(r("Teklif No: 42"))}</w:hdr>`,
            "word/footer1.xml": `<w:ftr ${W}>${p(r("İstanbul"))}</w:ftr>`,
            "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${p("<w:r><w:separator/></w:r>")}</w:footnote><w:footnote w:id="2">${p(`<w:r><w:footnoteRef/></w:r>${r(" 2026 fiyatı.")}`)}</w:footnote></w:footnotes>`,
            "word/endnotes.xml": `<w:endnotes ${W}><w:endnote w:id="1">${p(r("Son not."))}</w:endnote></w:endnotes>`,
            "word/comments.xml": `<w:comments ${W}><w:comment w:id="7" w:author="Erhan">${p(r("Rakamı kontrol et"))}</w:comment><w:comment w:id="8" w:author="Ayşe">${p(r("Genel not"))}</w:comment></w:comments>`,
          },
        },
      ),
    );
    expect(out.markdown).toBe(
      [
        "**Üst bilgi:** Örnek Ltd. · Teklif No: 42",
        "",
        "Teklif {==bedeli==}{>>Erhan: Rakamı kontrol et<<} KDV hariç[^1]{++ net++}[^2]",
        "",
        "{>>Ayşe: Genel not<<}Aralıksız yorum",
        "",
        "**Alt bilgi:** İstanbul",
        "",
        "[^1]: 2026 fiyatı.\n[^2]: Son not.",
      ].join("\n"),
    );
    expect(out).toMatchObject({ insertions: 1, deletions: 0, comments: 2 });
  });

  it("metin kutusunu okur; AlternateContent'te içerik iki kez gelmez", () => {
    const box = (text: string) => `<w:txbxContent>${p(r(text))}</w:txbxContent>`;
    const out = md(
      p(r("Teklif")) +
        p(
          `<w:r><w:pict><v:shape><v:textbox>${box("No: 100171")}${box("Tarih: 2011")}</v:textbox></v:shape></w:pict></w:r>`,
        ) +
        p(
          `<w:r><mc:AlternateContent><mc:Choice><w:drawing><wps:txbx>${box("Kutu")}</wps:txbx></w:drawing></mc:Choice>` +
            `<mc:Fallback><w:pict><v:textbox>${box("Kutu")}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`,
        ),
    );
    expect(out).toBe("Teklif\n\nNo: 100171\nTarih: 2011\n\nKutu");
  });

  it("içerik denetimi (sdt) içindeki paragrafları okur, boş paragrafları atlar", () => {
    const out = md(
      `<w:sdt><w:sdtPr/><w:sdtContent>${p(r("Kapak"))}</w:sdtContent></w:sdt>${p("")}${p(r("   "))}${p(r("Son"))}`,
    );
    expect(out).toBe("Kapak\n\nSon");
  });

  it("sıkıştırılmamış (stored) paketi de açar", () => {
    expect(docxToMarkdown(buildDocx(p(r("düz")), { stored: true }))).toBe("düz");
  });

  it("ZIP olmayan dosyada ve word/document.xml eksikse anlaşılır hata verir", () => {
    expect(() =>
      docxToMarkdown(Buffer.from("\xd0\xcf\x11\xe0 eski doc biçimi ".repeat(4))),
    ).toThrow(/\.doc/);
    expect(() => docxToMarkdown(buildZip({ "a.txt": "x" }))).toThrow(/word\/document\.xml/);
    expect(() => docxToMarkdown(Buffer.from("PK"), "en")).toThrow(/not a \.docx/);
  });
});

describe("readDocxContent", () => {
  const write = async (body: string) => {
    const dir = await mkdtemp(join(tmpdir(), "codezal-docx-"));
    const path = join(dir, "Teklif.docx");
    await writeFile(path, buildDocx(body));
    return path;
  };
  const text = (c: Awaited<ReturnType<typeof readDocxContent>>) => c.map((x) => x.text).join("");
  const lines = Array.from({ length: 30 }, (_, i) => p(r(`Satır ${i + 1}`))).join("");

  it("başlık satırı ekler; offset/limit çevrilmiş satırlara uygulanır ve devamı söylenir", async () => {
    const path = await write(lines);
    const out = text(
      await readDocxContent(path, { offset: 3, limit: 4, maxLines: 2000, maxBytes: 50_000 }),
    );
    expect(out).toContain("Word: Teklif.docx · 59 satır");
    expect(out).toContain("Satır 2\n\nSatır 3");
    expect(out).not.toContain("Satır 1\n");
    expect(out).toContain("offset=7");
  });

  it("bayt sınırında keser; offset sonu aşarsa hata verir; boş belge açıklanır", async () => {
    const path = await write(lines);
    const cut = text(await readDocxContent(path, { maxLines: 2000, maxBytes: 40 }));
    expect(cut).toContain("Satır 1");
    expect(cut).not.toContain("Satır 30");
    expect(cut).toMatch(/offset=\d+/);
    await expect(
      readDocxContent(path, { offset: 500, maxLines: 10, maxBytes: 1000 }),
    ).rejects.toThrow(/500/);
    const empty = await write(p(""));
    expect(
      text(await readDocxContent(empty, { maxLines: 10, maxBytes: 1000, lang: "en" })),
    ).toContain("no text");
  });
});
