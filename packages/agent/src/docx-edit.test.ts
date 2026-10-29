import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocx, p, r, style } from "./docx.fixture.js";
import { docxToMarkdown } from "./docx.js";
import { type DocxEdit, DocxEditError, editDocx, resolveDocxEditTarget } from "./docx-edit.js";
import { docxEditTool } from "./docx-edit-tool.js";
import { ZipArchive } from "./ooxml.js";

const DATE = "2026-09-28T10:00:00Z";

const run = (bytes: Uint8Array, edits: DocxEdit[], track = false) =>
  editDocx(bytes, edits, { track, author: "Ayşe Yılmaz", date: DATE });

const xml = (bytes: Uint8Array, name = "word/document.xml") =>
  ZipArchive.open(bytes).readText(name) ?? "";

/**
 * Belgedeki tek yoruma Word'ün yazdığı biçimde bir yanıt ekler: yanıtın aralığı ve göndermesi
 * asılın yanında, zincir `commentsExtended`'da, kalıcı kimlikler `commentsIds`/`commentsExtensible`.
 */
function withReply(bytes: Uint8Array): Uint8Array {
  const zip = ZipArchive.open(bytes);
  const comments = zip.readText("word/comments.xml") ?? "";
  const id = /<w:comment w:id="(\d+)"/.exec(comments)?.[1] ?? "";
  const reply = "99";
  const body = zip.readText("word/document.xml") ?? "";
  const refRun = `<w:r><w:commentReference w:id="${id}"/></w:r>`;
  zip.set(
    "word/document.xml",
    body
      .replace(
        `<w:commentRangeStart w:id="${id}"/>`,
        `<w:commentRangeStart w:id="${id}"/><w:commentRangeStart w:id="${reply}"/>`,
      )
      .replace(
        `<w:commentRangeEnd w:id="${id}"/>`,
        `<w:commentRangeEnd w:id="${id}"/><w:commentRangeEnd w:id="${reply}"/>`,
      )
      .replace(refRun, refRun + refRun.replace(`"${id}"`, `"${reply}"`)),
  );
  zip.set(
    "word/comments.xml",
    comments
      .replace("<w:p>", '<w:p w14:paraId="0A000001">')
      .replace(
        "</w:comments>",
        `<w:comment w:id="${reply}" w:author="Ali" w:date="${DATE}"><w:p w14:paraId="0A000002"><w:r><w:t>Tamam</w:t></w:r></w:p></w:comment></w:comments>`,
      ),
  );
  const parts = [
    [
      "commentsExtended",
      "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
      '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0A000001" w15:done="0"/><w15:commentEx w15:paraId="0A000002" w15:paraIdParent="0A000001" w15:done="1"/></w15:commentsEx>',
    ],
    [
      "commentsIds",
      "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
      '<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w16cid:commentId w16cid:paraId="0A000001" w16cid:durableId="0B000001"/><w16cid:commentId w16cid:paraId="0A000002" w16cid:durableId="0B000002"/></w16cid:commentsIds>',
    ],
    [
      "commentsExtensible",
      "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
      `<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="0B000001" w16cex:dateUtc="${DATE}"/><w16cex:commentExtensible w16cex:durableId="0B000002" w16cex:dateUtc="${DATE}"/></w16cex:commentsExtensible>`,
    ],
  ];
  let rels = zip.readText("word/_rels/document.xml.rels") ?? "";
  for (const [name, type, content] of parts) {
    zip.set(
      `word/${name}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${content}`,
    );
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="rId${name}" Type="${type}" Target="${name}.xml"/></Relationships>`,
    );
  }
  zip.set("word/_rels/document.xml.rels", rels);
  return zip.toBuffer();
}

describe("editDocx: replace", () => {
  it("parçalanmış run'lardaki metni bulur, ilk parçanın biçimini korur", () => {
    const doc = buildDocx(p(r("Toplam tu", "<w:b/>") + r("tar: 1") + r("00 TL")));
    const { bytes, counts } = run(doc, [
      { action: "replace", find: "tutar: 100 TL", text: "tutar: 250 TL" },
    ]);
    expect(counts).toEqual({ replace: 1 });
    expect(docxToMarkdown(bytes)).toBe("**Toplam tutar: 250 TL**");
    // Değişmeyen kısım kendi run'ında kalır.
    expect(xml(bytes)).toContain('<w:t xml:space="preserve">Toplam </w:t>');
  });

  it("izli modda silinen w:del/w:delText, yeni metin w:ins olur", () => {
    const doc = buildDocx(p(r("Teslim süresi 30 gündür.")));
    const { bytes } = run(doc, [{ action: "replace", find: "30 gün", text: "45 gün" }], true);
    const body = xml(bytes);
    expect(body).toMatch(
      /<w:del w:id="\d+" w:author="Ayşe Yılmaz" w:date="2026-09-28T10:00:00Z"><w:r><w:delText xml:space="preserve">30 gün<\/w:delText><\/w:r><\/w:del>/,
    );
    expect(body).toMatch(/<w:ins w:id="\d+" w:author="Ayşe Yılmaz"[^>]*><w:r><w:t[^>]*>45 gün/);
    expect(docxToMarkdown(bytes)).toBe("Teslim süresi {--30 gün--}{++45 gün++}dür.");
  });

  it("izli değişiklik kimlikleri belgedeki en büyük kimlikten sonra başlar", () => {
    const doc = buildDocx(`<w:bookmarkStart w:id="41" w:name="x"/>${p(r("bir iki"))}`);
    const { bytes } = run(doc, [{ action: "replace", find: "iki", text: "üç" }], true);
    const ids = [...xml(bytes).matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(["42", "43"]);
  });

  it("başkasının izli eklemesinin içindeki metin izli silmede doğrudan kalkar", () => {
    const doc = buildDocx(
      p(`${r("Fiyat ")}<w:ins w:id="1" w:author="Ali" w:date="${DATE}">${r("KDV hariç")}</w:ins>`),
    );
    const { bytes } = run(doc, [{ action: "replace", find: "KDV hariç", text: "KDV dahil" }], true);
    const body = xml(bytes);
    expect(body).not.toContain("<w:del ");
    expect(body).not.toContain("KDV hariç");
    // Yeni metin iç içe w:ins açmadan Ali'nin eklemesine katılır.
    expect(body.match(/<w:ins /g)).toHaveLength(1);
    expect(docxToMarkdown(bytes)).toBe("Fiyat {++KDV dahil++}");
  });

  it("boşluk ve tırnak farkını tolere eder; okuma görünümündeki işaretler atılır", () => {
    const doc = buildDocx(p(r("“Codezal”\tsürüm", "<w:i/>")));
    const { bytes } = run(doc, [{ action: "replace", find: '*"Codezal" sürüm*', text: "Sürüm" }]);
    expect(docxToMarkdown(bytes)).toBe("*Sürüm*");
  });

  it("okuma görünümünden kopyalanan başlık ve madde işaretleri eşleşmeyi bozmaz", () => {
    const doc = buildDocx(p(r("Ödeme"), style("Balk2")) + p(r("Montaj dahil")));
    const { bytes } = run(doc, [
      { action: "insert_before", find: "## Ödeme", text: "Not" },
      { action: "replace", find: "- Montaj dahil", text: "Montaj hariç" },
    ]);
    expect(docxToMarkdown(bytes)).toBe("Not\n\n## Ödeme\n\nMontaj hariç");
  });

  it("işaretli satır aynı sözcüğü içeren gövde cümlesiyle çakışmaz; değişimde Markdown biçimdir", () => {
    const doc = buildDocx(p(r("Ödeme"), style("Balk2")) + p(r("Ödeme 60 gün vadelidir.")));
    const { bytes } = run(doc, [
      { action: "insert_after", find: "## Ödeme", text: "Ara not" },
      { action: "replace", find: "60 gün", text: "**30 gün**" },
    ]);
    expect(docxToMarkdown(bytes)).toBe("## Ödeme\n\nAra not\n\nÖdeme **30 gün** vadelidir.");
    expect(() => run(doc, [{ action: "delete", find: "Ödeme" }])).toThrow(/2/);
  });

  it("aynı metin birden çok yerdeyse `all` olmadan hata verir, `all` ile hepsini değiştirir", () => {
    const doc = buildDocx(p(r("A firması")) + p(r("A firması ve A firması")));
    expect(() => run(doc, [{ action: "replace", find: "A firması", text: "B" }])).toThrow(
      DocxEditError,
    );
    const { bytes, counts } = run(doc, [
      { action: "replace", find: "A firması", text: "B firması", all: true },
    ]);
    expect(counts).toEqual({ replace: 3 });
    expect(docxToMarkdown(bytes)).toBe("B firması\n\nB firması ve B firması");
  });

  it("bulunamayan metin ve satır sonlu değişim düzenleme numarasıyla hata verir", () => {
    const doc = buildDocx(p(r("Merhaba")));
    expect(() =>
      run(doc, [
        { action: "replace", find: "Merhaba", text: "Selam" },
        { action: "replace", find: "Merhaba", text: "x" },
      ]),
    ).toThrow(/2/);
    expect(() => run(doc, [{ action: "replace", find: "Merhaba", text: "a\nb" }])).toThrow(
      DocxEditError,
    );
    expect(() => run(doc, [{ action: "delete", find: " " }])).toThrow(DocxEditError);
  });

  it("metin kutusunun Fallback kopyası ayrı eşleşme sayılmaz", () => {
    const box = (text: string) => `<w:txbxContent>${p(r(text))}</w:txbxContent>`;
    const doc = buildDocx(
      p(
        `<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps">${box("Teklif No: 12")}</mc:Choice><mc:Fallback>${box("Teklif No: 12")}</mc:Fallback></mc:AlternateContent></w:r>`,
      ),
    );
    const { counts } = run(doc, [
      { action: "replace", find: "Teklif No: 12", text: "Teklif No: 13" },
    ]);
    expect(counts).toEqual({ replace: 1 });
  });

  it("üst bilgideki metni de bulur", () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = buildDocx(p(r("Gövde")), {
      parts: { "word/header1.xml": `<w:hdr ${W}>${p(r("Gizli taslak"))}</w:hdr>` },
      rels: '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    });
    const { bytes } = run(doc, [{ action: "replace", find: "Gizli taslak", text: "Nihai" }]);
    expect(xml(bytes, "word/header1.xml")).toContain(">Nihai<");
  });
});

