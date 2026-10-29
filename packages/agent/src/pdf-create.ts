import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { expandPath } from "./resources.js";

export const PDF_TOOL = "pdf_create";

export type PdfPageSize = "A4" | "Letter";

export interface PdfRenderInput {
  /** Tam HTML belge; göreli görsel yolları `baseDir`'e göre çözülür. */
  html: string;
  /** PDF'in yazılacağı klasör; `<base href>` buna çevrilir. */
  baseDir: string;
  pageSize: PdfPageSize;
  landscape: boolean;
}

/** Main süreci HTML'i Chromium ile PDF'e çevirir (`printToPDF`); ajan paketi Electron'u bilmez. */
export type PdfRenderer = (input: PdfRenderInput) => Promise<Uint8Array>;

/**
 * Dosya üreten araçların (`pdf_create`, `docx_create`) hedef yolu: mutlak ve `~` olduğu gibi;
 * göreli ad Asistan'da çıktı klasörüne, diğer modlarda çalışma klasörüne göre. Uzantı yoksa
 * eklenir ki model "rapor" deyince "rapor.pdf" çıksın.
 */
export function resolveCreatePath(
  raw: string,
  cwd: string,
  outputsDir: string | undefined,
  ext: string,
): string {
  const trimmed = raw.trim();
  const base = outputsDir ?? cwd;
  const path = trimmed.startsWith("~")
    ? expandPath(trimmed)
    : isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(base, trimmed);
  return path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`;
}

export function resolvePdfPath(raw: string, cwd: string, outputsDir?: string): string {
  return resolveCreatePath(raw, cwd, outputsDir, ".pdf");
}

/**
 * Göreli kaynaklar (görsel, yazı tipi) PDF'in klasörüne göre çözülsün diye `<base href>` eklenir;
 * belge kendi `<base>`'ini taşıyorsa dokunulmaz. `<head>` yoksa tarayıcı baştaki `<base>`'i örtük
 * head'e alır.
 */
export function withBaseHref(html: string, baseUrl: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${baseUrl.replace(/"/g, "%22")}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`;
  return `${tag}${html}`;
}

/**
 * Sayfa sayısı: Chromium'un (Skia) PDF'inde her sayfa nesnesi düz `/Type /Page` taşır; nesne akışı
 * kullanılmadığından ham baytlarda saymak yeter. Sayılamazsa 0 döner, sonuçta gösterilmez.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
}

/**
 * PDF üretim aracı: model tam bir HTML belge yazar, main süreci Chromium ile PDF'e çevirir ve dosya
 * hedef yola yazılır. Terminalde reportlab/pandoc aramaya gerek kalmaz; Türkçe karakterler sistem
 * yazı tipleriyle doğrudan basılır. Okuma tarafı `read` aracında kalır (bkz. engine `#pdfExtension`).
 */
export function pdfCreateTool(
  render: PdfRenderer,
  options: { lang?: Locale; cwd: string; outputsDir?: string },
) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  return defineTool({
    name: PDF_TOOL,
    label: d.agent.tool.pdf,
    description: p.pdfCreateDesc,
    promptSnippet: p.pdfCreateSnippet,
    promptGuidelines: [p.pdfCreateGuideline],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: p.pdfCreatePath }),
      html: Type.String({ minLength: 1, description: p.pdfCreateHtml }),
      pageSize: Type.Optional(
        Type.Union([Type.Literal("A4"), Type.Literal("Letter")], {
          description: p.pdfCreatePageSize,
        }),
      ),
      landscape: Type.Optional(Type.Boolean({ description: p.pdfCreateLandscape })),
    }),
    async execute(_id, params) {
      if (!params.html.trim()) throw new Error(d.errors.pdfHtmlEmpty);
      const path = resolvePdfPath(params.path, options.cwd, options.outputsDir);
      const baseDir = dirname(path);
      mkdirSync(baseDir, { recursive: true });
      let bytes: Uint8Array;
      try {
        bytes = await render({
          html: params.html,
          baseDir,
          pageSize: params.pageSize ?? "A4",
          landscape: params.landscape ?? false,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fill(d.errors.pdfRenderFailed, { reason }));
      }
      writeFileSync(path, bytes);
      const pages = countPdfPages(bytes);
      const kb = Math.max(1, Math.round(bytes.byteLength / 1024));
      const text =
        pages > 0
          ? fill(p.pdfCreated, { path, pages, kb })
          : fill(p.pdfCreatedNoPages, { path, kb });
      return {
        content: [{ type: "text" as const, text }],
        details: { path, bytes: bytes.byteLength, pages },
      };
    },
  });
}
