import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveCreatePath } from "./pdf-create.js";
import { buildXlsx, formulaWarnings, type SheetSpec } from "./xlsx-build.js";

export const XLSX_TOOL = "xlsx_create";

export function resolveXlsxPath(raw: string, cwd: string, outputsDir?: string): string {
  return resolveCreatePath(raw, cwd, outputsDir, ".xlsx");
}

/**
 * Excel üretim aracı: model sayfaları satır dizisi olarak verir, araç .xlsx'e çevirip hedef yola
 * yazar. `docx_create`'in eşidir; betikle openpyxl/pandas aramaya gerek kalmaz. Sonuç, formül
 * hatalarını ve modelin `read` ile geri okuyup denetlemesi gerektiğini söyler.
 */
export function xlsxCreateTool(options: { lang?: Locale; cwd: string; outputsDir?: string }) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  return defineTool({
    name: XLSX_TOOL,
    label: d.agent.tool.xlsx,
    description: p.xlsxCreateDesc,
    promptSnippet: p.xlsxCreateSnippet,
    promptGuidelines: [p.xlsxCreateGuideline],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: p.xlsxCreatePath }),
      sheets: Type.Array(
        Type.Object({
          name: Type.String({ description: p.xlsxCreateSheetName }),
          rows: Type.Array(Type.Array(cell), { description: p.xlsxCreateRows }),
          header: Type.Optional(Type.Boolean({ description: p.xlsxCreateHeader })),
          columns: Type.Optional(
            Type.Array(
              Type.Object({
                width: Type.Optional(Type.Number({ description: p.xlsxCreateWidth })),
                format: Type.Optional(Type.String({ description: p.xlsxCreateFormat })),
              }),
              { description: p.xlsxCreateColumns },
            ),
          ),
          merge: Type.Optional(Type.Array(Type.String(), { description: p.xlsxCreateMerge })),
          freeze: Type.Optional(Type.String({ description: p.xlsxCreateFreeze })),
          filter: Type.Optional(Type.Boolean({ description: p.xlsxCreateFilter })),
        }),
        { minItems: 1, description: p.xlsxCreateSheets },
      ),
      title: Type.Optional(Type.String({ description: p.xlsxCreateTitle })),
    }),
    async execute(_id, params) {
      const path = resolveXlsxPath(params.path, options.cwd, options.outputsDir);
      const specs: SheetSpec[] = params.sheets.map((s) => ({
        name: s.name,
        rows: s.rows,
        ...(s.header !== undefined ? { header: s.header } : {}),
        ...(s.columns ? { columns: s.columns } : {}),
        ...(s.merge ? { merge: s.merge } : {}),
        ...(s.freeze ? { freeze: s.freeze } : {}),
        ...(s.filter !== undefined ? { filter: s.filter } : {}),
      }));
      let result: ReturnType<typeof buildXlsx>;
      try {
        result = buildXlsx(specs, { lang, ...(params.title ? { title: params.title } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fill(d.errors.xlsxBuildFailed, { reason }));
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, result.bytes);
      const kb = Math.max(1, Math.round(result.bytes.byteLength / 1024));
      let text = fill(p.xlsxCreated, {
        path,
        kb,
        sheets: result.sheets.length,
        names: result.sheets.join(", "),
        rows: result.rows,
        formulas: result.formulas,
      });
      if (result.recalc.pending > 0) {
        text += `\n${fill(p.xlsxCreatedPending, { n: result.recalc.pending })}`;
      }
      const warnings = [...formulaWarnings(result.recalc, lang), ...result.warnings];
      if (warnings.length > 0) {
        text += `\n${p.xlsxCreatedWarnings}\n${warnings.map((w) => `- ${w}`).join("\n")}`;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { path, bytes: result.bytes.byteLength, warnings },
      };
    },
  });
}
