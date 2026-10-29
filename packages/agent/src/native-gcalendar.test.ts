import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAt, fakeCtx, googleError, textOf } from "./native.fixture.js";
import { dict, NativeHttpError } from "./native.js";
import { GCALENDAR_SERVICE } from "./native-gcalendar.js";

const d = dict("tr");
const NOW = new Date("2026-09-26T09:00:00.000Z");

describe("Takvim araç tanımları", () => {
  it("üç araç, hepsi salt okunur; etkinlik oluşturan/silen araç yok", () => {
    const tools = GCALENDAR_SERVICE.tools("tr");
    expect(tools.map((t) => t.name)).toEqual(["list_calendars", "list_events", "free_busy"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((t) => /create|insert|delete|update/i.test(t.name))).toBe(false);
  });

  it("şemalarda zorunlu alan yok; free_busy takvim kimliklerini dizi olarak alır", () => {
    const byName = Object.fromEntries(GCALENDAR_SERVICE.tools("en").map((t) => [t.name, t]));
    for (const t of Object.values(byName)) expect(t.inputSchema.required).toBeUndefined();
    const ids = byName.free_busy?.inputSchema.properties?.calendarIds as {
      type: string;
      items: { type: string };
    };
    expect(ids).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("bilinmeyen araç reddedilir", () => {
    const ctx = fakeCtx(() => ({}));
    expect(() => GCALENDAR_SERVICE.call(ctx, "create_event", {})).toThrow(d.errors.mcpToolError);
  });
});

describe("Takvim etkinlik ve uygunluk", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aralık verilmezse şimdiden 7 gün; varsayılan takvim primary, sınır 20", async () => {
    const ctx = fakeCtx(() => ({ items: [] }));
    const r = await GCALENDAR_SERVICE.call(ctx, "list_events", {});
    expect(textOf(r)).toBe(d.prompt.gcalNone);
    const u = callAt(ctx, 0).url;
    expect(u.pathname).toBe("/v1/calendars/primary/events");
    expect(u.searchParams.get("timeMin")).toBe("2026-09-26T09:00:00.000Z");
    expect(u.searchParams.get("timeMax")).toBe("2026-10-03T09:00:00.000Z");
    expect(u.searchParams.get("maxResults")).toBe("20");
    expect(u.searchParams.get("orderBy")).toBe("startTime");
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(u.searchParams.has("q")).toBe(false);
  });

  it("takvim kimliği (e-posta) yol parçası olarak kodlanır; timeMax ayrıca verilebilir", async () => {
    const ctx = fakeCtx(() => ({ items: [] }));
    await GCALENDAR_SERVICE.call(ctx, "list_events", {
      calendarId: "ekip#tatil@group.calendar.google.com",
      timeMin: "2026-10-01T00:00:00+03:00",
      timeMax: "2026-10-02T00:00:00+03:00",
      limit: 5,
    });
    const u = callAt(ctx, 0).url;
    expect(u.pathname).toBe("/v1/calendars/ekip%23tatil%40group.calendar.google.com/events");
    expect(u.searchParams.get("timeMin")).toBe("2026-09-30T21:00:00.000Z");
    expect(u.searchParams.get("timeMax")).toBe("2026-10-01T21:00:00.000Z");
    expect(u.searchParams.get("maxResults")).toBe("5");
  });

  it("geçersiz tarih ve ters aralık istek atılmadan anlaşılır hatayla reddedilir", async () => {
    const ctx = fakeCtx(() => ({ items: [] }));
    await expect(
      GCALENDAR_SERVICE.call(ctx, "list_events", { timeMin: "yarın sabah" }),
    ).rejects.toThrow('Geçersiz timeMin: "yarın sabah"; ISO 8601 ver');
    await expect(
      GCALENDAR_SERVICE.call(ctx, "free_busy", { timeMax: "2026-13-01" }),
    ).rejects.toThrow('Geçersiz timeMax: "2026-13-01"');
    await expect(
      GCALENDAR_SERVICE.call(ctx, "list_events", {
        timeMin: "2026-10-02T00:00:00Z",
        timeMax: "2026-10-01T00:00:00Z",
      }),
    ).rejects.toThrow(d.errors.gcalBadRange);
    expect(ctx.calls).toHaveLength(0);
  });

  it("etkinlik satırı konum ve bağlantıyı taşır; hepsi iptalse 'etkinlik yok'", async () => {
    const items = [
      {
        id: "e1",
        summary: "Demo",
        location: "Oda 3",
        htmlLink: "https://cal/e1",
        start: { dateTime: "2026-09-27T10:00:00Z" },
        end: { dateTime: "2026-09-27T11:00:00Z" },
      },
    ];
    const ctx = fakeCtx(() => ({ items }));
    const r = await GCALENDAR_SERVICE.call(ctx, "list_events", {});
    expect(textOf(r)).toBe(
      "- 2026-09-27T10:00:00Z → 2026-09-27T11:00:00Z · Demo · Oda 3 · id: e1 · https://cal/e1",
    );
    expect(r.details).toEqual({ events: items });
    const cancelled = fakeCtx(() => ({ items: [{ id: "x", status: "cancelled" }] }));
    const none = await GCALENDAR_SERVICE.call(cancelled, "list_events", {});
    expect(textOf(none)).toBe(d.prompt.gcalNone);
    expect(none.details).toEqual({ events: [] });
  });

  it("free/busy: kimlik yoksa primary; dize olmayan ve boş kimlikler elenir; POST JSON", async () => {
    const ctx = fakeCtx(() => ({ calendars: { primary: { busy: [] } } }));
    const r = await GCALENDAR_SERVICE.call(ctx, "free_busy", { calendarIds: [42, "", null] });
    const c = callAt(ctx, 0);
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/v1/freeBusy");
    expect(c.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(c.body).toEqual({
      timeMin: "2026-09-26T09:00:00.000Z",
      timeMax: "2026-10-03T09:00:00.000Z",
      items: [{ id: "primary" }],
    });
    expect(textOf(r)).toBe(
      `2026-09-26T09:00:00.000Z → 2026-10-03T09:00:00.000Z\n## primary\n${d.prompt.gcalFree}`,
    );
  });

  it("free/busy yanıtında takvim yoksa yalnız aralık satırı döner", async () => {
    const ctx = fakeCtx(() => ({}));
    const r = await GCALENDAR_SERVICE.call(ctx, "free_busy", {});
    expect(textOf(r)).toBe("2026-09-26T09:00:00.000Z → 2026-10-03T09:00:00.000Z");
    expect(r.details).toMatchObject({ calendars: {} });
  });
});

describe("Takvim listesi, bağlantı denetimi ve hatalar", () => {
  it("takvim yoksa 'etkinlik yok' metni; ad yoksa kimlik gösterilir", async () => {
    const empty = fakeCtx(() => ({}));
    expect(textOf(await GCALENDAR_SERVICE.call(empty, "list_calendars", {}))).toBe(
      d.prompt.gcalNone,
    );
    const ctx = fakeCtx(() => ({ items: [{ id: "c9" }] }));
    expect(textOf(await GCALENDAR_SERVICE.call(ctx, "list_calendars", {}))).toBe(
      "- c9 ·  · id: c9",
    );
  });

  it("probe birincil takvimin kimliğini döner; yoksa null", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GCALENDAR_SERVICE.probe(ctx)).resolves.toBeNull();
    expect(callAt(ctx, 0).url.pathname).toBe("/v1/users/me/calendarList/primary");
  });

  it("404 ve 401 durum kodlu NativeHttpError olarak yükselir", async () => {
    const nf = fakeCtx(() => googleError(404, "Not Found"));
    const err = await GCALENDAR_SERVICE.call(nf, "list_events", { calendarId: "yok" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NativeHttpError);
    expect((err as Error).message).toBe("Sunucu HTTP 404 döndürdü · Not Found");
    const un = fakeCtx(() => googleError(401, "Invalid Credentials"));
    await expect(GCALENDAR_SERVICE.probe(un)).rejects.toMatchObject({ status: 401 });
  });
});
