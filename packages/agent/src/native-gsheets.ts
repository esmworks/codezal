import type { Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@modelcontextprotocol/client";
import {
  clip,
  dict,
  dispatcher,
  GOOGLE_AUTH_SERVER,
  idFrom,
  json,
  jsonBody,
  jsonSchema,
  type NativeContext,
  type NativeService,
  READ_ONLY_TOOL,
  str,
  text,
} from "./native.js";
import { driveProbe, searchParams, typedSearch } from "./native-gdrive.js";

/**
 * Google E-Tablolar (Sheets API v4): arama (Drive), okuma (aralık ya da ilk sayfa), yazma,
 * satır ekleme ve yeni e-tablo. Değerler `USER_ENTERED` ile yazılır: formül ve sayı Sheets'te
 * elle girilmiş gibi yorumlanır.
 */
const MAX_ROWS = 200;
const DEFAULT_RANGE = "A1:Z200";

type Cell = string | number | boolean | null;
interface Spreadsheet {
  spreadsheetId: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{
    properties?: {
      title?: string;
      sheetId?: number;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
  }>;
}

function values(v: unknown): Cell[][] {
  if (!Array.isArray(v)) return [];
  return v.map((row) =>
    Array.isArray(row)
      ? row.map(
          (c): Cell =>
            typeof c === "string" || typeof c === "number" || typeof c === "boolean"
              ? c
              : c === null
                ? null
                : String(c),
        )
      : [String(row)],
  );
}

function table(rows: Cell[][]): string {
  return rows
    .slice(0, MAX_ROWS)
    .map((r, i) => `${i + 1}: ${r.map((c) => (c === null ? "" : String(c))).join(" | ")}`)
    .join("\n");
}

async function meta(ctx: NativeContext, id: string): Promise<Spreadsheet> {
  const fields = "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties";
  return json<Spreadsheet>(
    ctx,
    `${ctx.baseUrl}/spreadsheets/${encodeURIComponent(id)}?fields=${fields}`,
  );
}

/** Sayfa adları boşluk içerebilir; A1 gösteriminde tek tırnakla sarılır. */
function sheetRange(title: string, cells: string): string {
  return `'${title.replace(/'/g, "''")}'!${cells}`;
}

async function read(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.spreadsheetId);
  if (!id) throw new Error(d.errors.gdriveIdRequired);
  const ss = await meta(ctx, id);
  const sheets = (ss.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  const range = str(args.range) ?? sheetRange(sheets[0] ?? "Sheet1", DEFAULT_RANGE);
  const out = await json<{ range?: string; values?: Cell[][] }>(
    ctx,
    `${ctx.baseUrl}/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
  );
  const rows = out.values ?? [];
  const head = `# ${ss.properties?.title ?? ""} · id: ${ss.spreadsheetId}\n${d.prompt.gsheetsSheets} ${sheets.join(", ")}\n${d.prompt.gsheetsRange} ${out.range ?? range}`;
  const body = rows.length === 0 ? d.prompt.gsheetsEmpty : table(rows);
  const more =
    rows.length > MAX_ROWS
      ? `\n${d.prompt.gsheetsMore.replace("{{count}}", String(rows.length - MAX_ROWS))}`
      : "";
  return text(`${head}\n\n${clip(body, d)}${more}`, {
    spreadsheetId: id,
    sheets,
    range: out.range ?? range,
    rows: rows.length,
  });
}

async function write(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.spreadsheetId);
  const range = str(args.range);
  const rows = values(args.values);
  if (!id || !range || rows.length === 0) throw new Error(d.errors.gsheetsWriteArgs);
  const out = await json<{ updatedRange?: string; updatedCells?: number }>(
    ctx,
    `${ctx.baseUrl}/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    jsonBody("PUT", { range, majorDimension: "ROWS", values: rows }),
  );
  return text(
    `${d.prompt.gsheetsWritten} ${out.updatedRange ?? range} · ${out.updatedCells ?? 0} ${d.prompt.gsheetsCells}`,
    out,
  );
}

async function append(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.spreadsheetId);
  const rows = values(args.values);
  if (!id || rows.length === 0) throw new Error(d.errors.gsheetsWriteArgs);
  let range = str(args.range);
  if (!range) {
    const ss = await meta(ctx, id);
    range = sheetRange(ss.sheets?.[0]?.properties?.title ?? "Sheet1", "A1");
  }
  const params = new URLSearchParams({
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
  });
  const out = await json<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
    ctx,
    `${ctx.baseUrl}/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?${params}`,
    jsonBody("POST", { majorDimension: "ROWS", values: rows }),
  );
  return text(
    `${d.prompt.gsheetsAppended} ${out.updates?.updatedRange ?? range} · ${out.updates?.updatedRows ?? rows.length} ${d.prompt.gsheetsRows}`,
    out.updates ?? {},
  );
}

async function create(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const title = str(args.title);
  if (!title) throw new Error(d.errors.gdocsTitleRequired);
  const ss = await json<Spreadsheet>(
    ctx,
    `${ctx.baseUrl}/spreadsheets`,
    jsonBody("POST", { properties: { title } }),
  );
  const rows = values(args.values);
  if (rows.length > 0) {
    const first = ss.sheets?.[0]?.properties?.title ?? "Sheet1";
    await json(
      ctx,
      `${ctx.baseUrl}/spreadsheets/${encodeURIComponent(ss.spreadsheetId)}/values/${encodeURIComponent(sheetRange(first, "A1"))}?valueInputOption=USER_ENTERED`,
      jsonBody("PUT", { majorDimension: "ROWS", values: rows }),
    );
  }
  const link =
    ss.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${ss.spreadsheetId}/edit`;
  return text(`${d.prompt.gsheetsCreated} ${title} · id: ${ss.spreadsheetId} · ${link}`, {
    spreadsheetId: ss.spreadsheetId,
    link,
  });
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  const spreadsheetId = Type.String({ minLength: 1, description: p.gsheetsId });
  const cell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  const valuesSchema = Type.Array(Type.Array(cell), { description: p.gsheetsValues });
  return [
    {
      name: "search_spreadsheets",
      ...READ_ONLY_TOOL,
      description: p.gsheetsSearch,
      inputSchema: searchParams(lang, false),
    },
    {
      name: "read_sheet",
      ...READ_ONLY_TOOL,
      description: p.gsheetsRead,
      inputSchema: jsonSchema(
        Type.Object({
          spreadsheetId,
          range: Type.Optional(Type.String({ description: p.gsheetsRangeArg })),
        }),
      ),
    },
    {
      name: "write_cells",
      description: p.gsheetsWrite,
      inputSchema: jsonSchema(
        Type.Object({
          spreadsheetId,
          range: Type.String({ minLength: 1, description: p.gsheetsRangeArg }),
          values: valuesSchema,
        }),
      ),
    },
    {
      name: "append_rows",
      description: p.gsheetsAppend,
      inputSchema: jsonSchema(
        Type.Object({
          spreadsheetId,
          range: Type.Optional(Type.String({ description: p.gsheetsRangeArg })),
          values: valuesSchema,
        }),
      ),
    },
    {
      name: "create_spreadsheet",
      description: p.gsheetsCreate,
      inputSchema: jsonSchema(
        Type.Object({
          title: Type.String({ minLength: 1, description: p.gdocsTitle }),
          values: Type.Optional(valuesSchema),
        }),
      ),
    },
  ];
}

export const GSHEETS_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  probe: (ctx) => driveProbe(ctx, ctx.driveUrl),
  call: dispatcher({
    search_spreadsheets: typedSearch("spreadsheet"),
    read_sheet: read,
    write_cells: write,
    append_rows: append,
    create_spreadsheet: create,
  }),
};
