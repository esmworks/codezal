import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { markdownToDocx } from "./docx-build.js";
import { resolveCreatePath } from "./pdf-create.js";

export const DOCX_TOOL = "docx_create";

export function resolveDocxPath(raw: string, cwd: string, outputsDir?: string): string {
  return resolveCreatePath(raw, cwd, outputsDir, ".docx");
}

/**
 * Word üretim aracı: model Markdown yazar, araç .docx'e çevirip hedef yola yazar. `pdf_create`'in
 * eşidir; betikle python-docx/docx-js aramaya gerek kalmaz. Okuma tarafı `read` aracındadır:
 * sonuç, modelin ürettiğini `read` ile geri okuyup denetlemesini söyler.
 */
export function docxCreateTool(options: { lang?: Locale; cwd: string; outputsDir?: string }) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  return defineTool({
    name: DOCX_TOOL,
    label: d.agent.tool.docx,
    description: p.docxCreateDesc,
    promptSnippet: p.docxCreateSnippet,
    promptGuidelines: [p.docxCreateGuideline],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: p.docxCreatePath }),
      markdown: Type.String({ minLength: 1, description: p.docxCreateMarkdown }),
      title: Type.Optional(Type.String({ description: p.docxCreateTitle })),
      pageSize: Type.Optional(
        Type.Union([Type.Literal("A4"), Type.Literal("Letter")], {
          description: p.docxCreatePageSize,
        }),
      ),
      landscape: Type.Optional(Type.Boolean({ description: p.docxCreateLandscape })),
      pageNumbers: Type.Optional(Type.Boolean({ description: p.docxCreatePageNumbers })),
    }),
    async execute(_id, params) {
      if (!params.markdown.trim()) throw new Error(d.errors.docxMarkdownEmpty);
      const path = resolveDocxPath(params.path, options.cwd, options.outputsDir);
      const baseDir = dirname(path);
      mkdirSync(baseDir, { recursive: true });
      let result: Awaited<ReturnType<typeof markdownToDocx>>;
      try {
        result = await markdownToDocx(params.markdown, {
          baseDir,
          pageSize: params.pageSize ?? "A4",
          landscape: params.landscape ?? false,
          pageNumbers: params.pageNumbers ?? true,
          lang,
          ...(params.title ? { title: params.title } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fill(d.errors.docxBuildFailed, { reason }));
      }
      writeFileSync(path, result.bytes);
      const kb = Math.max(1, Math.round(result.bytes.byteLength / 1024));
      let text = fill(p.docxCreated, {
        path,
        kb,
        headings: result.headings,
        tables: result.tables,
        images: result.images,
      });
      if (result.warnings.length > 0) {
        text += `\n${p.docxCreatedWarnings}\n${result.warnings.map((w) => `- ${w}`).join("\n")}`;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { path, bytes: result.bytes.byteLength, warnings: result.warnings },
      };
    },
  });
}