describe("editDocx: comment", () => {
  it("yorum parçası, ilişkisi ve içerik türü yoksa oluşturulur", () => {
    const doc = buildDocx(p(r("Ödeme 60 gün vadelidir.")));
    const { bytes, counts } = run(doc, [
      { action: "comment", find: "60 gün", text: "Müşteri 30 gün istedi." },
    ]);
    expect(counts).toEqual({ comment: 1 });
    const zip = ZipArchive.open(bytes);
    expect(zip.readText("word/comments.xml")).toMatch(
      /<w:comment w:id="(\d+)" w:author="Ayşe Yılmaz" w:date="2026-09-28T10:00:00Z" w:initials="AY">/,
    );
    expect(zip.readText("word/_rels/document.xml.rels")).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"',
    );
    expect(zip.readText("[Content_Types].xml")).toContain('PartName="/word/comments.xml"');
    expect(docxToMarkdown(bytes)).toBe(
      "Ödeme {==60 gün==}{>>Ayşe Yılmaz: Müşteri 30 gün istedi.<<} vadelidir.",
    );
  });

  it("var olan yorum parçasına ekler, yeni ilişki açmaz", () => {
    const doc = buildDocx(p(r("bir")) + p(r("iki")));
    const first = run(doc, [{ action: "comment", find: "bir", text: "1" }]).bytes;
    const { bytes } = run(first, [{ action: "comment", find: "iki", text: "2" }]);
    const zip = ZipArchive.open(bytes);
    expect(zip.readText("word/comments.xml")?.match(/<w:comment /g)).toHaveLength(2);
    expect(zip.readText("word/_rels/document.xml.rels")?.match(/comments"/g)).toHaveLength(1);
  });
});

describe("editDocx: insert / delete", () => {
  it("yeni paragraf komşunun biçimini alır; # satırı belgenin başlık stilini kullanır", () => {
    const doc = buildDocx(
      p(r("Özet"), style("Balk1")) + p(r("Metin", '<w:sz w:val="22"/>'), '<w:jc w:val="both"/>'),
    );
    const { bytes } = run(doc, [
      { action: "insert_after", find: "Metin", text: "İkinci **kalın** paragraf\n## Sonuç" },
    ]);
    expect(docxToMarkdown(bytes)).toBe("# Özet\n\nMetin\n\nİkinci **kalın** paragraf\n\n## Sonuç");
    const body = xml(bytes);
    expect(body).toContain('<w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/>');
    expect(body).toContain('<w:pStyle w:val="Balk2"/>');
  });

  it("başlığın önüne eklenen düz metin başlık olmaz", () => {
    const doc = buildDocx(p(r("Özet"), style("Balk1")));
    const { bytes } = run(doc, [{ action: "insert_before", find: "Özet", text: "Giriş notu" }]);
    expect(docxToMarkdown(bytes)).toBe("Giriş notu\n\n# Özet");
  });

  it("izli eklemede paragraf işareti ve run'lar w:ins taşır; ret geri alır", () => {
    const doc = buildDocx(p(r("Birinci")));
    const { bytes } = run(doc, [{ action: "insert_after", find: "Birinci", text: "Yeni" }], true);
    expect(xml(bytes)).toMatch(/<w:pPr><w:rPr><w:ins w:id="\d+"[^>]*\/><\/w:rPr><\/w:pPr><w:ins/);
    expect(docxToMarkdown(bytes)).toBe("Birinci\n\n{++Yeni++}");
    const rejected = run(bytes, [{ action: "reject_all" }]);
    expect(docxToMarkdown(rejected.bytes)).toBe("Birinci");
  });

  it("paragrafı siler; son paragraf ve bölüm sonu taşıyan paragraf kabuk olarak kalır", () => {
    const doc = buildDocx(p(r("A")) + p(r("B")) + p(r("C"), "<w:sectPr/>"));
    const { bytes } = run(doc, [
      { action: "delete", find: "A" },
      { action: "delete", find: "C" },
    ]);
    expect(docxToMarkdown(bytes)).toBe("B");
    expect(xml(bytes)).toContain("<w:p><w:pPr><w:sectPr/></w:pPr></w:p>");
  });

  it("izli silme kabul edilince paragraf kalkar, ret edilince geri gelir", () => {
    const doc = buildDocx(p(r("A")) + p(r("B")) + p(r("C")));
    const { bytes } = run(doc, [{ action: "delete", find: "B" }], true);
    expect(docxToMarkdown(bytes)).toBe("A\n\n{--B--}\n\nC");
    expect(docxToMarkdown(run(bytes, [{ action: "accept_all" }]).bytes)).toBe("A\n\nC");
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe("A\n\nB\n\nC");
  });

  it("aynı paragraftaki iki eşleşme paragrafı bir kez siler", () => {
    const doc = buildDocx(p(r("x ve x")) + p(r("y")));
    const { bytes, counts } = run(doc, [{ action: "delete", find: "x" }]);
    expect(counts).toEqual({ delete: 1 });
    expect(docxToMarkdown(bytes)).toBe("y");
  });
});

describe("editDocx: accept_all / reject_all", () => {
  const tracked = p(
    `${r("Fiyat ")}<w:del w:id="1" w:author="Ali" w:date="${DATE}"><w:r><w:delText>100</w:delText></w:r></w:del><w:ins w:id="2" w:author="Ali" w:date="${DATE}">${r("120")}</w:ins>${r(" TL", `<w:b/><w:rPrChange w:id="3" w:author="Ali" w:date="${DATE}"><w:rPr/></w:rPrChange>`)}`,
  );

  it("kabul: silinenler gider, eklenenler ve yeni biçim kalır", () => {
    const { bytes, counts } = run(buildDocx(tracked), [{ action: "accept_all" }]);
    expect(counts).toEqual({ accept_all: 3 });
    expect(docxToMarkdown(bytes)).toBe("Fiyat 120 **TL**");
    expect(xml(bytes)).not.toMatch(/w:(ins|del|rPrChange)\b/);
  });

  it("ret: eklenenler gider, silinenler ve eski biçim geri gelir", () => {
    const { bytes } = run(buildDocx(tracked), [{ action: "reject_all" }]);
    expect(docxToMarkdown(bytes)).toBe("Fiyat 100 TL");
    expect(xml(bytes)).not.toMatch(/w:(ins|del|delText|rPrChange)\b/);
  });

  it("değişiklik yoksa sayı sıfırdır ve paket yeniden yazılmaz", () => {
    const doc = buildDocx(p(r("Temiz")));
    const { bytes, counts } = run(doc, [{ action: "accept_all" }]);
    expect(counts).toEqual({ accept_all: 0 });
    expect(xml(bytes)).toBe(xml(doc));
  });
});

describe("editDocx: paket", () => {
  it("dokunulmayan parçalar bayt bayt korunur", () => {
    const doc = buildDocx(p(r("a")));
    const { bytes } = run(doc, [{ action: "replace", find: "a", text: "b" }]);
    const before = ZipArchive.open(doc);
    const after = ZipArchive.open(bytes);
    expect(after.names()).toEqual(before.names());
    expect(after.read("word/styles.xml")).toEqual(before.read("word/styles.xml"));
  });

  it("ZIP olmayan girdi okunur bir hatayla reddedilir", () => {
    expect(() => run(Buffer.from("düz metin"), [{ action: "accept_all" }])).toThrow(DocxEditError);
  });
});

describe("resolveDocxEditTarget", () => {
  it("output yoksa kaynağın üstüne, göreli output kaynağın klasörüne yazar", () => {
    expect(resolveDocxEditTarget("belgeler/a.docx", undefined, "/p")).toEqual({
      source: "/p/belgeler/a.docx",
      target: "/p/belgeler/a.docx",
    });
    expect(resolveDocxEditTarget("belgeler/a.docx", "a - düzeltilmiş", "/p").target).toBe(
      "/p/belgeler/a - düzeltilmiş.docx",
    );
    expect(resolveDocxEditTarget("/x/a.docx", "/y/b.DOCX", "/p").target).toBe("/y/b.DOCX");
  });
});

describe("docxEditTool", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codezal-docx-edit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const exec = (params: Record<string, unknown>) =>
    docxEditTool({ cwd: dir }).execute("t1", params as never, undefined, undefined, {} as never);

  it("`output` verilince kaynağa dokunmaz; sonuç farkı ve özeti taşır", async () => {
    const source = join(dir, "teklif.docx");
    writeFileSync(source, buildDocx(p(r("Fiyat 100 TL"))));
    const res = await exec({
      path: "teklif.docx",
      output: "teklif-2",
      track: true,
      edits: [{ action: "replace", find: "100 TL", text: "120 TL" }],
    });
    const target = join(dir, "teklif-2.docx");
    expect(res.details).toMatchObject({ path: target, counts: { replace: 1 } });
    expect(res.details.diff).toContain("-1 Fiyat 100 TL");
    expect(res.details.diff).toContain("+1 Fiyat {--100 TL--}{++120 TL++}");
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain(target);
    expect(text).toContain("Codezal");
    expect(docxToMarkdown(readFileSync(source))).toBe("Fiyat 100 TL");
    expect(docxToMarkdown(readFileSync(target))).toBe("Fiyat {--100 TL--}{++120 TL++}");
  });

  it("başarısız düzenleme dosyaya yazmaz; Word dışı dosya reddedilir", async () => {
    const source = join(dir, "a.docx");
    const original = buildDocx(p(r("Merhaba")));
    writeFileSync(source, original);
    await expect(
      exec({
        path: source,
        edits: [
          { action: "replace", find: "Merhaba", text: "Selam" },
          { action: "delete", find: "yok" },
        ],
      }),
    ).rejects.toThrow(/2/);
    expect(readFileSync(source)).toEqual(original);
    writeFileSync(join(dir, "a.txt"), "x");
    await expect(exec({ path: "a.txt", edits: [{ action: "accept_all" }] })).rejects.toThrow();
    await expect(exec({ path: "yok.docx", edits: [{ action: "accept_all" }] })).rejects.toThrow();
  });
});

