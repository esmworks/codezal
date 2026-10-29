import type { Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@modelcontextprotocol/client";
import {
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

/**
 * Google Takvim (Calendar API v3): takvim listesi, etkinlikler ve uygun zaman (free/busy).
 * Kapsamlar salt okunur; etkinlik oluşturma yok (katalog tanımıyla aynı).
 */
const DAY_MS = 24 * 3_600_000;
const DEFAULT_DAYS = 7;

interface Calendar {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}
interface When {
  dateTime?: string;
  date?: string;
}
interface Event {
  id: string;
  summary?: string;
  status?: string;
  start?: When;
  end?: When;
  location?: string;
  htmlLink?: string;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  description?: string;
}

function when(w: When | undefined): string {
  return w?.dateTime ?? w?.date ?? "";
}

/** Çözülemeyen tarih `toISOString`'te çıplak `RangeError` olurdu; model ne vereceğini bilsin. */
function parseTime(d: Dict, field: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(d.errors.gcalBadTime.replace("{{field}}", field).replace("{{value}}", value));
  return date;
}

/** Zaman aralığı: verilmezse şimdiden itibaren `DEFAULT_DAYS` gün. */
function range(d: Dict, args: Record<string, unknown>): { timeMin: string; timeMax: string } {
  const minText = str(args.timeMin);
  const maxText = str(args.timeMax);
  const min = minText ? parseTime(d, "timeMin", minText) : new Date();
  const max = maxText
    ? parseTime(d, "timeMax", maxText)
    : new Date(min.getTime() + DEFAULT_DAYS * DAY_MS);
  // Google ters aralığa yalnız "Bad Request" der; model neyi düzelteceğini bilsin.
  if (max <= min) throw new Error(d.errors.gcalBadRange);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

function eventLine(e: Event, d: Dict): string {
  const parts = [`${when(e.start)} → ${when(e.end)}`, e.summary ?? d.prompt.nativeUntitled];
  if (e.location) parts.push(e.location);
  if (e.attendees?.length)
    parts.push(d.prompt.gcalAttendees.replace("{{count}}", String(e.attendees.length)));
  parts.push(`id: ${e.id}`);
  if (e.htmlLink) parts.push(e.htmlLink);
  return `- ${parts.join(" · ")}`;
}

async function calendars(ctx: NativeContext) {
  const d = dict(ctx.lang);
  const out = await json<{ items?: Calendar[] }>(ctx, `${ctx.baseUrl}/users/me/calendarList`);
  const items = out.items ?? [];
  if (items.length === 0) return text(d.prompt.gcalNone, { calendars: [] });
  const lines = items.map(
    (c) =>
      `- ${c.summary ?? c.id}${c.primary ? ` (${d.prompt.gcalPrimary})` : ""} · ${c.accessRole ?? ""} · id: ${c.id}`,
  );
  return text(lines.join("\n"), { calendars: items });
}

async function events(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const calendarId = str(args.calendarId) ?? "primary";
  const params = new URLSearchParams({
    ...range(d, args),
    maxResults: String(limitOf(args.limit)),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const q = str(args.query);
  if (q) params.set("q", q);
  const out = await json<{ items?: Event[] }>(
    ctx,
    `${ctx.baseUrl}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
  const items = (out.items ?? []).filter((e) => e.status !== "cancelled");
  if (items.length === 0) return text(d.prompt.gcalNone, { events: [] });
  return text(items.map((e) => eventLine(e, d)).join("\n"), { events: items });
}

async function freeBusy(ctx: NativeContext, args: Record<string, unknown>) {
  const d = dict(ctx.lang);
  const ids = Array.isArray(args.calendarIds)
    ? args.calendarIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const items = (ids.length ? ids : ["primary"]).map((id) => ({ id }));
  const r = range(d, args);
  const out = await json<{
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  }>(ctx, `${ctx.baseUrl}/freeBusy`, jsonBody("POST", { ...r, items }));
  const lines: string[] = [`${r.timeMin} → ${r.timeMax}`];
  for (const [id, cal] of Object.entries(out.calendars ?? {})) {
    const busy = cal.busy ?? [];
    lines.push(`## ${id}`);
    if (busy.length === 0) lines.push(d.prompt.gcalFree);
    for (const b of busy) lines.push(`- ${b.start} → ${b.end}`);
  }
  return text(lines.join("\n"), { range: r, calendars: out.calendars ?? {} });
}

function tools(lang: Locale): Tool[] {
  const p = dict(lang).prompt;
  const timeMin = Type.Optional(Type.String({ description: p.gcalTimeMin }));
  const timeMax = Type.Optional(Type.String({ description: p.gcalTimeMax }));
  return [
    {
      name: "list_calendars",
      ...READ_ONLY_TOOL,
      description: p.gcalCalendars,
      inputSchema: jsonSchema(Type.Object({})),
    },
    {
      name: "list_events",
      ...READ_ONLY_TOOL,
      description: p.gcalEvents,
      inputSchema: jsonSchema(
        Type.Object({
          calendarId: Type.Optional(Type.String({ description: p.gcalCalendarId })),
          timeMin,
          timeMax,
          query: Type.Optional(Type.String({ description: p.gcalQuery })),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: p.gdriveLimit }),
          ),
        }),
      ),
    },
    {
      name: "free_busy",
      ...READ_ONLY_TOOL,
      description: p.gcalFreeBusy,
      inputSchema: jsonSchema(
        Type.Object({
          timeMin,
          timeMax,
          calendarIds: Type.Optional(Type.Array(Type.String(), { description: p.gcalCalendarIds })),
        }),
      ),
    },
  ];
}

export const GCALENDAR_SERVICE: NativeService = {
  authServerUrl: GOOGLE_AUTH_SERVER,
  tools,
  // Birincil takvimin kimliği hesabın e-postasıdır; `calendarlist.readonly` kapsamı yeter.
  probe: async (ctx) => {
    const primary = await json<{ id?: string }>(
      ctx,
      `${ctx.baseUrl}/users/me/calendarList/primary`,
    );
    return primary.id ?? null;
  },
  call: dispatcher({ list_calendars: calendars, list_events: events, free_busy: freeBusy }),
};
