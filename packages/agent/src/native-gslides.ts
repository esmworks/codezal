import { randomBytes } from "node:crypto";
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
 * Google Slaytlar (Slides API v1): arama (Drive), okuma (slayt başına metin), yeni sunu ve
 * "başlık + gövde" düzeninde slayt ekleme.
 */
interface TextElement {
  textRun?: { content?: string };
}
interface PageElement {
  shape?: { text?: { textElements?: TextElement[] } };
  table?: {
    tableRows?: Array<{ tableCells?: Array<{ text?: { textElements?: TextElement[] } }> }>;
  };
}
interface Slide {
  objectId: string;
  pageElements?: PageElement[];
}
interface Presentation {
  presentationId: string;
  title?: string;
  slides?: Slide[];
}

function runsText(els: TextElement[] | undefined): string {
  return (els ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .trim();
}

/** Slayt metni: şekiller satır satır, tablo hücreleri ` | ` ile. */
export function slideText(slide: Slide): string {
  const out: string[] = [];
  for (const el of slide.pageElements ?? []) {
    if (el.shape) {
      const t = runsText(el.shape.text?.textElements);
      if (t) out.push(t);
    } else if (el.table)
      for (const row of el.table.tableRows ?? [])
        out.push((row.tableCells ?? []).map((c) => runsText(c.text?.textElements)).join(" | "));
  }
  return out.join("\n");
}

async function read(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.presentationId);
  if (!id) throw new Error(d.errors.gdriveIdRequired);
  const fields =
    "presentationId,title,slides(objectId,pageElements(shape.text.textElements.textRun.content,table.tableRows.tableCells.text.textElements.textRun.content))";
  const p = await json<Presentation>(
    ctx,
    `${ctx.baseUrl}/presentations/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`,
  );
  const slides = p.slides ?? [];
  const body = slides
    .map((s, i) => `## ${d.prompt.gslidesSlide} ${i + 1} (id: ${s.objectId})\n${slideText(s)}`)
    .join("\n\n");
  return text(
    `# ${p.title ?? ""} · id: ${p.presentationId} · ${slides.length} ${d.prompt.gslidesSlides}\n\n${clip(body, d)}`,
    { presentationId: p.presentationId, title: p.title ?? "", slides: slides.length },
  );
}

async function create(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const title = str(args.title);
  if (!title) throw new Error(d.errors.gdocsTitleRequired);
  const p = await json<Presentation>(
    ctx,
    `${ctx.baseUrl}/presentations`,
    jsonBody("POST", { title }),
  );
  const link = `https://docs.google.com/presentation/d/${p.presentationId}/edit`;
  return text(`${d.prompt.gslidesCreated} ${title} · id: ${p.presentationId} · ${link}`, {
    presentationId: p.presentationId,
    link,
  });
}

/** Nesne kimliği: 5-50 karakter, harf/rakam/alt çizgi; sunu içinde benzersiz. */
function objectId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

async function addSlide(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.presentationId);
  const title = str(args.title);
  if (!id || !title) throw new Error(d.errors.gslidesAddArgs);
  const body = typeof args.body === "string" ? args.body : "";
  const slideId = objectId("slide");
  const titleId = objectId("title");
  const bodyId = objectId("body");
  const requests: unknown[] = [
    {
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId },
        ],
      },
    },
    { insertText: { objectId: titleId, insertionIndex: 0, text: title } },
  ];
  if (body) requests.push({ insertText: { objectId: bodyId, insertionIndex: 0, text: body } });
  await json(
    ctx,
    `${ctx.baseUrl}/presentations/${encodeURIComponent(id)}:batchUpdate`,
    jsonBody("POST", { requests }),
  );
  return text(`${d.prompt.gslidesAdded} ${title} · slide id: ${slideId}`, {
    presentationId: id,
    slideId,
  });
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  const presentationId = Type.String({ minLength: 1, description: p.gslidesId });
  return [
    {
      name: "search_presentations",
      ...READ_ONLY_TOOL,
      description: p.gslidesSearch,
      inputSchema: searchParams(lang, false),
    },
    {
      name: "read_presentation",
      ...READ_ONLY_TOOL,
      description: p.gslidesRead,
      inputSchema: jsonSchema(Type.Object({ presentationId })),
    },
    {
      name: "create_presentation",
      description: p.gslidesCreate,
      inputSchema: jsonSchema(
        Type.Object({ title: Type.String({ minLength: 1, description: p.gdocsTitle }) }),
      ),
    },
    {
      name: "add_slide",
      description: p.gslidesAdd,
      inputSchema: jsonSchema(
        Type.Object({
          presentationId,
          title: Type.String({ minLength: 1, description: p.gslidesTitle }),
          body: Type.Optional(Type.String({ description: p.gslidesBody })),
        }),
      ),
    },
  ];
}

export const GSLIDES_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  probe: (ctx) => driveProbe(ctx, ctx.driveUrl),
  call: dispatcher({
    search_presentations: typedSearch("presentation"),
    read_presentation: read,
    create_presentation: create,
    add_slide: addSlide,
  }),
};
