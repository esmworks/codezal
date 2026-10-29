import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { convertXlsx } from "./xlsx.js";
import { formulaWarnings } from "./xlsx-build.js";
import {
  editXlsx,
  resolveXlsxEditTarget,
  XLSX_EDIT_ACTIONS,
  type XlsxEdit,
  XlsxEditError,
} from "./xlsx-edit.js";

export const XLSX_EDIT_TOOL = "xlsx_edit";

/**
 * Var olan Excel kitabını düzenleme aracı. Model kitabı önce `read` ile okur (sütun harfi + satır
 * numarası), sonra hücre adresleriyle düzenlemeleri verir. Sonuç okuma görünümünün önce/sonra
 * farkını `details.diff` olarak taşır (`docx_edit` ile aynı kart).
 */
export function xlsxEditTool(options: { lang?: Locale; cwd: string }) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  const cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  return defineTool({
    name: XLSX_EDIT_TOOL,
    label: d.agent.tool.xlsxEdit,
    description: p.xlsxEditDesc,
    promptSnippet: p.xlsxEditSnippet,
    promptGuidelines: [p.xlsxEditGuideline],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: p.xlsxEditPath }),
      output: Type.Optional(Type.String({ description: p.xlsxEditOutput })),
      edits: Type.Array(
        Type.Object({
          action: Type.Union(
            XLSX_EDIT_ACTIONS.map((a) => Type.Literal(a)),
            { description: p.xlsxEditAction },
          ),
          sheet: Type.Optional(Type.String({ description: p.xlsxEditSheet })),
          range: Type.Optional(Type.String({ description: p.xlsxEditRange })),
          value: Type.Optional(cell),
          values: Type.Optional(Type.Array(Type.Array(cell), { description: p.xlsxEditValues })),
          count: Type.Optional(Type.Number({ description: p.xlsxEditCount })),
          name: Type.Optional(Type.String({ description: p.xlsxEditName })),
          numberFormat: Type.Optional(Type.String({ description: p.xlsxCreateFormat })),
          bold: Type.Optional(Type.Boolean()),
          italic: Type.Optional(Type.Boolean()),
          color: Type.Optional(Type.String({ description: p.xlsxEditColor })),
          fill: Type.Optional(Type.String({ description: p.xlsxEditFill })),
          align: Type.Optional(
            Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")]),
          ),
          valign: Type.Optional(
            Type.Union([Type.Literal("top"), Type.Literal("center"), Type.Literal("bottom")]),
          ),
          wrap: Type.Optional(Type.Boolean()),
          border: Type.Optional(
            Type.Union([Type.Literal("all"), Type.Literal("bottom"), Type.Literal("none")]),
          ),
          width: Type.Optional(Type.Number({ description: p.xlsxEditWidth })),
        }),
        { minItems: 1, maxItems: 100, description: p.xlsxEditEdits },
      ),
    }),
    async execute(_id, params) {
      const { source, target } = resolveXlsxEditTarget(params.path, params.output, options.cwd);
      if (!/\.(xlsx|xlsm)$/i.test(source)) {
        throw new Error(fill(d.xlsxEdit.notXlsx, { path: source }));
      }
      if (!existsSync(source)) throw new Error(fill(d.xlsxEdit.missing, { path: source }));
      const original = readFileSync(source);
      const edits: XlsxEdit[] = params.edits.map((e) => {
        const out: XlsxEdit = { action: e.action };
        for (const [key, value] of Object.entries(e)) {
          if (value !== undefined) Object.assign(out, { [key]: value });
        }
        return out;
      });
      const result = (() => {
        try {
          return editXlsx(original, edits, { lang });
        } catch (error) {
          if (error instanceof XlsxEditError) throw new Error(error.message);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(fill(d.xlsxEdit.broken, { reason }));
        }
      })();
      // Yazmadan önce kendi okuyucumuzla açılır: bozuk paket kullanıcının dosyasının yerine geçmesin.
      let before = "";
      let after = "";
      try {
        before = convertXlsx(original, lang).markdown;
        after = convertXlsx(result.bytes, lang).markdown;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fill(d.xlsxEdit.broken, { reason }));
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, result.bytes);

      const summary = XLSX_EDIT_ACTIONS.filter((a) => result.counts[a] !== undefined)
        .map((a) => fill(d.xlsxEdit.counts[a], { n: result.counts[a] ?? 0 }))
        .join(", ");
      let text = fill(d.xlsxEdit.done, { path: target, summary });
      if (result.recalc.pending > 0) {
        text += `\n${fill(p.xlsxCreatedPending, { n: result.recalc.pending })}`;
      }
      const warnings = formulaWarnings(result.recalc, lang);
      if (warnings.length > 0) text += `\n${warnings.map((w) => `- ${w}`).join("\n")}`;
      const { diff } = generateDiffString(before, after);
      return {
        content: [{ type: "text" as const, text }],
        details: { path: target, diff, counts: result.counts },
      };
    },
  });
}
