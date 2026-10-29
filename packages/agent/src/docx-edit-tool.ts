import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { convertDocx } from "./docx.js";
import {
  type DocxEdit,
  type DocxEditAction,
  DocxEditError,
  editDocx,
  resolveDocxEditTarget,
} from "./docx-edit.js";

export const DOCX_EDIT_TOOL = "docx_edit";

const ACTIONS: readonly DocxEditAction[] = [
  "replace",
  "insert_after",
  "insert_before",
  "delete",
  "comment",
  "row_insert_after",
  "row_insert_before",
  "row_delete",
  "col_insert_after",
  "col_insert_before",
  "col_delete",
  "cell_merge",
  "cell_split",
  "table_insert_after",
  "table_insert_before",
  "table_delete",
  "accept_all",
  "reject_all",
];

/**
 * Var olan Word belgesini düzenleme aracı. Model belgeyi önce `read` ile okur (izli değişiklik ve
 * yorumlar CriticMarkup ile görünür), sonra metne göre düzenlemeleri verir. Sonuç, okuma
 * görünümünün önce/sonra farkını `details.diff` olarak taşır: kart "İncele" ve +/- sayacını
 * `edit` aracıyla aynı biçimde gösterir.
 */
export function docxEditTool(options: { lang?: Locale; cwd: string }) {
  const lang = options.lang ?? "tr";
  const d = dict(lang);
  const p = d.prompt;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);
  return defineTool({
    name: DOCX_EDIT_TOOL,
    label: d.agent.tool.docxEdit,
    description: p.docxEditDesc,
    promptSnippet: p.docxEditSnippet,
    promptGuidelines: [p.docxEditGuideline],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: p.docxEditPath }),
      output: Type.Optional(Type.String({ description: p.docxEditOutput })),
      track: Type.Optional(Type.Boolean({ description: p.docxEditTrack })),
      author: Type.Optional(Type.String({ description: p.docxEditAuthor })),
      edits: Type.Array(
        Type.Object({
          action: Type.Union(
            ACTIONS.map((a) => Type.Literal(a)),
            { description: p.docxEditAction },
          ),
          find: Type.Optional(Type.String({ description: p.docxEditFind })),
          text: Type.Optional(Type.String({ description: p.docxEditText })),
          all: Type.Optional(Type.Boolean({ description: p.docxEditAll })),
          to: Type.Optional(Type.String({ description: p.docxEditTo })),
        }),
        { minItems: 1, maxItems: 50, description: p.docxEditEdits },
      ),
    }),
    async execute(_id, params) {
      const { source, target } = resolveDocxEditTarget(params.path, params.output, options.cwd);
      if (!/\.(docx|docm)$/i.test(source)) {
        throw new Error(fill(d.docxEdit.notDocx, { path: source }));
      }
      if (!existsSync(source)) throw new Error(fill(d.docxEdit.missing, { path: source }));
      const original = readFileSync(source);
      const author = params.author?.trim() || d.docxEdit.defaultAuthor;
      const edits: DocxEdit[] = params.edits.map((e) => ({
        action: e.action,
        ...(e.find !== undefined ? { find: e.find } : {}),
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.all !== undefined ? { all: e.all } : {}),
        ...(e.to !== undefined ? { to: e.to } : {}),
      }));
      const result = (() => {
        try {
          return editDocx(original, edits, {
            track: params.track ?? false,
            author,
            // Word saniye hassasiyeti bekler; milisaniyeli tarih bazı sürümlerde gösterilmiyor.
            date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            lang,
          });
        } catch (error) {
          if (error instanceof DocxEditError) throw new Error(error.message);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(fill(d.docxEdit.broken, { reason }));
        }
      })();
      // Yazmadan önce kendi okuyucumuzla açılır: bozuk paket kullanıcının dosyasının yerine geçmesin.
      let before = "";
      let after = "";
      try {
        before = convertDocx(original, lang).markdown;
        after = convertDocx(result.bytes, lang).markdown;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fill(d.docxEdit.broken, { reason }));
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, result.bytes);

      const summary = ACTIONS.filter((a) => result.counts[a] !== undefined)
        .map((a) => fill(d.docxEdit.counts[a], { n: result.counts[a] ?? 0 }))
        .join(", ");
      let text = fill(d.docxEdit.done, { path: target, summary });
      if (params.track) text += ` · ${fill(d.docxEdit.tracked, { author })}`;
      const { diff } = generateDiffString(before, after);
      return {
        content: [{ type: "text" as const, text }],
        details: { path: target, diff, counts: result.counts },
      };
    },
  });
}
