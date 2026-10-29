import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  editPdf,
  type PdfEditAction,
  PdfEditError,
  type PdfEditInput,
  type PdfFieldInfo,
  resolvePdfEditTargets,
} from "./pdf-edit.js";

export const PDF_EDIT_TOOL = "pdf_edit";

/** Sonuç ayrıntısı: `path` kartın yeni hedefi (mapping `resolvedTargetOf`), `paths` bütün çıktılar. */
export interface PdfEditDetails {
  path: string;
  action: PdfEditAction;
  paths?: string[];
  pages?: number;
  bytes?: number;
  fields?: PdfFieldInfo[];
}

/**
 * Var olan PDF'i düzenleme aracı (`pdf-lib`): birleştir, böl, döndür, sayfa sil/çıkar, filigran,
 * form doldur. Girdi yalnız `output` açıkça onu gösterirse değişir; varsayılan çıktı kaynağın
 * yanında ekli bir addır. Kart `create` türündedir: Çıktılar kutusu ve tur dosya listesi yeni
 * PDF'i gösterir, "Geri al" onu siler. `list_fields` okumadır, dosya yazmaz.
 */
export function pdfEditTool(options: { lang?: Locale; cwd: string; fontPath?: string }) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const e = d.pdfEdit;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  return defineTool({
    name: PDF_EDIT_TOOL,
    label: d.agent.tool.pdfEdit,
    description: p.pdfEditDesc,
    promptSnippet: p.pdfEditSnippet,
    promptGuidelines: [p.pdfEditGuideline],
    parameters: Type.Object({
      // Liste açık yazılır: `PDF_EDIT_ACTIONS.map` birleşimin tipini `never`'a düşürüyor.
      action: Type.Union(
        [
          Type.Literal("merge"),
          Type.Literal("split"),
          Type.Literal("rotate"),
          Type.Literal("delete_pages"),
          Type.Literal("extract_pages"),
          Type.Literal("watermark"),
          Type.Literal("fill_form"),
          Type.Literal("list_fields"),
        ],
        { description: p.pdfEditAction },
      ),
      path: Type.String({ minLength: 1, description: p.pdfEditPath }),
      inputs: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 49, description: p.pdfEditInputs }),
      ),
      output: Type.Optional(Type.String({ description: p.pdfEditOutput })),
      pages: Type.Optional(Type.String({ description: p.pdfEditPages })),
      ranges: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 100, description: p.pdfEditRanges }),
      ),
      angle: Type.Optional(Type.Number({ description: p.pdfEditAngle })),
      text: Type.Optional(Type.String({ description: p.pdfEditText })),
      opacity: Type.Optional(Type.Number({ description: p.pdfEditOpacity })),
      size: Type.Optional(Type.Number({ description: p.pdfEditSize })),
      color: Type.Optional(Type.String({ description: p.pdfEditColor })),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1 }),
            value: Type.Union([Type.String(), Type.Boolean()]),
          }),
          { maxItems: 200, description: p.pdfEditFields },
        ),
      ),
      flatten: Type.Optional(Type.Boolean({ description: p.pdfEditFlatten })),
    }),
    async execute(_id, params) {
      const targets = resolvePdfEditTargets(params, options.cwd);
      const input: PdfEditInput = { action: params.action, path: params.path };
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) Object.assign(input, { [key]: value });
      }
      const result = await (async () => {
        try {
          return await editPdf(input, targets, {
            lang,
            ...(options.fontPath ? { fontPath: options.fontPath } : {}),
          });
        } catch (error) {
          if (error instanceof PdfEditError) throw new Error(error.message);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(fill(e.failed, { reason }));
        }
      })();

      if (result.kind === "fields") {
        const text =
          result.fields.length === 0
            ? fill(e.noFields, { path: targets.source })
            : [
                fill(e.fieldsHeader, { path: targets.source, n: result.fields.length }),
                ...result.fields.map((f) => fieldLine(f, e.readOnly)),
              ].join("\n");
        const details: PdfEditDetails = {
          path: targets.source,
          action: params.action,
          fields: result.fields,
        };
        return { content: [{ type: "text" as const, text }], details };
      }

      for (const out of result.outputs) {
        mkdirSync(dirname(out.path), { recursive: true });
        writeFileSync(out.path, out.bytes);
      }
      const [first] = result.outputs;
      const path = first?.path ?? targets.source;
      const kb = Math.max(
        1,
        Math.round(result.outputs.reduce((sum, o) => sum + o.bytes.byteLength, 0) / 1024),
      );
      const vars = { path, n: result.count, pages: first?.pages ?? 0, kb };
      let text: string;
      switch (params.action) {
        case "merge":
          text = fill(e.merged, vars);
          break;
        case "split":
          text = [
            fill(e.split, { n: result.outputs.length, kb }),
            ...result.outputs.map((o) => `- ${o.path} (${fill(e.pageCount, { pages: o.pages })})`),
          ].join("\n");
          break;
        case "rotate":
          text = fill(e.rotated, { ...vars, angle: params.angle ?? 90 });
          break;
        case "delete_pages":
          text = fill(e.deleted, vars);
          break;
        case "extract_pages":
          text = fill(e.extracted, vars);
          break;
        case "watermark":
          text = fill(e.watermarked, vars);
          break;
        default:
          text = fill(params.flatten ? e.filledFlat : e.filled, vars);
      }
      const details: PdfEditDetails = {
        path,
        action: params.action,
        paths: result.outputs.map((o) => o.path),
        pages: first?.pages ?? 0,
        bytes: result.outputs.reduce((sum, o) => sum + o.bytes.byteLength, 0),
      };
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}

function fieldLine(f: PdfFieldInfo, readOnly: string): string {
  const value = Array.isArray(f.value)
    ? f.value.join("; ")
    : f.value === undefined
      ? ""
      : String(f.value);
  const parts = [`- ${f.name} [${f.type}]`];
  if (value !== "") parts.push(`= ${JSON.stringify(value)}`);
  if (f.options && f.options.length > 0) parts.push(`(${f.options.join(" | ")})`);
  if (f.readOnly) parts.push(`(${readOnly})`);
  return parts.join(" ");
}
