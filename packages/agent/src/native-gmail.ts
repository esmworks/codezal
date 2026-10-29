import type { Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@modelcontextprotocol/client";
import {
  clip,
  type Dict,
  dict,
  dispatcher,
  GOOGLE_AUTH_SERVER,
  json,
  jsonBody,
  jsonSchema,
  limitOf,
  MAX_LIMIT,
  type NativeContext,
  type NativeService,
  READ_ONLY_TOOL,
  str,
  text,
} from "./native.js";
import { htmlToText } from "./web-fetch.js";

/**
 * Gmail (Gmail API v1, `users/me`): ileti arama (Gmail arama sözdizimi), ileti okuma ve taslak
 * yazma. Gönderme bilinçli olarak yok: kullanıcı taslağı Gmail'de görüp kendi gönderir.
 */
const META_HEADERS = ["From", "To", "Subject", "Date"];
const SEARCH_DEFAULT = 10;

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: Part & { headers?: Header[] };
}

function header(m: Message, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function fromBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Gövde: önce text/plain parçası, yoksa text/html metne indirgenir; ekler yalnızca ad olarak. */
function bodyOf(part: Part | undefined): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  let plain = "";
  let html = "";
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename) attachments.push(p.filename);
    const data = p.body?.data;
    if (data && !p.filename) {
      if (p.mimeType === "text/plain" && !plain) plain = fromBase64Url(data);
      else if (p.mimeType === "text/html" && !html) html = fromBase64Url(data);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return { text: plain || (html ? htmlToText(html) : ""), attachments };
}

function messageLine(m: Message, d: Dict): string {
  const date = header(m, "Date");
  return `- ${header(m, "Subject") || d.prompt.gmailNoSubject} · ${header(m, "From")} · ${date} · id: ${m.id}${
    m.snippet ? `\n  ${m.snippet}` : ""
  }`;
}

async function search(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const q = str(args.query) ?? "";
  const limit = limitOf(args.limit, SEARCH_DEFAULT);
  const params = new URLSearchParams({ maxResults: String(limit) });
  if (q) params.set("q", q);
  const list = await json<{ messages?: Array<{ id: string }> }>(
    ctx,
    `${ctx.baseUrl}/messages?${params}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return text(d.prompt.gmailNone, { messages: [] });
  const meta = new URLSearchParams({ format: "metadata" });
  for (const h of META_HEADERS) meta.append("metadataHeaders", h);
  const messages = await Promise.all(
    ids.map((id) =>
      json<Message>(ctx, `${ctx.baseUrl}/messages/${encodeURIComponent(id)}?${meta}`),
    ),
  );
  const summary = messages.map((m) => ({
    id: m.id,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: m.snippet ?? "",
  }));
  return text(messages.map((m) => messageLine(m, d)).join("\n"), { messages: summary });
}

async function read(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const id = str(args.messageId);
  if (!id) throw new Error(d.errors.gmailIdRequired);
  const m = await json<Message>(
    ctx,
    `${ctx.baseUrl}/messages/${encodeURIComponent(id)}?${new URLSearchParams({ format: "full" })}`,
  );
  const { text: body, attachments } = bodyOf(m.payload);
  const head = META_HEADERS.map((h) => `${h}: ${header(m, h)}`).join("\n");
  const att = attachments.length ? `\n${d.prompt.gmailAttachments} ${attachments.join(", ")}` : "";
  return text(`${head}${att}\n\n${clip(body, d)}`, {
    id: m.id,
    threadId: m.threadId ?? null,
    labels: m.labelIds ?? [],
    attachments,
  });
}

/** RFC 2047: ASCII dışı konu B kodlamasıyla. */
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/**
 * Başlık değerinden denetim karakterlerini atar.
 *
 * Adresler modelden gelir; `a@b.c\r\nBcc: saldırgan@evil.com` gibi bir değer ham MIME'a
 * yazıldığında kullanıcının görmediği bir gizli alıcı eklerdi (başlık enjeksiyonu): kullanıcı
 * taslakta yalnız ilk adresi görür, gönderimde kopya karşı tarafa gider.
 */
function headerValue(s: string | undefined): string {
  // Karakter koduna bakılır: denetim karakterlerini regex içinde yazmak lint kapısına takılır
  // (ve haklı olarak: çoğu zaman kaza eseridir). C0, DEL ve C1 aralıkları boşluğa çevrilir.
  let out = "";
  for (const ch of s ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control ? " " : ch;
  }
  return out.trim();
}

async function draft(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const to = headerValue(str(args.to));
  const cc = headerValue(str(args.cc));
  const subject = str(args.subject) ?? "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!to) throw new Error(d.errors.gmailDraftArgs);
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
  const threadId = str(args.threadId);
  const out = await json<{ id: string; message?: { id?: string; threadId?: string } }>(
    ctx,
    `${ctx.baseUrl}/drafts`,
    jsonBody("POST", {
      message: { raw: toBase64Url(lines.join("\r\n")), ...(threadId ? { threadId } : {}) },
    }),
  );
  return text(`${d.prompt.gmailDrafted} ${to} · ${subject} · draft id: ${out.id}`, {
    draftId: out.id,
    messageId: out.message?.id ?? null,
  });
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  return [
    {
      name: "search_messages",
      ...READ_ONLY_TOOL,
      description: p.gmailSearch,
      inputSchema: jsonSchema(
        Type.Object({
          query: Type.Optional(Type.String({ description: p.gmailQuery })),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: p.gdriveLimit }),
          ),
        }),
      ),
    },
    {
      name: "read_message",
      ...READ_ONLY_TOOL,
      description: p.gmailRead,
      inputSchema: jsonSchema(
        Type.Object({ messageId: Type.String({ minLength: 1, description: p.gmailMessageId }) }),
      ),
    },
    {
      name: "create_draft",
      description: p.gmailDraft,
      inputSchema: jsonSchema(
        Type.Object({
          to: Type.String({ minLength: 1, description: p.gmailTo }),
          subject: Type.String({ description: p.gmailSubject }),
          body: Type.String({ description: p.gmailBody }),
          cc: Type.Optional(Type.String({ description: p.gmailCc })),
          threadId: Type.Optional(Type.String({ description: p.gmailThread })),
        }),
      ),
    },
  ];
}

export const GMAIL_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  probe: async (ctx) => {
    const profile = await json<{ emailAddress?: string }>(ctx, `${ctx.baseUrl}/profile`);
    return profile.emailAddress ?? null;
  },
  call: dispatcher({ search_messages: search, read_message: read, create_draft: draft }),
};
