import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { isDocx, readDocxContent } from "./docx.js";
import { readPdfContent, searchPdfContent } from "./pdf.js";
import { resolveReadPath } from "./read-path.js";
import { isXlsx, readXlsxContent } from "./xlsx.js";

export const READ_TOOL = "read";

const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);

const isPdf = (path: string) => path.toLowerCase().endsWith(".pdf");

/**
 * Pi'nin `read` aracını aynı adla sarar; Pi aynı adlı özel aracı yerleşik olanın yerine koyar.
 * Neden: model hangi aracı seçeceğine araç açıklamasından karar verir. Pi'nin açıklaması "metin
 * ve görsel" der, PDF'den söz etmez ve `offset`'i satır numarası diye tanıtır; sistem istemindeki
 * tek satır (`prompt.pdfRead`) yetmeyince model PDF'i terminalde pypdf/pymupdf ile açmaya
 * kalkıyordu. PDF (`readPdfContent`), Word (`readDocxContent`) ve Excel (`readXlsxContent`) burada
 * doğrudan okunur, diğer dosyalar Pi'ye bırakılır; Pi ZIP/ikili baytlarını metin sanıyordu.
 * `render` yalnızca PDF içindir: metin ağırlıklı sayfa da istek üzerine görüntü olarak gelir.
 * `search` de yalnızca PDF içindir: uzun katalogda sayfa tahmin etmek yerine terim aranır.
 */
export function readTool(cwd: string, lang: Locale = "tr") {
  const d = dict(lang);
  const p = d.prompt;
  const base = createReadToolDefinition(cwd);
  return defineTool({
    name: READ_TOOL,
    label: base.label,
    description: fill(p.readDesc, { lines: DEFAULT_MAX_LINES, kb: DEFAULT_MAX_BYTES / 1024 }),
    ...(base.promptSnippet ? { promptSnippet: base.promptSnippet } : {}),
    ...(base.promptGuidelines ? { promptGuidelines: [...base.promptGuidelines] } : {}),
    parameters: Type.Object({
      path: Type.String({ description: p.readPath }),
      offset: Type.Optional(Type.Number({ description: p.readOffset })),
      limit: Type.Optional(Type.Number({ description: p.readLimit })),
      render: Type.Optional(Type.Boolean({ description: p.readRender })),
      search: Type.Optional(Type.String({ description: p.readSearch })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const search = params.search?.trim();
      // Metin dosyasında `search` sessizce yok sayılırsa model dosyanın tamamını arama sonucu sanar.
      if (search && !isPdf(params.path)) throw new Error(d.pdf.searchOnlyPdf);
      if (isPdf(params.path)) {
        // Yol Pi'nin `read` aracıyla aynı kurallarla çözülür (`@`, `~`, macOS yazımları).
        const target = await resolveReadPath(params.path, ctx.cwd || cwd);
        // Dosya yoksa Pi'nin hata mesajı daha açıklayıcıdır; PDF yolu yalnızca var olanı alır.
        if (target.exists) {
          const vision = ctx.model?.input.includes("image") ?? false;
          try {
            if (search) {
              const content = await searchPdfContent(target.path, search, {
                lang,
                ...(signal ? { signal } : {}),
              });
              return { content, details: undefined };
            }
            const content = await readPdfContent(target.path, {
              vision,
              lang,
              ...(params.offset !== undefined ? { firstPage: params.offset } : {}),
              ...(params.limit !== undefined ? { pageLimit: params.limit } : {}),
              ...(params.render ? { render: true } : {}),
            });
            return { content, details: undefined };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(fill(d.pdf.unreadable, { reason }));
          }
        }
      }
      if (isDocx(params.path)) {
        const target = await resolveReadPath(params.path, ctx.cwd || cwd);
        if (target.exists) {
          try {
            const content = await readDocxContent(target.path, {
              lang,
              maxLines: DEFAULT_MAX_LINES,
              maxBytes: DEFAULT_MAX_BYTES,
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            });
            return { content, details: undefined };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(fill(d.docx.unreadable, { reason }));
          }
        }
      }
      if (isXlsx(params.path)) {
        const target = await resolveReadPath(params.path, ctx.cwd || cwd);
        if (target.exists) {
          try {
            const content = await readXlsxContent(target.path, {
              lang,
              maxLines: DEFAULT_MAX_LINES,
              maxBytes: DEFAULT_MAX_BYTES,
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            });
            return { content, details: undefined };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(fill(d.xlsx.unreadable, { reason }));
          }
        }
      }
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
