import { describe, expect, it } from "vitest";
import { buildZip } from "./docx.fixture.js";
import {
  cloneNode,
  isElement,
  parseXml,
  relsPathOf,
  resolvePart,
  serializeXml,
  ZipArchive,
} from "./ooxml.js";

describe("parseXml / serializeXml", () => {
  it("varlıkları çözer, kendiliğinden kapanan etiketi ve eksik kapanışı tolere eder", () => {
    const root = parseXml(
      '<?xml version="1.0"?><a x="1 &amp; 2"><b/><c>&lt;ğ&#x15F;&#305;&gt;</c><d></a>',
    );
    const a = root.children.find(isElement);
    expect(a?.attrs.x).toBe("1 & 2");
    expect(a?.children.map((c) => (isElement(c) ? c.name : c))).toEqual(["b", "c", "d"]);
    const c = a?.children[1];
    expect(c && isElement(c) ? c.children[0] : undefined).toBe("<ğşı>");
  });

  it("bildirimi, yorumu ve boşluğu koruyarak anlamca aynı geri yazar", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<!-- not --><w:document xmlns:w="u" mc:Ignorable="w14"><w:body><w:p><w:r><w:t xml:space="preserve"> a &amp; b &lt; c "d" </w:t></w:r><w:r><w:t></w:t></w:r></w:p></w:body></w:document>';
    const out = serializeXml(parseXml(xml));
    expect(out).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<!-- not --><w:document xmlns:w="u" mc:Ignorable="w14"><w:body><w:p><w:r><w:t xml:space="preserve"> a &amp; b &lt; c "d" </w:t></w:r><w:r><w:t/></w:r></w:p></w:body></w:document>',
    );
    expect(serializeXml(parseXml(out))).toBe(out);
    expect(serializeXml(parseXml('<a b="x&quot;y&amp;"/>'))).toBe('<a b="x&quot;y&amp;"/>');
  });

  it("cloneNode derin kopyalar", () => {
    const a = parseXml("<a><b c='1'>t</b></a>").children.find(isElement);
    if (!a) throw new Error("yok");
    const copy = cloneNode(a);
    const b = copy.children.find(isElement);
    if (b) b.attrs.c = "2";
    expect(serializeXml(a)).toBe('<a><b c="1">t</b></a>');
  });
});

describe("ZipArchive", () => {
  it("değişmeyen girdiyi ham baytıyla kopyalar, değişeni yeniden yazar, yenisini ekler", () => {
    const zip = ZipArchive.open(
      buildZip({ "a.xml": "<a/>", "b.bin": "ikili", "c.txt": "düz" }, ["c.txt"]),
    );
    expect(zip.names()).toEqual(["a.xml", "b.bin", "c.txt"]);
    zip.set("a.xml", "<a>yeni</a>");
    zip.set("d/e.xml", "<e/>");
    const again = ZipArchive.open(zip.toBuffer());
    expect(again.names()).toEqual(["a.xml", "b.bin", "c.txt", "d/e.xml"]);
    expect(again.readText("a.xml")).toBe("<a>yeni</a>");
    expect(again.readText("b.bin")).toBe("ikili");
    expect(again.readText("c.txt")).toBe("düz");
    expect(again.readText("d/e.xml")).toBe("<e/>");
    expect(again.has("yok")).toBe(false);
  });

  it("ZIP olmayanı kodlu hatayla reddeder", () => {
    expect(() => ZipArchive.open(Buffer.from("x".repeat(40)))).toThrow("notZip");
  });
});

describe("paket yolları", () => {
  it("göreli hedefi ve rels yolunu çözer", () => {
    expect(resolvePart("word/document.xml", "media/a.png")).toBe("word/media/a.png");
    expect(resolvePart("word/document.xml", "../customXml/item1.xml")).toBe("customXml/item1.xml");
    expect(resolvePart("word/document.xml", "/word/x.xml")).toBe("word/x.xml");
    expect(relsPathOf("word/document.xml")).toBe("word/_rels/document.xml.rels");
  });
});
