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
 * Google Dokümanlar (Docs API v1): arama (Drive), okuma (belge yapısı Markdown benzeri metne
 * indirgenir), yeni belge ve sona ekleme.
 */
interface TextRun {
  content?: string;
}
interface Paragraph {
  elements?: Array<{ textRun?: TextRun }>;
  paragraphStyle?: { namedStyleType?: string };
  bullet?: unknown;
}
interface Element {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: Element[] }> }> };
}
interface Document {
  documentId: string;
  title?: string;
  body?: { content?: Element[] };
}

const HEADING = /^HEADING_(\d)$/;

function paragraphText(p: Paragraph): string {
  const raw = (p.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
  const line = raw.replace(/\n$/, "");
  const h = HEADING.exec(p.paragraphStyle?.namedStyleType ?? "");
  if (h) return `${"#".repeat(Number(h[1]))} ${line}`;
  if (p.paragraphStyle?.namedStyleType === "TITLE") return `# ${line}`;
  if (p.bullet) return `- ${line}`;
  return line;
}

/** Belge gövdesi satır satır; tablolar hücreleri ` | ` ile birleştirilmiş satırlar olur. */
export function docText(content: Element[] | undefined): string {
  const out: string[] = [];
  for (const el of content ?? []) {
    if (el.paragraph) out.push(paragraphText(el.paragraph));
    else if (el.table)
      for (const row of el.table.tableRows ?? [])
        out.push(
          (row.tableCells ?? [])
            .map((cell) => docText(cell.content).replace(/\n+/g, " ").trim())
            .join(" | "),
        );
  }
  return out.join("\n");
}

function endIndex(doc: Document): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  // Belgenin son satır sonu karakterinin önüne eklenir; boş belgede gövde 1'den başlar.
  return Math.max(1, (last?.endIndex ?? 2) - 1);
}

async function read(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.documentId);
  if (!id) throw new Error(d.errors.gdriveIdRequired);
  const doc = await json<Document>(ctx, `${ctx.baseUrl}/documents/${encodeURIComponent(id)}`);
  const body = docText(doc.body?.content);
  return text(`# ${doc.title ?? ""} · id: ${doc.documentId}\n\n${clip(body, d)}`, {
    documentId: doc.documentId,
    title: doc.title ?? "",
  });
}

async function create(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const title = str(args.title);
  if (!title) throw new Error(d.errors.gdocsTitleRequired);
  const doc = await json<Document>(ctx, `${ctx.baseUrl}/documents`, jsonBody("POST", { title }));
  const content = typeof args.content === "string" ? args.content : "";
  if (content) await insert(ctx, doc.documentId, 1, content);
  const link = `https://docs.google.com/document/d/${doc.documentId}/edit`;
  return text(`${d.prompt.gdocsCreated} ${title} · id: ${doc.documentId} · ${link}`, {
    documentId: doc.documentId,
    link,
  });
}

async function insert(ctx: NativeContext, id: string, index: number, content: string) {
  await json(
    ctx,
    `${ctx.baseUrl}/documents/${encodeURIComponent(id)}:batchUpdate`,
    jsonBody("POST", { requests: [{ insertText: { location: { index }, text: content } }] }),
  );
}

async function append(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.documentId);
  const content = typeof args.content === "string" ? args.content : "";
  if (!id || !content) throw new Error(d.errors.gdocsAppendArgs);
  const doc = await json<Document>(
    ctx,
    `${ctx.baseUrl}/documents/${encodeURIComponent(id)}?fields=documentId,body.content.endIndex`,
  );
  // Var olan metne yeni satırla bitişir; ilk ekleme boş belgeye satır sonu koymaz.
  const at = endIndex(doc);
  await insert(ctx, id, at, at > 1 ? `\n${content}` : content);
  return text(`${d.prompt.gdocsAppended} id: ${id}`, { documentId: id, chars: content.length });
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  const documentId = Type.String({ minLength: 1, description: p.gdocsId });
  return [
    {
      name: "search_documents",
      ...READ_ONLY_TOOL,
      description: p.gdocsSearch,
      inputSchema: searchParams(lang, false),
    },
    {
      name: "read_document",
      ...READ_ONLY_TOOL,
      description: p.gdocsRead,
      inputSchema: jsonSchema(Type.Object({ documentId })),
    },
    {
      name: "create_document",
      description: p.gdocsCreate,
      inputSchema: jsonSchema(
        Type.Object({
          title: Type.String({ minLength: 1, description: p.gdocsTitle }),
          content: Type.Optional(Type.String({ description: p.gdocsContent })),
        }),
      ),
    },
    {
      name: "append_text",
      description: p.gdocsAppend,
      inputSchema: jsonSchema(
        Type.Object({
          documentId,
          content: Type.String({ minLength: 1, description: p.gdocsContent }),
        }),
      ),
    },
  ];
}

export const GDOCS_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  // Docs API'nin ucuz bir "ben kimim" ucu yok; kapsamda olan Drive `about` kullanılır.
  probe: (ctx) => driveProbe(ctx, ctx.driveUrl),
  call: dispatcher({
    search_documents: typedSearch("document"),
    read_document: read,
    create_document: create,
    append_text: append,
  }),
};