describe("editDocx: tablo satırları", () => {
  const tc = (text: string, tcPr = "") =>
    `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${p(text ? r(text) : "")}</w:tc>`;
  const tr = (cells: string, trPr = "") =>
    `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ""}${cells}</w:tr>`;
  const tbl = (rows: string) =>
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>${rows}</w:tbl>`;
  const header = tr(
    `<w:tc>${p(r("Kalem", "<w:b/>"))}</w:tc><w:tc>${p(r("Adet", "<w:b/>"))}</w:tc><w:tc>${p(r("Tutar", "<w:b/>"))}</w:tc>`,
    "<w:tblHeader/>",
  );
  const shade = '<w:shd w:val="clear" w:fill="EEEEEE"/>';
  const doc = buildDocx(
    tbl(
      header +
        tr(tc("Evaporatör", shade) + tc("2") + tc("84.000 TL"), '<w:tblHeader w:val="false"/>') +
        tr(tc("Kondenser", shade) + tc("1") + tc("56.000 TL")),
    ),
  );
  const table = (...rows: string[]) =>
    ["| **Kalem** | **Adet** | **Tutar** |", "| --- | --- | --- |", ...rows].join("\n");

  it("satırı komşunun kopyası olarak ekler; hücre biçimi korunur, dikey birleşme taşınmaz", () => {
    const { bytes, counts } = run(doc, [
      { action: "row_insert_after", find: "Kondenser", text: "| Fan | 3 | 9.000 TL |" },
    ]);
    expect(counts).toEqual({ row_insert_after: 1 });
    expect(docxToMarkdown(bytes)).toBe(
      table(
        "| Evaporatör | 2 | 84.000 TL |",
        "| Kondenser | 1 | 56.000 TL |",
        "| Fan | 3 | 9.000 TL |",
      ),
    );
    expect(xml(bytes).match(/w:fill="EEEEEE"/g)).toHaveLength(3);
  });

  it("başlığın altına eklenen satır başlık biçimini almaz; ayraç satırı atlanır, çok satır eklenir", () => {
    const { bytes } = run(doc, [
      {
        action: "row_insert_after",
        find: "| **Kalem** | **Adet** | **Tutar** |",
        text: "| --- | --- | --- |\n| Fan | 3 | 9.000 TL |\n| Vana \\| küresel | 4 |",
      },
    ]);
    expect(docxToMarkdown(bytes)).toBe(
      table(
        "| Fan | 3 | 9.000 TL |",
        "| Vana \\| küresel | 4 |  |",
        "| Evaporatör | 2 | 84.000 TL |",
        "| Kondenser | 1 | 56.000 TL |",
      ),
    );
    expect(xml(bytes).match(/<w:tblHeader\/>/g)).toHaveLength(1);
  });

  it("okuma çıktısındaki satırın tamamıyla bulur; gövde cümlesindeki aynı sözcükle çakışmaz", () => {
    const withText = buildDocx(
      `${p(r("Kondenser fiyatı güncellendi."))}${tbl(tr(tc("Kondenser") + tc("1") + tc("56.000 TL")) + tr(tc("Fan") + tc("2") + tc("")))}`,
    );
    const { bytes } = run(withText, [
      { action: "row_delete", find: "| Kondenser | 1 | 56.000 TL |" },
    ]);
    expect(docxToMarkdown(bytes)).toBe(
      "Kondenser fiyatı güncellendi.\n\n| Fan | 2 |  |\n| --- | --- | --- |",
    );
  });

  it("izli satır ekleme satır işareti taşır; ret kaldırır, kabul işaretsiz bırakır", () => {
    const { bytes } = run(
      doc,
      [{ action: "row_insert_before", find: "Kondenser", text: "| Fan | 3 | 9.000 TL |" }],
      true,
    );
    expect(xml(bytes)).toMatch(/<w:trPr><w:ins w:id="\d+" w:author="Ayşe Yılmaz"/);
    expect(docxToMarkdown(bytes)).toContain("| {++Fan++} | {++3++} | {++9.000 TL++} |");
    const rows = (b: Uint8Array) => docxToMarkdown(b).split("\n").length;
    expect(rows(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(rows(doc));
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toContain("| Fan | 3 | 9.000 TL |\n| Kondenser");
    expect(xml(accepted)).not.toMatch(/w:(ins|del)\b/);
  });

  it("izli satır silme: kabul satırı kaldırır, ret geri getirir", () => {
    const { bytes } = run(doc, [{ action: "row_delete", find: "Evaporatör" }], true);
    expect(xml(bytes)).toMatch(/<w:tblHeader w:val="false"\/><w:del w:id="\d+"[^>]*\/><\/w:trPr>/);
    expect(docxToMarkdown(bytes)).toContain("| {--Evaporatör--} | {--2--} | {--84.000 TL--} |");
    expect(docxToMarkdown(run(bytes, [{ action: "accept_all" }]).bytes)).toBe(
      table("| Kondenser | 1 | 56.000 TL |"),
    );
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(docxToMarkdown(doc));
  });

  it("silinen satırdaki dikey birleşme başlangıcı alttaki satıra geçer", () => {
    const merged = buildDocx(
      tbl(
        tr(tc("A") + tc("Grup", '<w:vMerge w:val="restart"/>') + tc("1")) +
          tr(tc("B") + tc("", "<w:vMerge/>") + tc("2")) +
          tr(tc("C") + tc("x") + tc("3")),
      ),
    );
    const { bytes } = run(merged, [{ action: "row_delete", find: "| A |" }]);
    expect(xml(bytes)).toContain('<w:vMerge w:val="restart"/></w:tcPr><w:p/>');
  });

  it("birleşik hücre sütunları okuma görünümündeki gibi sayılır", () => {
    const spanned = buildDocx(
      tbl(
        tr(tc("Toplam", '<w:gridSpan w:val="2"/>') + tc("140.000 TL")) +
          tr(tc("a") + tc("b") + tc("c")),
      ),
    );
    const { bytes } = run(spanned, [
      { action: "row_insert_before", find: "Toplam", text: "| Ara toplam |  | 120.000 TL |" },
    ]);
    expect(docxToMarkdown(bytes).split("\n")[0]).toBe("| Ara toplam |  | 120.000 TL |");
  });

  it("kısa satır okuma görünümündeki gibi tablo genişliğine doldurulmuş hâliyle de bulunur", () => {
    const ragged = buildDocx(
      tbl(tr(tc("A") + tc("B") + tc("C")) + tr(tc("Tarih", '<w:gridSpan w:val="1"/>') + tc("x"))),
    );
    const line = docxToMarkdown(ragged).split("\n")[2] ?? "";
    expect(line).toBe("| Tarih | x |  |");
    const { bytes } = run(ragged, [
      { action: "row_insert_after", find: line, text: "| Yeni | y |  |" },
    ]);
    expect(docxToMarkdown(bytes).split("\n")[3]).toBe("| Yeni | y |  |");
  });

  it("hatalar: fazla hücre, tüm satırları silme, bulunamayan ve belirsiz satır", () => {
    expect(() =>
      run(doc, [{ action: "row_insert_after", find: "Kondenser", text: "| a | b | c | d |" }]),
    ).toThrow(/4.*3/);
    expect(() => run(doc, [{ action: "row_delete", find: "TL", all: true }])).not.toThrow();
    expect(() => run(doc, [{ action: "row_delete", find: "|", all: true }])).toThrow(DocxEditError);
    expect(() => run(doc, [{ action: "row_delete", find: "Kompresör" }])).toThrow(
      /tablo satırında/,
    );
    expect(() => run(doc, [{ action: "row_delete", find: "TL" }])).toThrow(/2 yerde/);
    expect(() => run(doc, [{ action: "row_insert_after", find: "Fan" }])).toThrow(DocxEditError);
  });
});

describe("editDocx: sütun ve birleştirme", () => {
  const cell = (text: string, w: number, extra = "", rPr = "") =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${p(text ? r(text, rPr) : "")}</w:tc>`;
  const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
  const grid = (...widths: number[]) =>
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const table = (widths: number[], ...rows: string[]) =>
    `<w:tbl><w:tblPr/>${grid(...widths)}${rows.join("")}</w:tbl>`;
  const doc = buildDocx(
    table(
      [4000, 2000, 3000],
      row(
        cell("Kalem", 4000, "", "<w:b/>"),
        cell("Adet", 2000, "", "<w:b/>"),
        cell("Tutar", 3000, "", "<w:b/>"),
      ),
      row(cell("Evaporatör", 4000), cell("2", 2000), cell("84.000 TL", 3000)),
      row(cell("Kondenser", 4000), cell("1", 2000), cell("56.000 TL", 3000)),
    ),
  );
  const widthsOf = (bytes: Uint8Array) =>
    [...xml(bytes).matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  const total = (ws: number[]) => ws.reduce((a, b) => a + b, 0);

  it("sütun ekler: başlık hücresi başlık biçimini alır, tablo genişliği ve hücre genişlikleri tutarlı", () => {
    const { bytes, counts } = run(doc, [
      { action: "col_insert_after", find: "Adet", text: "| Birim | 42.000 TL | 56.000 TL |" },
    ]);
    expect(counts).toEqual({ col_insert_after: 1 });
    expect(docxToMarkdown(bytes)).toBe(
      [
        "| **Kalem** | **Adet** | **Birim** | **Tutar** |",
        "| --- | --- | --- | --- |",
        "| Evaporatör | 2 | 42.000 TL | 84.000 TL |",
        "| Kondenser | 1 | 56.000 TL | 56.000 TL |",
      ].join("\n"),
    );
    const widths = widthsOf(bytes);
    expect(widths).toHaveLength(4);
    expect(total(widths)).toBe(9000);
    const tcWs = [...xml(bytes).matchAll(/<w:tcW w:w="(\d+)"/g)]
      .slice(0, 4)
      .map((m) => Number(m[1]));
    expect(tcWs).toEqual(widths);
  });

  it("eksik değerler boş kalır; satır başına değer biçimi de kabul edilir", () => {
    const { bytes } = run(doc, [{ action: "col_insert_before", find: "Kalem", text: "No\n1" }]);
    expect(docxToMarkdown(bytes).split("\n")).toEqual([
      "| **No** | **Kalem** | **Adet** | **Tutar** |",
      "| --- | --- | --- | --- |",
      "| 1 | Evaporatör | 2 | 84.000 TL |",
      "|  | Kondenser | 1 | 56.000 TL |",
    ]);
    expect(() =>
      run(doc, [{ action: "col_insert_after", find: "Adet", text: "| a | b | c | d |" }]),
    ).toThrow(/4 değer.*3 satır/);
  });

  it("araya düşen birleşik hücre bir sütun genişler", () => {
    const spanned = buildDocx(
      table(
        [3000, 3000, 3000],
        row(cell("Başlık", 6000, '<w:gridSpan w:val="2"/>'), cell("C", 3000)),
        row(cell("a", 3000), cell("b", 3000), cell("c", 3000)),
      ),
    );
    const { bytes } = run(spanned, [{ action: "col_insert_after", find: "a", text: "| | yeni |" }]);
    expect(xml(bytes)).toContain('<w:gridSpan w:val="3"/>');
    expect(docxToMarkdown(bytes).split("\n")[2]).toBe("| a | yeni | b | c |");
    expect(() =>
      run(spanned, [{ action: "col_insert_after", find: "a", text: "| | yeni |" }], true),
    ).toThrow(/izli modda/);
  });

  it("izli sütun ekleme hücre işareti taşır; ret sütunu ve genişlikleri geri alır", () => {
    const { bytes } = run(
      doc,
      [{ action: "col_insert_after", find: "Tutar", text: "| KDV | %20 | %20 |" }],
      true,
    );
    expect(xml(bytes).match(/<w:cellIns w:id="\d+" w:author="Ayşe Yılmaz"/g)).toHaveLength(3);
    expect(docxToMarkdown(bytes)).toContain("| Evaporatör | 2 | 84.000 TL | {++%20++} |");
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(doc));
    expect(widthsOf(rejected)).toEqual([4000, 2000, 3000]);
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(xml(accepted)).not.toMatch(/w:(cellIns|ins)\b/);
    expect(widthsOf(accepted)).toHaveLength(4);
  });

  it("sütun siler; izli silmede kabul sütunu kaldırır, ret geri getirir", () => {
    const plain = run(doc, [{ action: "col_delete", find: "Adet" }]).bytes;
    expect(docxToMarkdown(plain).split("\n")[2]).toBe("| Evaporatör | 84.000 TL |");
    expect(total(widthsOf(plain))).toBe(9000);
    expect(widthsOf(plain)).toHaveLength(2);

    const { bytes } = run(doc, [{ action: "col_delete", find: "Adet" }], true);
    expect(xml(bytes).match(/<w:cellDel /g)).toHaveLength(3);
    expect(docxToMarkdown(bytes).split("\n")[2]).toBe("| Evaporatör | {--2--} | 84.000 TL |");
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(plain));
    expect(widthsOf(accepted)).toHaveLength(2);
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(docxToMarkdown(doc));
  });

  it("sütun silme hataları: son sütun, çok sütunlu hücre", () => {
    const one = buildDocx(table([3000], row(cell("Tek", 3000)), row(cell("x", 3000))));
    expect(() => run(one, [{ action: "col_delete", find: "Tek" }])).toThrow(/son sütunu/);
    const spanned = buildDocx(
      table(
        [3000, 3000],
        row(cell("Başlık", 6000, '<w:gridSpan w:val="2"/>')),
        row(cell("a", 3000), cell("b", 3000)),
      ),
    );
    expect(() => run(spanned, [{ action: "col_delete", find: "Başlık" }])).toThrow(
      /birden çok sütunu/,
    );
    // Birleşik başlıktan geçen sütun izsiz silinince başlık bir sütun daralır.
    const { bytes } = run(spanned, [{ action: "col_delete", find: "b" }]);
    expect(xml(bytes)).not.toContain("w:gridSpan");
    expect(docxToMarkdown(bytes)).toBe("| Başlık |\n| --- |\n| a |");
    // Hücre kalkmasa da sütun ızgaradan düşer; genişlik korunur.
    expect(widthsOf(bytes)).toEqual([6000]);
  });

  it("satırın boş baş/son ızgara aralığı (gridBefore/gridAfter) sütunla birlikte genişler, daralır", () => {
    const gapped = buildDocx(
      table(
        [2000, 2000, 2000],
        row(cell("A", 2000), cell("B", 2000), cell("C", 2000)),
        `<w:tr><w:trPr><w:gridAfter w:val="1"/></w:trPr>${cell("x", 2000)}${cell("y", 2000)}</w:tr>`,
        `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell("m", 2000)}${cell("n", 2000)}</w:tr>`,
      ),
    );
    const inserted = run(gapped, [
      // "C"nin sağı ikinci satırda boş son aralığa düşer: hücre değil gridAfter büyür.
      { action: "col_insert_after", find: "C", text: "| Yeni |" },
    ]).bytes;
    expect(xml(inserted)).toContain('<w:gridAfter w:val="2"/>');
    expect(widthsOf(inserted)).toHaveLength(4);
    const gridOk = (bytes: Uint8Array) => {
      const body = xml(bytes);
      const cols = widthsOf(bytes).length;
      return [...body.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].every((m) => {
        const inner = m[1] ?? "";
        const gaps = [...inner.matchAll(/<w:grid(?:Before|After) w:val="(\d+)"\/>/g)].reduce(
          (a, g) => a + Number(g[1]),
          0,
        );
        const spans = [...inner.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].reduce(
          (a, c) => a + Number(/<w:gridSpan w:val="(\d+)"/.exec(c[1] ?? "")?.[1] ?? 1),
          0,
        );
        return gaps + spans === cols;
      });
    };
    expect(gridOk(inserted)).toBe(true);
    const deleted = run(gapped, [{ action: "col_delete", find: "A" }]).bytes;
    expect(xml(deleted)).not.toContain("w:gridBefore");
    expect(gridOk(deleted)).toBe(true);
    // İzli ekleme de boş aralıklı satırlarda çalışır; ret aralıkları eski hâline döndürür.
    const tracked = run(
      gapped,
      [{ action: "col_insert_after", find: "C", text: "| Yeni |" }],
      true,
    );
    expect(gridOk(tracked.bytes)).toBe(true);
    const rejected = run(tracked.bytes, [{ action: "reject_all" }]).bytes;
    expect(gridOk(rejected)).toBe(true);
    expect(xml(rejected)).toContain('<w:gridAfter w:val="1"/>');
    expect(widthsOf(rejected)).toEqual([2000, 2000, 2000]);
  });

  it("yatay birleştirme: içerik ilk hücrede toplanır, hücre genişliği sütunların toplamı olur", () => {
    const { bytes, counts } = run(doc, [
      { action: "cell_merge", find: "Evaporatör", to: "84.000 TL" },
    ]);
    expect(counts).toEqual({ cell_merge: 1 });
    expect(docxToMarkdown(bytes).split("\n")[2]).toBe("| Evaporatör<br>2<br>84.000 TL |  |  |");
    expect(xml(bytes)).toContain('<w:tcW w:w="9000" w:type="dxa"/><w:gridSpan w:val="3"/>');
  });

  it("dikey ve dikdörtgen birleştirme; text verilirse içerik o olur", () => {
    const vertical = run(doc, [{ action: "cell_merge", find: "2", to: "1" }]).bytes;
    const lines = docxToMarkdown(vertical).split("\n");
    expect(lines[2]).toBe("| Evaporatör | 2<br>1 | 84.000 TL |");
    expect(lines[3]).toBe("| Kondenser |  | 56.000 TL |");
    expect(xml(vertical)).toMatch(/<w:vMerge w:val="restart"\/>[\s\S]*<w:vMerge\/>/);

    const box = run(doc, [
      { action: "cell_merge", find: "84.000 TL", to: "Kondenser", text: "Paket fiyat" },
    ]).bytes;
    const boxLines = docxToMarkdown(box).split("\n");
    expect(boxLines[2]).toBe("| Paket fiyat |  |  |");
    expect(boxLines[3]).toBe("|  |  |  |");
    expect(xml(box).match(/<w:gridSpan w:val="3"\/>/g)).toHaveLength(2);
  });

  it("izli birleştirme: eski satırlar izli silinir, birleşik hâli izli eklenir", () => {
    const { bytes, counts } = run(
      doc,
      [{ action: "cell_merge", find: "Evaporatör", to: "84.000 TL" }],
      true,
    );
    expect(counts).toEqual({ cell_merge: 1 });
    const body = xml(bytes);
    expect(body.match(/<w:del w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(1);
    expect(body.match(/<w:ins w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(1);
    expect(docxToMarkdown(bytes).split("\n").slice(2, 4)).toEqual([
      "| {--Evaporatör--} | {--2--} | {--84.000 TL--} |",
      "| {++Evaporatör++}<br>{++2++}<br>{++84.000 TL++} |  |  |",
    ]);
    const plain = run(doc, [{ action: "cell_merge", find: "Evaporatör", to: "84.000 TL" }]).bytes;
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(plain));
    expect(xml(accepted)).not.toMatch(/w:(ins|del)\b/);
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(docxToMarkdown(doc));
  });

  it("izli birleştirmede hücredeki yer imi tablo düzeyine taşınır; kabulde de retde de kalır", () => {
    const marked = buildDocx(
      table(
        [4000, 2000],
        row(cell("Kalem", 4000), cell("Adet", 2000)),
        row(
          `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(`<w:bookmarkStart w:id="90" w:name="Kalem1"/>${r("Evaporatör")}<w:bookmarkEnd w:id="90"/>`)}</w:tc>`,
          cell("2", 2000),
        ),
      ),
    );
    const { bytes } = run(marked, [{ action: "cell_merge", find: "Evaporatör", to: "2" }], true);
    const body = xml(bytes);
    expect(body.match(/w:name="Kalem1"/g)).toHaveLength(1);
    // Başlangıç silinen kopyanın, bitiş eklenen satırın dışında; ikisi de tablonun çocuğu.
    expect(body).toMatch(/<\/w:tr><w:bookmarkStart w:id="90" w:name="Kalem1"\/><w:tr>/);
    expect(body).toMatch(/<\/w:tr><w:bookmarkEnd w:id="90"\/><\/w:tbl>/);
    for (const action of ["accept_all", "reject_all"] as const) {
      const resolved = xml(run(bytes, [{ action }]).bytes);
      expect(resolved).toContain('<w:bookmarkStart w:id="90" w:name="Kalem1"/>');
      expect(resolved).toContain('<w:bookmarkEnd w:id="90"/>');
    }
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(
      docxToMarkdown(marked),
    );
  });

  it("izli birleştirmede yorumun eşi silinen kopyaya bağlanır; kabulde asıl, retde eş kalır", () => {
    const plain = buildDocx(
      table(
        [4000, 2000],
        row(cell("Kalem", 4000), cell("Adet", 2000)),
        row(cell("Evaporatör", 4000), cell("2", 2000)),
      ),
    );
    const doc = run(plain, [{ action: "comment", find: "Evaporatör", text: "Model?" }]).bytes;
    const merge: DocxEdit[] = [{ action: "cell_merge", find: "Evaporatör", to: "2" }];
    const { bytes } = run(doc, merge, true);
    const body = xml(bytes);
    const comments = xml(bytes, "word/comments.xml");
    const ids = [...comments.matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    // Eş, silinen kopyadaki (w:del içindeki) göndermeye bağlı; asıl eklenen satırda.
    expect(body).toMatch(new RegExp(`<w:del [^>]*><w:r><w:commentReference w:id="${ids[1]}"/>`));
    expect(body).toMatch(new RegExp(`<w:ins [^>]*><w:r><w:commentReference w:id="${ids[0]}"/>`));
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(run(doc, merge).bytes));
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(doc));
    // Göndermesi düşen yorum parçadan da silinir.
    expect(xml(accepted, "word/comments.xml")).toContain(`w:id="${ids[0]}"`);
    expect(xml(accepted, "word/comments.xml")).not.toContain(`w:id="${ids[1]}"`);
    expect(xml(rejected, "word/comments.xml")).toContain(`w:id="${ids[1]}"`);
    expect(xml(rejected, "word/comments.xml")).not.toContain(`w:id="${ids[0]}"`);
  });

  it("izli birleştirmede yanıt zinciri ve Word'ün yorum kayıtları eşle birlikte çoğalır", () => {
    const plain = buildDocx(
      table(
        [4000, 2000],
        row(cell("Kalem", 4000), cell("Adet", 2000)),
        row(cell("Evaporatör", 4000), cell("2", 2000)),
      ),
    );
    const doc = withReply(
      run(plain, [{ action: "comment", find: "Evaporatör", text: "Model?" }]).bytes,
    );
    const { bytes } = run(doc, [{ action: "cell_merge", find: "Evaporatör", to: "2" }], true);
    const ext = xml(bytes, "word/commentsExtended.xml");
    const paras = [...ext.matchAll(/w15:paraId="([0-9A-F]+)"/g)].map((m) => m[1]);
    expect(paras).toHaveLength(4);
    const [, , twin, twinReply] = paras;
    expect(twin).not.toMatch(/^0A00000/);
    expect(ext).toContain(`w15:paraId="${twinReply}" w15:paraIdParent="${twin}" w15:done="1"`);
    const durables = [...xml(bytes, "word/commentsIds.xml").matchAll(/w16cid:durableId="(\w+)"/g)];
    expect(new Set(durables.map((m) => m[1])).size).toBe(4);
    expect(
      xml(bytes, "word/commentsExtensible.xml").match(/<w16cex:commentExtensible /g),
    ).toHaveLength(4);
    const kept = (bytes: Uint8Array) =>
      [...xml(bytes, "word/commentsExtended.xml").matchAll(/w15:paraId="(\w+)"/g)].map((m) => m[1]);
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(kept(accepted)).toEqual(["0A000001", "0A000002"]);
    expect(
      xml(accepted, "word/commentsExtensible.xml").match(/<w16cex:commentExtensible /g),
    ).toHaveLength(2);
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(kept(rejected)).toEqual([twin, twinReply]);
    expect(xml(rejected, "word/comments.xml").match(/<w:comment /g)).toHaveLength(2);
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(doc));
  });

  it("göndermesi dışarıda olan yorumun satırdaki başı/sonu tablo düzeyine taşınır", () => {
    const priced = (inner: string) =>
      `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(inner)}</w:tc>`;
    const ref = (id: string) => `<w:r><w:commentReference w:id="${id}"/></w:r>`;
    // 70 satırda başlayıp tablodan sonra biter; 71 tablodan önce başlayıp satırda biter.
    const doc = buildDocx(
      p(`<w:commentRangeStart w:id="71"/>${r("Önce")}`) +
        table(
          [4000, 2000],
          row(cell("Kalem", 4000), cell("Adet", 2000)),
          row(
            cell("Evaporatör", 4000),
            priced(`<w:commentRangeStart w:id="70"/>${r("2")}<w:commentRangeEnd w:id="71"/>`),
          ),
        ) +
        p(`${r("Sonra")}<w:commentRangeEnd w:id="70"/>${ref("70")}${ref("71")}`),
    );
    const { bytes } = run(doc, [{ action: "cell_merge", find: "Evaporatör", to: "2" }], true);
    const body = xml(bytes);
    expect(body).toMatch(/<\/w:tr><w:commentRangeStart w:id="70"\/><w:tr>/);
    expect(body).toMatch(/<\/w:tr><w:commentRangeEnd w:id="71"\/><\/w:tbl>/);
    expect(body.match(/w:commentRangeStart w:id="70"/g)).toHaveLength(1);
    expect(body.match(/w:commentRangeEnd w:id="71"/g)).toHaveLength(1);
    for (const action of ["accept_all", "reject_all"] as const) {
      const resolved = xml(run(bytes, [{ action }]).bytes);
      expect(resolved).toContain('<w:commentRangeStart w:id="70"/>');
      expect(resolved).toContain('<w:commentRangeEnd w:id="71"/>');
    }
  });

  it("izli birleştirmenin kabul/retinde aralıktan geçen dış dikey birleşme bozulmaz", () => {
    const outer = buildDocx(
      table(
        [3000, 3000, 3000],
        row(cell("Grup", 3000, '<w:vMerge w:val="restart"/>'), cell("a", 3000), cell("b", 3000)),
        row(cell("", 3000, "<w:vMerge/>"), cell("c", 3000), cell("d", 3000)),
        row(cell("", 3000, "<w:vMerge/>"), cell("e", 3000), cell("f", 3000)),
        row(cell("Son", 3000), cell("g", 3000), cell("h", 3000)),
      ),
    );
    const { bytes } = run(outer, [{ action: "cell_merge", find: "c", to: "f" }], true);
    const merges = (b: Uint8Array) =>
      [...xml(b).matchAll(/<w:vMerge(?: w:val="(\w+)")?\/>/g)].map((m) => m[1] ?? "c").join(",");
    const plain = run(outer, [{ action: "cell_merge", find: "c", to: "f" }]).bytes;
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(merges(accepted)).toBe(merges(plain));
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(plain));
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(merges(rejected)).toBe("restart,c,c");
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(outer));
  });

  it("bekleyen izli değişiklik içeren hücreler izli birleştirilmez", () => {
    const tracked = run(doc, [{ action: "replace", find: "Evaporatör", text: "Fan" }], true).bytes;
    expect(() =>
      run(tracked, [{ action: "cell_merge", find: "Fan", to: "84.000 TL" }], true),
    ).toThrow(/bekleyen izli/);
  });

  it("birleştirme hataları: to yok, aynı hücre, birleşik hücreyi bölen aralık", () => {
    expect(() => run(doc, [{ action: "cell_merge", find: "Kalem" }])).toThrow(/to/);
    expect(() => run(doc, [{ action: "cell_merge", find: "Kalem", to: "Kalem" }])).toThrow(
      /aynı hücre/,
    );
    const merged = run(doc, [{ action: "cell_merge", find: "Kalem", to: "Adet" }]).bytes;
    expect(() => run(merged, [{ action: "cell_merge", find: "2", to: "Tutar" }])).toThrow(
      /ortasından/,
    );
  });
});

