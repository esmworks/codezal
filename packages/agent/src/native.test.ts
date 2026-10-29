import { describe, expect, it } from "vitest";
import { idFrom, type NativeContext } from "./native.js";
import { GCALENDAR_SERVICE } from "./native-gcalendar.js";
import { docText, GDOCS_SERVICE } from "./native-gdocs.js";
import { GMAIL_SERVICE } from "./native-gmail.js";
import { GSHEETS_SERVICE } from "./native-gsheets.js";
import { GSLIDES_SERVICE } from "./native-gslides.js";
import { NATIVE_SERVICES } from "./native-services.js";

/**
 * Sahte istek bağlamı: OAuth ve 401 yenileme yolu `mcp.test.ts`'de Drive ile test edilir; burada
 * her servisin doğru adrese doğru gövdeyle gittiği ve yanıtı okunur metne çevirdiği sınanır.
 */
interface Call {
  url: URL;
  method: string;
  body: unknown;
}

function fakeCtx(routes: (url: URL, call: Call) => unknown): NativeContext & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    baseUrl: "https://api.test/v1",
    driveUrl: "https://drive.test/v3",
    signal: undefined,
    lang: "tr",
    request: async (raw, init) => {
      const url = new URL(raw);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const call: Call = { url, method: init?.method ?? "GET", body };
      calls.push(call);
      const out = routes(url, call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** Kayıtlı çağrı; yoksa test açık hata verir (isteğe bağlı zincir yerine). */
function callAt(ctx: { calls: Call[] }, i: number): Call {
  const c = ctx.calls.at(i);
  if (!c) throw new Error(`çağrı yok: ${i}`);
  return c;
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

const b64url = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

describe("uygulama içi servisler", () => {
  it("kayıt: altı Google servisi, her aracın açıklaması ve şeması var", () => {
    expect(Object.keys(NATIVE_SERVICES).sort()).toEqual([
      "gcalendar",
      "gdocs",
      "gdrive",
      "gmail",
      "gsheets",
      "gslides",
    ]);
    for (const s of Object.values(NATIVE_SERVICES))
      for (const t of s.tools("tr")) {
        expect(t.description?.length).toBeGreaterThan(10);
        expect(t.inputSchema.type).toBe("object");
        // İngilizce sözlük aynı anahtarları taşır; araç sayısı değişmez.
        expect(s.tools("en").map((x) => x.name)).toContain(t.name);
      }
  });

  it("id bağlantıdan da alınır", () => {
    expect(idFrom("https://docs.google.com/document/d/abc_123/edit#x")).toBe("abc_123");
    expect(idFrom(" düz-id ")).toBe("düz-id");
    expect(idFrom("")).toBeUndefined();
  });

  it("Gmail: arama meta veriyle listeler, okuma iç içe text/plain parçasını çözer, taslak RFC822 üretir", async () => {
    const ctx = fakeCtx((url) => {
      if (url.pathname === "/v1/messages") return { messages: [{ id: "m1" }, { id: "m2" }] };
      if (url.pathname === "/v1/messages/m1" && url.searchParams.get("format") === "metadata")
        return {
          id: "m1",
          snippet: "Merhaba…",
          payload: {
            headers: [
              { name: "Subject", value: "Toplantı" },
              { name: "From", value: "ayse@ornek.com" },
              { name: "Date", value: "Fri, 11 Sep 2026 10:00:00 +0300" },
            ],
          },
        };
      if (url.pathname === "/v1/messages/m2") return { id: "m2", payload: { headers: [] } };
      if (url.pathname === "/v1/messages/m1" && url.searchParams.get("format") === "full")
        return {
          id: "m1",
          threadId: "t1",
          payload: {
            mimeType: "multipart/mixed",
            headers: [{ name: "Subject", value: "Toplantı" }],
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/plain", body: { data: b64url("Yarın 10:00 uygun mu?") } },
                  { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
                ],
              },
              { mimeType: "application/pdf", filename: "gundem.pdf", body: { data: "" } },
            ],
          },
        };
      if (url.pathname === "/v1/drafts") return { id: "d1", message: { id: "m9" } };
      throw new Error(`beklenmeyen: ${url}`);
    });
    const list = textOf(await GMAIL_SERVICE.call(ctx, "search_messages", { query: "from:ayse" }));
    expect(list).toContain("Toplantı · ayse@ornek.com");
    expect(list).toContain("(konu yok)");
    expect(ctx.calls[0]?.url.searchParams.get("q")).toBe("from:ayse");
    expect(ctx.calls[1]?.url.searchParams.getAll("metadataHeaders")).toContain("Subject");

    const read = textOf(await GMAIL_SERVICE.call(ctx, "read_message", { messageId: "m1" }));
    expect(read).toContain("Yarın 10:00 uygun mu?");
    expect(read).toContain("Ekler: gundem.pdf");
    expect(read).not.toContain("html");

    const draft = await GMAIL_SERVICE.call(ctx, "create_draft", {
      to: "ayse@ornek.com",
      subject: "Yanıt: Toplantı",
      body: "Uygun.",
      threadId: "t1",
    });
    expect(textOf(draft)).toContain("draft id: d1");
    const sent = ctx.calls.at(-1)?.body as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("t1");
    const raw = Buffer.from(
      sent.message.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(raw).toContain("To: ayse@ornek.com");
    // ASCII dışı konu RFC 2047 ile kodlanır; gövde base64.
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain(Buffer.from("Uygun.").toString("base64"));
    await expect(GMAIL_SERVICE.call(ctx, "create_draft", { subject: "x" })).rejects.toThrow(
      /alıcı/,
    );
  });

  it("Takvim: etkinlikler tek tek açılır ve iptaller elenir, free/busy gövdesi takvimleri taşır", async () => {
    const ctx = fakeCtx((url) => {
      if (url.pathname === "/v1/users/me/calendarList")
        return { items: [{ id: "c1", summary: "İş", primary: true, accessRole: "owner" }] };
      if (url.pathname === "/v1/calendars/primary/events")
        return {
          items: [
            {
              id: "e1",
              summary: "Sprint",
              start: { dateTime: "2026-09-12T09:00:00+03:00" },
              end: { dateTime: "2026-09-12T10:00:00+03:00" },
              attendees: [{}, {}],
            },
            { id: "e2", summary: "İptal", status: "cancelled" },
            { id: "e3", start: { date: "2026-09-13" }, end: { date: "2026-09-14" } },
          ],
        };
      if (url.pathname === "/v1/freeBusy")
        return {
          calendars: {
            c1: { busy: [{ start: "2026-09-12T09:00:00Z", end: "2026-09-12T10:00:00Z" }] },
            c2: { busy: [] },
          },
        };
      throw new Error(`beklenmeyen: ${url}`);
    });
    expect(textOf(await GCALENDAR_SERVICE.call(ctx, "list_calendars", {}))).toContain(
      "İş (birincil) · owner · id: c1",
    );
    const events = textOf(
      await GCALENDAR_SERVICE.call(ctx, "list_events", {
        timeMin: "2026-09-12T00:00:00Z",
        query: "sprint",
      }),
    );
    expect(events).toContain("Sprint · 2 katılımcı · id: e1");
    expect(events).toContain("2026-09-13 → 2026-09-14 · (başlıksız)");
    expect(events).not.toContain("İptal");
    const p = ctx.calls[1]?.url.searchParams;
    expect(p?.get("singleEvents")).toBe("true");
    expect(p?.get("q")).toBe("sprint");
    expect(p?.get("timeMin")).toBe("2026-09-12T00:00:00.000Z");
    expect(p?.get("timeMax")).toBe("2026-09-19T00:00:00.000Z");
    const fb = textOf(
      await GCALENDAR_SERVICE.call(ctx, "free_busy", { calendarIds: ["c1", "c2"] }),
    );
    expect(fb).toContain("## c1\n- 2026-09-12T09:00:00Z → 2026-09-12T10:00:00Z");
    expect(fb).toContain("## c2\nDolu zaman yok.");
    expect((callAt(ctx, 2).body as { items: unknown }).items).toEqual([{ id: "c1" }, { id: "c2" }]);
  });

  it("Dokümanlar: gövde Markdown benzeri metne iner, ekleme belge sonuna gider, arama Drive'a gider", async () => {
    const content = [
      {
        paragraph: {
          elements: [{ textRun: { content: "Başlık\n" } }],
          paragraphStyle: { namedStyleType: "HEADING_1" },
        },
      },
      { paragraph: { elements: [{ textRun: { content: "Madde\n" } }], bullet: {} } },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: "a\n" } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: "b\n" } }] } }] },
              ],
            },
          ],
        },
      },
      {
        paragraph: { elements: [{ textRun: { content: "Son\n" } }] },
        startIndex: 20,
        endIndex: 24,
      },
    ];
    expect(docText(content)).toBe("# Başlık\n- Madde\na | b\nSon");
    const ctx = fakeCtx((url, call) => {
      if (url.pathname === "/v1/documents/doc1")
        return { documentId: "doc1", title: "Plan", body: { content } };
      if (url.pathname === "/v1/documents/doc1:batchUpdate") return {};
      if (url.pathname === "/v1/documents" && call.method === "POST") return { documentId: "yeni" };
      if (url.pathname === "/v1/documents/yeni:batchUpdate") return {};
      if (url.host === "drive.test")
        return {
          files: [{ id: "doc1", name: "Plan", mimeType: "application/vnd.google-apps.document" }],
        };
      throw new Error(`beklenmeyen: ${url}`);
    });
    expect(
      textOf(
        await GDOCS_SERVICE.call(ctx, "read_document", {
          documentId: "https://docs.google.com/document/d/doc1/edit",
        }),
      ),
    ).toContain("# Plan · id: doc1\n\n# Başlık");
    await GDOCS_SERVICE.call(ctx, "append_text", { documentId: "doc1", content: "Ek" });
    const upd = ctx.calls.at(-1)?.body as {
      requests: Array<{ insertText: { location: { index: number }; text: string } }>;
    };
    expect(upd.requests[0]?.insertText).toEqual({ location: { index: 23 }, text: "\nEk" });
    expect(
      textOf(
        await GDOCS_SERVICE.call(ctx, "create_document", { title: "Yeni", content: "Merhaba" }),
      ),
    ).toContain("id: yeni");
    const ins = ctx.calls.at(-1)?.body as {
      requests: Array<{ insertText: { location: { index: number } } }>;
    };
    expect(ins.requests[0]?.insertText.location.index).toBe(1);
    expect(textOf(await GDOCS_SERVICE.call(ctx, "search_documents", { query: "plan" }))).toContain(
      "Plan (google:document)",
    );
    const q = ctx.calls.at(-1)?.url;
    expect(q?.host).toBe("drive.test");
    expect(q?.searchParams.get("q")).toContain("mimeType = 'application/vnd.google-apps.document'");
  });

  it("E-Tablolar: okuma ilk sayfayı tırnaklı aralıkla alır, yazma PUT, ekleme append", async () => {
    const ctx = fakeCtx((url, call) => {
      if (url.pathname === "/v1/spreadsheets/ss1")
        return {
          spreadsheetId: "ss1",
          properties: { title: "Bütçe" },
          sheets: [{ properties: { title: "Eylül 2026" } }, { properties: { title: "Özet" } }],
        };
      if (url.pathname.startsWith("/v1/spreadsheets/ss1/values/") && call.method === "GET")
        return {
          range: "'Eylül 2026'!A1:Z200",
          values: [
            ["Kalem", "Tutar"],
            ["Kira", 1200],
          ],
        };
      if (call.method === "PUT") return { updatedRange: "'Özet'!A1:B1", updatedCells: 2 };
      if (url.pathname.endsWith(":append"))
        return { updates: { updatedRange: "'Eylül 2026'!A3:B3", updatedRows: 1 } };
      if (url.pathname === "/v1/spreadsheets" && call.method === "POST")
        return {
          spreadsheetId: "yeni",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/yeni",
          sheets: [{ properties: { title: "Sayfa1" } }],
        };
      throw new Error(`beklenmeyen: ${url}`);
    });
    const read = textOf(await GSHEETS_SERVICE.call(ctx, "read_sheet", { spreadsheetId: "ss1" }));
    expect(read).toContain("Sayfalar: Eylül 2026, Özet");
    expect(read).toContain("1: Kalem | Tutar\n2: Kira | 1200");
    expect(decodeURIComponent(ctx.calls[1]?.url.pathname ?? "")).toBe(
      "/v1/spreadsheets/ss1/values/'Eylül 2026'!A1:Z200",
    );
    await GSHEETS_SERVICE.call(ctx, "write_cells", {
      spreadsheetId: "ss1",
      range: "'Özet'!A1",
      values: [["Toplam", "=SUM(B2:B9)"]],
    });
    const put = callAt(ctx, -1);
    expect(put.method).toBe("PUT");
    expect(put.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect((put.body as { values: unknown }).values).toEqual([["Toplam", "=SUM(B2:B9)"]]);
    expect(
      textOf(
        await GSHEETS_SERVICE.call(ctx, "append_rows", {
          spreadsheetId: "ss1",
          values: [["Su", 90]],
        }),
      ),
    ).toContain("A3:B3 · 1 satır");
    expect(ctx.calls.at(-1)?.url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(
      textOf(
        await GSHEETS_SERVICE.call(ctx, "create_spreadsheet", { title: "Yeni", values: [["a"]] }),
      ),
    ).toContain("id: yeni");
    expect(ctx.calls.at(-1)?.method).toBe("PUT");
    await expect(
      GSHEETS_SERVICE.call(ctx, "write_cells", { spreadsheetId: "ss1", range: "A1", values: [] }),
    ).rejects.toThrow(/satır/);
  });

  it("Slaytlar: okuma slayt başına metin verir, slayt ekleme başlık+gövde düzeniyle batchUpdate gönderir", async () => {
    const ctx = fakeCtx((url) => {
      if (url.pathname === "/v1/presentations/p1")
        return {
          presentationId: "p1",
          title: "Sunum",
          slides: [
            {
              objectId: "s1",
              pageElements: [
                { shape: { text: { textElements: [{ textRun: { content: "Giriş" } }] } } },
              ],
            },
            {
              objectId: "s2",
              pageElements: [
                {
                  table: {
                    tableRows: [
                      {
                        tableCells: [
                          { text: { textElements: [{ textRun: { content: "x" } }] } },
                          { text: { textElements: [{ textRun: { content: "y" } }] } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };
      if (url.pathname === "/v1/presentations/p1:batchUpdate") return {};
      throw new Error(`beklenmeyen: ${url}`);
    });
    const read = textOf(
      await GSLIDES_SERVICE.call(ctx, "read_presentation", { presentationId: "p1" }),
    );
    expect(read).toContain("# Sunum · id: p1 · 2 slayt");
    expect(read).toContain("## Slayt 1 (id: s1)\nGiriş");
    expect(read).toContain("## Slayt 2 (id: s2)\nx | y");
    const added = await GSLIDES_SERVICE.call(ctx, "add_slide", {
      presentationId: "p1",
      title: "Özet",
      body: "a\nb",
    });
    expect(textOf(added)).toContain("Slayt eklendi: Özet");
    const reqs = (
      callAt(ctx, -1).body as {
        requests: Array<
          Record<
            string,
            {
              objectId?: string;
              text?: string;
              slideLayoutReference?: { predefinedLayout: string };
            }
          >
        >;
      }
    ).requests;
    expect(reqs[0]?.createSlide?.slideLayoutReference?.predefinedLayout).toBe("TITLE_AND_BODY");
    expect(reqs[1]?.insertText?.text).toBe("Özet");
    expect(reqs[2]?.insertText?.text).toBe("a\nb");
    await expect(GSLIDES_SERVICE.call(ctx, "add_slide", { presentationId: "p1" })).rejects.toThrow(
      /başlığı/,
    );
  });

  it("bağlantı denetimi bağlı hesabın e-postasını döndürür", async () => {
    const ctx = fakeCtx((url) => {
      if (url.pathname === "/v1/profile") return { emailAddress: "posta@ornek.com" };
      if (url.pathname === "/v1/users/me/calendarList/primary") return { id: "takvim@ornek.com" };
      if (url.pathname === "/v3/about") return { user: { emailAddress: "drive@ornek.com" } };
      return new Response("{}", { status: 404 });
    });
    await expect(GMAIL_SERVICE.probe(ctx)).resolves.toBe("posta@ornek.com");
    await expect(GCALENDAR_SERVICE.probe(ctx)).resolves.toBe("takvim@ornek.com");
    // Dokümanlar Drive API'sinin about.user yanıtını kullanır.
    await expect(GDOCS_SERVICE.probe(ctx)).resolves.toBe("drive@ornek.com");
  });

  it("Google hata gövdesi okunur mesaja çevrilir, durum kodu taşınır", async () => {
    const ctx = fakeCtx(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 403, message: "Gmail API has not been used in project 1" },
          }),
          {
            status: 403,
          },
        ),
    );
    await expect(GMAIL_SERVICE.probe(ctx)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("HTTP 403 döndürdü · Gmail API has not been used"),
    });
  });
});
