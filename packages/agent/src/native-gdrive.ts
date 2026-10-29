import type { Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";
import {
  type Dict,
  dict,
  dispatcher,
  fail,
  GOOGLE_AUTH_SERVER,
  idFrom,
  json,
  jsonSchema,
  limitOf,
  MAX_LIMIT,
  MAX_READ_CHARS,
  type NativeContext,
  type NativeService,
  READ_ONLY_TOOL,
  str,
  text,
} from "./native.js";

/**
 * Google Drive: arama, son dosyalar, okuma (Google türleri dışa aktarılır) ve yükleme. Dosya
 * arama yardımcıları Dokümanlar/E-Tablolar/Slaytlar servislerince de kullanılır.
 */
const GOOGLE_APPS = "application/vnd.google-apps.";
/** Google'a özgü türler indirilemez; dışa aktarma biçimi türüne göre seçilir. */
const EXPORTS: Record<string, string> = {
  document: "text/markdown",
  spreadsheet: "text/csv",
  presentation: "text/plain",
};
export const DRIVE_TYPES = {
  folder: `${GOOGLE_APPS}folder`,
  document: `${GOOGLE_APPS}document`,
  spreadsheet: `${GOOGLE_APPS}spreadsheet`,
  presentation: `${GOOGLE_APPS}presentation`,
  pdf: "application/pdf",
} as const;
type FileType = keyof typeof DRIVE_TYPES;
const TEXT_MIME = /^text\/|\b(json|xml|javascript|csv|markdown|yaml|x-sh)\b/;
const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";
const LIST_FIELDS = `files(${FIELDS})`;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

/** Drive sorgu dizgesi: tek tırnak ve ters bölü kaçırılır. */
export function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function typeLabel(mime: string): string {
  return mime.startsWith(GOOGLE_APPS) ? `google:${mime.slice(GOOGLE_APPS.length)}` : mime;
}

export function fileLine(f: DriveFile): string {
  const parts = [`${f.name} (${typeLabel(f.mimeType)})`, `id: ${f.id}`];
  if (f.modifiedTime) parts.push(f.modifiedTime.slice(0, 10));
  if (f.size) parts.push(`${f.size} B`);
  if (f.webViewLink) parts.push(f.webViewLink);
  return `- ${parts.join(" · ")}`;
}

/** `files.list`: değiştirilme tarihine göre, paylaşılan sürücüler dahil. */
export async function driveList(
  ctx: NativeContext,
  q: string,
  limit: number,
  base = ctx.baseUrl,
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q,
    pageSize: String(limit),
    orderBy: "modifiedTime desc",
    fields: LIST_FIELDS,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const out = await json<{ files?: DriveFile[] }>(ctx, `${base}/files?${params}`);
  return out.files ?? [];
}

/** Ad + içerik araması; türe ve klasöre daraltılabilir, çöp hariç. */
export function searchQuery(query: string, type?: FileType, folder?: string): string {
  const clauses = [`(name contains ${quote(query)} or fullText contains ${quote(query)})`];
  if (type) clauses.push(`mimeType = ${quote(DRIVE_TYPES[type])}`);
  if (folder) clauses.push(`${quote(folder)} in parents`);
  clauses.push("trashed = false");
  return clauses.join(" and ");
}

export function listResult(files: DriveFile[], d: Dict): AgentToolResult<unknown> {
  if (files.length === 0) return text(d.prompt.gdriveNone, { files });
  return text(files.map(fileLine).join("\n"), { files });
}

/** Belirli Google türünde dosya arama (Dokümanlar, E-Tablolar, Slaytlar servisleri için). */
export function typedSearch(
  type: FileType,
): (ctx: NativeContext, args: Record<string, unknown>) => Promise<AgentToolResult<unknown>> {
  return async (ctx, args) => {
    const d = dict(ctx.lang);
    const query = str(args.query);
    if (!query) throw new Error(d.errors.gdriveQueryRequired);
    const q = searchQuery(query, type, str(args.folderId));
    return listResult(await driveList(ctx, q, limitOf(args.limit), ctx.driveUrl), d);
  };
}

/**
 * Drive `about.user`: Drive API kapalıysa ya da belirteç düştüyse bağlanırken anlaşılır; yanıttaki
 * e-posta bağlı hesap olarak gösterilir.
 */
export async function driveProbe(ctx: NativeContext, base = ctx.baseUrl): Promise<string | null> {
  const about = await json<{ user?: { emailAddress?: string; displayName?: string } }>(
    ctx,
    `${base}/about?fields=user`,
  );
  return about.user?.emailAddress ?? about.user?.displayName ?? null;
}

function typeOf(v: unknown): FileType | undefined {
  const s = str(v);
  // `in` prototip zincirine bakar: "constructor" gibi bir değer türe dönüşüp sorguyu çökertirdi.
  return s && Object.hasOwn(DRIVE_TYPES, s) ? (s as FileType) : undefined;
}

async function search(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const query = str(args.query);
  if (!query) throw new Error(d.errors.gdriveQueryRequired);
  const q = searchQuery(query, typeOf(args.type), str(args.folderId));
  return listResult(await driveList(ctx, q, limitOf(args.limit)), d);
}

async function recent(ctx: NativeContext, args: Record<string, unknown>) {
  const clauses = ["trashed = false"];
  const folder = str(args.folderId);
  if (folder) clauses.push(`${quote(folder)} in parents`);
  return listResult(
    await driveList(ctx, clauses.join(" and "), limitOf(args.limit)),
    dict(ctx.lang),
  );
}

async function read(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = idFrom(args.fileId);
  if (!id) throw new Error(d.errors.gdriveIdRequired);
  const enc = encodeURIComponent(id);
  const meta = await json<DriveFile>(
    ctx,
    `${ctx.baseUrl}/files/${enc}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" })}`,
  );
  const head = fileLine(meta);
  let url: string | null = null;
  if (meta.mimeType.startsWith(GOOGLE_APPS)) {
    const format = EXPORTS[meta.mimeType.slice(GOOGLE_APPS.length)];
    if (format)
      url = `${ctx.baseUrl}/files/${enc}/export?${new URLSearchParams({ mimeType: format })}`;
  } else if (TEXT_MIME.test(meta.mimeType)) {
    url = `${ctx.baseUrl}/files/${enc}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
  }
  if (!url)
    return text(
      `${head}\n${d.prompt.gdriveBinary.replace("{{link}}", meta.webViewLink ?? "")}`.trim(),
      { file: meta, content: null },
    );
  const res = await ctx.request(url, { signal: ctx.signal ?? null });
  if (!res.ok) await fail(res, d);
  const full = await res.text();
  const truncated = full.length > MAX_READ_CHARS;
  const content = truncated ? full.slice(0, MAX_READ_CHARS) : full;
  const tail = truncated
    ? `\n\n${d.prompt.gdriveTruncated.replace("{{chars}}", String(MAX_READ_CHARS))}`
    : "";
  return text(`${head}\n\n${content}${tail}`, { file: meta, truncated });
}

/** Çok parçalı yükleme (`uploadType=multipart`): meta veri JSON + içerik tek gövdede. */
async function upload(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const name = str(args.name);
  const content = typeof args.content === "string" ? args.content : undefined;
  if (!name || content === undefined) throw new Error(d.errors.gdriveUploadArgs);
  const contentType = str(args.mimeType) ?? "text/plain";
  const folder = str(args.folderId);
  const meta: Record<string, unknown> = {
    name,
    ...(folder ? { parents: [folder] } : {}),
    // Google Dokümanı'na dönüştürme: hedef tür meta veride, kaynak tür içerik parçasında.
    ...(args.asGoogleDoc === true ? { mimeType: DRIVE_TYPES.document } : {}),
  };
  const boundary = `codezal-${Date.now().toString(36)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(meta),
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const base = ctx.baseUrl.replace(/\/drive\/v3\/?$/, "/upload/drive/v3");
  const params = new URLSearchParams({
    uploadType: "multipart",
    fields: FIELDS,
    supportsAllDrives: "true",
  });
  const file = await json<DriveFile>(ctx, `${base}/files?${params}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return text(`${d.prompt.gdriveUploaded}\n${fileLine(file)}`, { file });
}

/** Ortak arama parametreleri (Dokümanlar/E-Tablolar/Slaytlar aramaları da bunu kullanır). */
export function searchParams(lang: Locale, withType: boolean): Tool["inputSchema"] {
  const p = dict(lang).prompt;
  return jsonSchema(
    Type.Object({
      query: Type.String({ minLength: 1, description: p.gdriveQuery }),
      ...(withType
        ? {
            type: Type.Optional(
              Type.Union(
                (Object.keys(DRIVE_TYPES) as FileType[]).map((k) => Type.Literal(k)),
                { description: p.gdriveType },
              ),
            ),
          }
        : {}),
      folderId: Type.Optional(Type.String({ description: p.gdriveFolder })),
      limit: limitSchema(lang),
    }),
  );
}

export function limitSchema(lang: Locale) {
  return Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: dict(lang).prompt.gdriveLimit }),
  );
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  return [
    {
      name: "search_files",
      ...READ_ONLY_TOOL,
      description: p.gdriveSearch,
      inputSchema: searchParams(lang, true),
    },
    {
      name: "list_recent_files",
      ...READ_ONLY_TOOL,
      description: p.gdriveRecent,
      inputSchema: jsonSchema(
        Type.Object({
          folderId: Type.Optional(Type.String({ description: p.gdriveFolder })),
          limit: limitSchema(lang),
        }),
      ),
    },
    {
      name: "read_file",
      ...READ_ONLY_TOOL,
      description: p.gdriveRead,
      inputSchema: jsonSchema(
        Type.Object({ fileId: Type.String({ minLength: 1, description: p.gdriveFileId }) }),
      ),
    },
    {
      name: "upload_file",
      description: p.gdriveUpload,
      inputSchema: jsonSchema(
        Type.Object({
          name: Type.String({ minLength: 1, description: p.gdriveName }),
          content: Type.String({ description: p.gdriveContent }),
          folderId: Type.Optional(Type.String({ description: p.gdriveFolder })),
          mimeType: Type.Optional(Type.String({ description: p.gdriveMime })),
          asGoogleDoc: Type.Optional(Type.Boolean({ description: p.gdriveAsDoc })),
        }),
      ),
    },
  ];
}

export const GDRIVE_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  probe: (ctx) => driveProbe(ctx),
  call: dispatcher({
    search_files: search,
    list_recent_files: recent,
    read_file: read,
    upload_file: upload,
  }),
};