describe("editDocx: hücre ayırma ve tablo ekleme/silme", () => {
  const cell = (text: string, w: number, extra = "", rPr = "") =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${p(text ? r(text, rPr) : "")}</w:tc>`;
  const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
  const table = (widths: number[], ...rows: string[]) =>
    `<w:tbl><w:tblPr/><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
  const priceTable = table(
    [4000, 2000, 3000],
    row(
      cell("Kalem", 4000, "", "<w:b/>"),
      cell("Adet", 2000, "", "<w:b/>"),
      cell("Tutar", 3000, "", "<w:b/>"),
    ),
    row(cell("Evaporatör", 4000), cell("2", 2000), cell("84.000 TL", 3000)),
    row(cell("Kondenser", 4000), cell("1", 2000), cell("56.000 TL", 3000)),
  );
  const doc = buildDocx(priceTable);
  const spacer = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>';
  const tcWidths = (bytes: Uint8Array) =>
    [...xml(bytes).matchAll(/<w:tcW w:w="(\d+)"/g)].map((m) => Number(m[1]));

  it("yatay birleşik hücreyi ayırır; içerik ilk hücrede kalır, text ayrılan hücreleri doldurur", () => {
    const merged = run(doc, [{ action: "cell_merge", find: "Evaporatör", to: "84.000 TL" }]).bytes;
    const { bytes, counts } = run(merged, [{ action: "cell_split", find: "Evaporatör" }]);
    expect(counts).toEqual({ cell_split: 1 });
    expect(docxToMarkdown(bytes).split("\n")[2]).toBe("| Evaporatör<br>2<br>84.000 TL |  |  |");
    expect(xml(bytes)).not.toContain("w:gridSpan");
    expect(tcWidths(bytes).slice(3, 6)).toEqual([4000, 2000, 3000]);

    const refilled = run(merged, [
      { action: "cell_split", find: "Evaporatör", text: "| Evaporatör | 2 | 84.000 TL |" },
    ]).bytes;
    expect(docxToMarkdown(refilled)).toBe(docxToMarkdown(doc));
  });

  it("dikey ve dikdörtgen birleşmeyi ayırır; devam hücresinden de bulunur", () => {
    const vertical = run(doc, [{ action: "cell_merge", find: "2", to: "1" }]).bytes;
    const split = run(vertical, [{ action: "cell_split", find: "2<br>1", text: "| 2 |\n| 1 |" }]);
    expect(docxToMarkdown(split.bytes)).toBe(docxToMarkdown(doc));
    expect(xml(split.bytes)).not.toContain("w:vMerge");

    const box = run(doc, [
      { action: "cell_merge", find: "84.000 TL", to: "Kondenser", text: "Paket fiyat" },
    ]).bytes;
    const opened = run(box, [
      { action: "cell_split", find: "Paket fiyat", text: "| | | 84.000 TL |\n| Kondenser |" },
    ]).bytes;
    const lines = docxToMarkdown(opened).split("\n");
    expect(lines[2]).toBe("| Paket fiyat |  | 84.000 TL |");
    expect(lines[3]).toBe("| Kondenser |  |  |");
    expect(xml(opened)).not.toMatch(/w:(gridSpan|vMerge)/);
    expect(tcWidths(opened)).toEqual([4000, 2000, 3000, 4000, 2000, 3000, 4000, 2000, 3000]);
  });

  it("ayrılan hücreler sütunun eski biçimini alır; başlık biçimi gövdeye geçmez", () => {
    const shade = '<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/>';
    const right = '<w:jc w:val="right"/>';
    const money = (text: string) =>
      `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${shade}</w:tcPr>${p(r(text, '<w:sz w:val="18"/>'), right)}</w:tc>`;
    const styled = buildDocx(
      table(
        [4000, 3000],
        row(cell("Kalem", 4000, "", "<w:b/>"), cell("Tutar", 3000, "", "<w:b/>")),
        row(cell("Evaporatör", 4000), money("84.000 TL")),
        row(cell("Kondenser", 4000), money("56.000 TL")),
        row(cell("Fan", 4000), money("9.000 TL")),
      ),
    );
    const merged = run(styled, [
      { action: "cell_merge", find: "Evaporatör", to: "56.000 TL", text: "Paket" },
    ]).bytes;
    const split = run(merged, [
      { action: "cell_split", find: "Paket", text: "| Evaporatör | 84.000 TL |\n| | 56.000 TL |" },
    ]).bytes;
    expect(docxToMarkdown(split).split("\n").slice(2, 4)).toEqual([
      "| Evaporatör | 84.000 TL |",
      "|  | 56.000 TL |",
    ]);
    const body = xml(split);
    // Özgün "Fan" satırıyla birlikte üç tutar hücresi de gölgeli, sağa yaslı ve 9 punto.
    expect(body.match(/w:fill="DDEEFF"/g)).toHaveLength(3);
    expect(body.match(/<w:jc w:val="right"\/>/g)).toHaveLength(3);
    expect(body.match(/<w:sz w:val="18"\/>/g)).toHaveLength(3);
    // Başlıktaki kalın yazı ayrılan gövde hücrelerine geçmez.
    expect(body.match(/<w:b\/>/g)).toHaveLength(2);
    // Boş açılan hücreye yazılacak metin sütunun yazısını alsın: paragraf işareti biçimi taşır.
    const empty = run(merged, [{ action: "cell_split", find: "Paket" }]).bytes;
    expect(xml(empty)).toContain(
      '<w:p><w:pPr><w:jc w:val="right"/><w:rPr><w:sz w:val="18"/></w:rPr></w:pPr></w:p>',
    );
  });

  it("aynı türden satır kalmadıysa başlıktan yalnız hizalama alınır", () => {
    const right = '<w:jc w:val="right"/>';
    const head = (text: string, jc: string) =>
      `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${p(r(text, "<w:b/>"), jc)}</w:tc>`;
    const small = buildDocx(
      table(
        [3000, 3000],
        `<w:tr>${head("Kalem", "")}${head("Tutar", right)}</w:tr>`,
        row(cell("Evaporatör", 3000), cell("84.000 TL", 3000)),
      ),
    );
    const merged = run(small, [
      { action: "cell_merge", find: "Evaporatör", to: "84.000 TL" },
    ]).bytes;
    const split = run(merged, [
      { action: "cell_split", find: "Evaporatör", text: "| Evaporatör | 84.000 TL |" },
    ]).bytes;
    const body = xml(split);
    expect(body.match(/<w:jc w:val="right"\/>/g)).toHaveLength(2);
    expect(body.match(/F2F2F2/g)).toHaveLength(2);
    expect(docxToMarkdown(split).split("\n")[2]).toBe("| Evaporatör | 84.000 TL |");
  });

  it("izli ayırma: satırlar ayrılmış hâlleriyle izli değiştirilir; kabul ayırır, ret geri alır", () => {
    const merged = run(doc, [{ action: "cell_merge", find: "Kalem", to: "Adet" }]).bytes;
    const edit: DocxEdit[] = [{ action: "cell_split", find: "Kalem", text: "| | Adet |" }];
    const { bytes, counts } = run(merged, edit, true);
    expect(counts).toEqual({ cell_split: 1 });
    expect(xml(bytes)).not.toContain("w:cellIns");
    expect(xml(bytes).match(/<w:del w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(1);
    expect(xml(bytes).match(/<w:ins w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(1);
    expect(docxToMarkdown(bytes).split("\n")[2]).toBe(
      "| {++**Kalem**++}<br>{++**Adet**++} | {++**Adet**++} | {++**Tutar**++} |",
    );
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(run(merged, edit).bytes));
    expect(xml(accepted)).not.toMatch(/w:(ins|del)\b/);
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(
      docxToMarkdown(merged),
    );
  });

  it("izli dikey ayırma: kabul/ret sonrası dikey birleşme doğru", () => {
    const vertical = run(doc, [{ action: "cell_merge", find: "2", to: "1" }]).bytes;
    const edit: DocxEdit[] = [{ action: "cell_split", find: "2<br>1", text: "| 2 |\n| 1 |" }];
    const { bytes } = run(vertical, edit, true);
    expect(xml(bytes).match(/<w:del w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(2);
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(docxToMarkdown(accepted)).toBe(docxToMarkdown(doc));
    expect(xml(accepted)).not.toContain("w:vMerge");
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(vertical));
    expect(xml(rejected)).toMatch(/<w:vMerge w:val="restart"\/>[\s\S]*<w:vMerge\/>/);
  });

  it("izli ayırma ve birleştirme satırda bekleyen izli değişiklik varsa reddedilir", () => {
    const merged = run(doc, [{ action: "cell_merge", find: "Evaporatör", to: "2" }]).bytes;
    // Bekleyen değişiklik birleşik hücrede değil, aynı satırın başka hücresinde.
    const pending = run(merged, [{ action: "replace", find: "84.000", text: "90.000" }], true);
    expect(() => run(pending.bytes, [{ action: "cell_split", find: "Evaporatör" }], true)).toThrow(
      /bekleyen izli/,
    );
    expect(() =>
      run(pending.bytes, [{ action: "cell_merge", find: "Kondenser", to: "1" }], true),
    ).not.toThrow();
  });

  it("ayırma hataları: birleşik olmayan hücre, alandan büyük text", () => {
    expect(() => run(doc, [{ action: "cell_split", find: "Kalem" }])).toThrow(/birleşik değil/);
    const merged = run(doc, [{ action: "cell_merge", find: "Kalem", to: "Adet" }]).bytes;
    expect(() =>
      run(merged, [{ action: "cell_split", find: "Kalem", text: "| a | b | c |" }]),
    ).toThrow(/1 satır × 2 sütun/);
  });

  it("belgede tablo yoksa docx_create görünümüyle tablo ekler; hizalama ve genişlik", () => {
    const plain = buildDocx(p(r("Teklif özeti")));
    const { bytes, counts } = run(plain, [
      {
        action: "table_insert_after",
        find: "Teklif özeti",
        text: "| Model | Kapasite |\n| --- | ---: |\n| GS-40 | 4,2 kW |\n| GS-60 | 6,1 kW |",
      },
    ]);
    expect(counts).toEqual({ table_insert_after: 1 });
    expect(docxToMarkdown(bytes)).toBe(
      [
        "Teklif özeti",
        "",
        "| **Model** | **Kapasite** |",
        "| --- | --- |",
        "| GS-40 | 4,2 kW |",
        "| GS-60 | 6,1 kW |",
      ].join("\n"),
    );
    const body = xml(bytes);
    expect(body).toContain('w:color="BFBFBF"');
    expect(body.match(/w:fill="F2F2F2"/g)).toHaveLength(2);
    expect(body.match(/<w:jc w:val="right"\/>/g)).toHaveLength(3);
    const grid = [...body.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(grid.reduce((a, b) => a + b, 0)).toBe(9638);
    // Gövde tabloyla bitemez: arkasına boş paragraf girer.
    expect(body).toContain(`</w:tbl>${spacer}<w:sectPr/>`);
  });

  it("hücre metni verilince yeni tablo o tablonun altına girer ve onun görünümünü alır", () => {
    const withText = buildDocx(`${priceTable}${p(r("Ödeme koşulları"))}`);
    const { bytes } = run(withText, [
      {
        action: "table_insert_after",
        find: "Kondenser",
        text: "| Opsiyon | Tutar |\n|---|---|\n| Montaj | 12.000 TL |",
      },
    ]);
    const lines = docxToMarkdown(bytes).split("\n");
    expect(lines.slice(4)).toEqual([
      "",
      "| **Opsiyon** | **Tutar** |",
      "| --- | --- |",
      "| Montaj | 12.000 TL |",
      "",
      "Ödeme koşulları",
    ]);
    // Ardışık iki tablo Word'de birleşir: araya boş paragraf girer; alttaki metinden de ayrılır.
    expect(xml(bytes)).toContain(`</w:tbl>${spacer}<w:tbl>`);
    expect(xml(bytes)).toMatch(new RegExp(`</w:tbl>${spacer}<w:p><w:r>`));
    expect(xml(bytes)).not.toContain("BFBFBF");
  });

  it("arkadaki blok zaten boş paragrafsa ikinci boş paragraf eklenmez", () => {
    const text = "| A |\n|---|\n| 1 |";
    const gapped = buildDocx(`${p(r("Giriş"))}<w:p/>${p(r("Son"))}`);
    const { bytes } = run(gapped, [{ action: "table_insert_after", find: "Giriş", text }]);
    expect(xml(bytes)).toContain("</w:tbl><w:p/><w:p><w:r>");
    const tracked = run(
      buildDocx(p(r("Giriş")) + p(r("Son"))),
      [{ action: "table_insert_after", find: "Giriş", text }],
      true,
    ).bytes;
    expect(xml(tracked)).toMatch(/<\/w:tbl><w:p><w:pPr><w:spacing [^>]*\/><w:rPr><w:ins /);
  });

  it("kalıbın sütuna özgü hizalaması yeni tabloya geçmez, tablo geneli hizalama geçer", () => {
    const right = '<w:jc w:val="right"/>';
    const aligned = (all: boolean) =>
      buildDocx(
        table(
          [3000, 3000],
          row(cell("A", 3000), cell("B", 3000)),
          `<w:tr><w:tc>${p(r("a"), all ? right : "")}</w:tc><w:tc>${p(r("1"), right)}</w:tc></w:tr>`,
        ) + p(r("Son")),
      );
    const text = "| X | Y |\n|---|---|\n| x | y |";
    const mixed = run(aligned(false), [{ action: "table_insert_after", find: "Son", text }]).bytes;
    expect(xml(mixed).match(/w:val="right"/g)).toHaveLength(1);
    const same = run(aligned(true), [{ action: "table_insert_after", find: "Son", text }]).bytes;
    expect(xml(same).match(/w:val="right"/g)).toHaveLength(4);
  });

  it("izli tablo ekleme: ret tabloyu tümüyle kaldırır, kabul işaretsiz bırakır", () => {
    const plain = buildDocx(p(r("Giriş")) + p(r("Son")));
    const { bytes } = run(
      plain,
      [{ action: "table_insert_before", find: "Son", text: "| A | B |\n|---|---|\n| 1 | 2 |" }],
      true,
    );
    expect(xml(bytes).match(/<w:ins w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(2);
    expect(docxToMarkdown(bytes)).toContain("| {++1++} | {++2++} |");
    const rejected = run(bytes, [{ action: "reject_all" }]).bytes;
    expect(xml(rejected)).not.toContain("<w:tbl>");
    expect(docxToMarkdown(rejected)).toBe(docxToMarkdown(plain));
    const accepted = run(bytes, [{ action: "accept_all" }]).bytes;
    expect(xml(accepted)).not.toMatch(/w:(ins|del)\b/);
    expect(docxToMarkdown(accepted)).toBe(
      "Giriş\n\n| **A** | **B** |\n| --- | --- |\n| 1 | 2 |\n\nSon",
    );
  });

  it("tablo siler; tek blok tabloysa yerine boş paragraf, iki tablo yan yana kalırsa ayraç girer", () => {
    const withText = buildDocx(`${p(r("Önce"))}${priceTable}${p(r("Sonra"))}`);
    const { bytes, counts } = run(withText, [{ action: "table_delete", find: "Kondenser" }]);
    expect(counts).toEqual({ table_delete: 1 });
    expect(docxToMarkdown(bytes)).toBe("Önce\n\nSonra");

    const only = run(doc, [{ action: "table_delete", find: "| Kalem | Adet | Tutar |" }]).bytes;
    expect(xml(only)).toContain("<w:body><w:p/><w:sectPr/>");

    const small = (text: string) => table([3000], row(cell(text, 3000)), row(cell("x", 3000)));
    const three = buildDocx(small("Bir") + small("İki") + small("Üç"));
    const middle = run(three, [{ action: "table_delete", find: "İki" }]).bytes;
    expect(xml(middle).match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml(middle)).toContain("</w:tbl><w:p/><w:tbl>");
  });

  it("izli tablo silme: kabul tabloyu kaldırır, ret geri getirir", () => {
    const withText = buildDocx(`${p(r("Önce"))}${priceTable}${p(r("Sonra"))}`);
    const { bytes } = run(withText, [{ action: "table_delete", find: "Kalem" }], true);
    expect(xml(bytes).match(/<w:del w:id="\d+"[^>]*\/><\/w:trPr>/g)).toHaveLength(3);
    expect(docxToMarkdown(bytes)).toContain("| {--Kondenser--} | {--1--} | {--56.000 TL--} |");
    expect(docxToMarkdown(run(bytes, [{ action: "accept_all" }]).bytes)).toBe("Önce\n\nSonra");
    expect(docxToMarkdown(run(bytes, [{ action: "reject_all" }]).bytes)).toBe(
      docxToMarkdown(withText),
    );
  });

  it("tablo hataları: bulunamayan tablo, boş text, belirsiz çapa", () => {
    expect(() => run(doc, [{ action: "table_delete", find: "Kompresör" }])).toThrow(
      /hiçbir tabloda/,
    );
    const plain = buildDocx(p(r("Not")) + p(r("Not")));
    expect(() => run(plain, [{ action: "table_insert_after", find: "Not" }])).toThrow(
      /text boş olamaz/,
    );
    expect(() =>
      run(plain, [{ action: "table_insert_after", find: "Not", text: "| a |\n|---|\n| b |" }]),
    ).toThrow(/2 yerde/);
    const both = run(plain, [
      { action: "table_insert_after", find: "Not", text: "| a |\n|---|\n| b |", all: true },
    ]);
    expect(both.counts).toEqual({ table_insert_after: 2 });
  });
});
