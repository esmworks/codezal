import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test PDF'i üreticisi; `pdf.test.ts` ve `read-tool.test.ts` paylaşır, uygulama kodu kullanmaz. */
export interface PageSpec {
  /** Metin katmanı; verilmezse sayfa metinsiz kalır (okuyucu için taranmış sayfayla aynı). */
  text?: string;
  /** Sayfaya çizilecek vektör yolu; çizim eşiğini gerçek bir çizim gömmeden sınar. */
  paths?: number;
}

/** Yer imi (içindekiler) düğümü; `page` 1 tabanlıdır. */
export interface OutlineSpec {
  title: string;
  page: number;
  children?: OutlineSpec[];
}

interface OutlineNode {
  spec: OutlineSpec;
  id: number;
  parent: number;
  kids: OutlineNode[];
}

/**
 * Küçük ve geçerli bir PDF üretir: metni verilen sayfada metin katmanı olur, verilmeyen sayfa
 * boş kalır. Boş sayfa ile taranmış sayfa okuyucu için aynıdır (ikisinde de metin katmanı yok),
 * bu yüzden görüntü yolunu ikili dosya gömmeden sınayabiliyoruz.
 */
export function buildPdf(
  pages: readonly PageSpec[],
  outline: readonly OutlineSpec[] = [],
): Uint8Array {
  const n = pages.length;
  const pageIds = pages.map((_, i) => 3 + i);
  const contentIds = pages.map((_, i) => 3 + n + i);
  const fontId = 3 + 2 * n;
  const outlineId = fontId + 1;

  // Yer imleri derinlik öncelikli numaralanır; gövdeler de bu sırayla yazılır.
  let nextId = outlineId + 1;
  const flat: OutlineNode[] = [];
  const build = (specs: readonly OutlineSpec[], parent: number): OutlineNode[] =>
    specs.map((spec) => {
      const node: OutlineNode = { spec, id: nextId++, parent, kids: [] };
      flat.push(node);
      node.kids = build(spec.children ?? [], node.id);
      return node;
    });
  const roots = build(outline, outlineId);
  const pdfString = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const children = (kids: readonly OutlineNode[]) => {
    const first = kids[0];
    const last = kids[kids.length - 1];
    return first && last
      ? ` /First ${first.id} 0 R /Last ${last.id} 0 R /Count ${kids.length}`
      : "";
  };
  const siblingsOf = (node: OutlineNode) =>
    node.parent === outlineId ? roots : (flat.find((f) => f.id === node.parent)?.kids ?? []);

  const bodies: string[] = [
    roots.length > 0
      ? `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineId} 0 R >>`
      : "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`,
  ];
  pages.forEach((_, i) => {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`,
    );
  });
  for (const page of pages) {
    // Her `m … l … S` üçlüsü pdfjs'te ayrı bir yol olur; çizgiler sayfaya sığacak biçimde dizilir.
    const lines = Array.from(
      { length: page.paths ?? 0 },
      (_, i) => `${(i % 55) * 10 + 20} 20 m ${(i % 55) * 10 + 20} 820 l S`,
    ).join(" ");
    // Metin satırlara bölünür: sayfa dışına taşan yazıyı pdfjs metin katmanına almıyor.
    const rows = page.text?.match(/.{1,70}/g) ?? [];
    const text = rows.length
      ? `BT /F1 11 Tf 40 800 Td ${rows.map((row) => `(${row}) Tj 0 -13 Td`).join(" ")} ET`
      : "";
    const stream = [text, lines].filter(Boolean).join("\n");
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (roots.length > 0) {
    bodies.push(`<< /Type /Outlines${children(roots)} >>`);
    for (const node of flat) {
      const siblings = siblingsOf(node);
      const at = siblings.indexOf(node);
      const prev = siblings[at - 1];
      const next = siblings[at + 1];
      const page = pageIds[node.spec.page - 1] ?? pageIds[0];
      bodies.push(
        `<< /Title (${pdfString(node.spec.title)}) /Parent ${node.parent} 0 R ` +
          `/Dest [${page} 0 R /Fit]${prev ? ` /Prev ${prev.id} 0 R` : ""}` +
          `${next ? ` /Next ${next.id} 0 R` : ""}${children(node.kids)} >>`,
      );
    }
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export async function writePdf(
  pages: readonly PageSpec[],
  name = "belge.pdf",
  outline: readonly OutlineSpec[] = [],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codezal-pdf-"));
  const path = join(dir, name);
  await writeFile(path, buildPdf(pages, outline));
  return path;
}
