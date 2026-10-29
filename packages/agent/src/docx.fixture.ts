import { crc32, deflateRawSync } from "node:zlib";

/** Test .docx üreticisi; `docx.test.ts` ve `read-tool.test.ts` paylaşır, uygulama kodu kullanmaz. */

/** Girdileri ZIP'e yazar; `stored` verilen adlar sıkıştırılmadan (yöntem 0) girer. */
export function buildZip(files: Record<string, string>, stored: readonly string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const store = stored.includes(name);
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Gövde XML'ini (w:body içeriği) Türkçe Word'ün ürettiği stil ve numaralandırmayla paketler. */
export interface DocxFixtureOptions {
  stored?: boolean;
  /** Ek paket parçaları (ör. `word/header1.xml`). */
  parts?: Record<string, string>;
  /** `document.xml.rels`'e eklenecek `<Relationship .../>` satırları. */
  rels?: string;
}

export function buildDocx(body: string, options: DocxFixtureOptions = {}): Buffer {
  const files: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${R}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    // Türkçe Word yerleşik başlığın kimliğini "Balk1" yazar, adı yine "heading 1" kalır.
    "word/styles.xml": `<w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Balk1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Balk2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="KonuBal"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="OzelBaslik"><w:name w:val="Özel Başlık"/><w:basedOn w:val="Balk2"/></w:style>
<w:style w:type="paragraph" w:styleId="Madde"><w:name w:val="Madde"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
</w:styles>`,
    "word/numbering.xml": `<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId9" Type="hyperlink" Target="https://codezal.app/?a=1&amp;b=2" TargetMode="External"/>
${options.rels ?? ""}</Relationships>`,
    ...options.parts,
  };
  return buildZip(files, options.stored ? Object.keys(files) : []);
}

export const p = (inner: string, pPr = "") =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
export const r = (text: string, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
export const num = (id: number, ilvl = 0) =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${id}"/></w:numPr>`;
