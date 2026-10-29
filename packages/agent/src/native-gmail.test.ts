import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b64url, callAt, fakeCtx, fromB64url, googleError, textOf } from "./native.fixture.js";
import { dict, MAX_READ_CHARS, NativeHttpError } from "./native.js";
import { GMAIL_SERVICE } from "./native-gmail.js";

const d = dict("tr");

/** Taslak isteğindeki ham RFC 822 iletisini çözer. */
function rawMime(body: unknown): string {
  const raw = (body as { message: { raw: string } }).message.raw;
  return fromB64url(raw);
}

describe("Gmail araç tanımları", () => {
  it("yalnız arama, okuma ve taslak araçları var; hiçbiri gönderme yapmaz", () => {
    for (const lang of ["tr", "en"] as const) {
      const names = GMAIL_SERVICE.tools(lang).map((t) => t.name);
      expect(names).toEqual(["search_messages", "read_message", "create_draft"]);
      expect(names.some((n) => /send|forward|reply/i.test(n))).toBe(false);
    }
  });

  it("izin sınıflandırması: arama ve okuma salt okunur, taslak yazan araçtır", () => {
    const byName = Object.fromEntries(GMAIL_SERVICE.tools("tr").map((t) => [t.name, t]));
    expect(byName.search_messages?.annotations?.readOnlyHint).toBe(true);
    expect(byName.read_message?.annotations?.readOnlyHint).toBe(true);
    expect(byName.create_draft?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("şemalar zorunlu alanları taşır", () => {
    const byName = Object.fromEntries(GMAIL_SERVICE.tools("tr").map((t) => [t.name, t]));
    expect(byName.read_message?.inputSchema.required).toEqual(["messageId"]);
    expect(byName.create_draft?.inputSchema.required).toEqual(["to", "subject", "body"]);
    expect(byName.search_messages?.inputSchema.required).toBeUndefined();
    const limit = byName.search_messages?.inputSchema.properties?.limit as {
      minimum: number;
      maximum: number;
    };
    expect(limit).toMatchObject({ minimum: 1, maximum: 50 });
  });

  it("gönderme uçları kaynakta hiç geçmez (messages.send / drafts.send)", () => {
    const src = readFileSync(new URL("./native-gmail.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/messages\/send|drafts\/send|\/send\b|:send\b/);
  });

  it("bilinmeyen (gönderme) aracı istek atmadan reddedilir", async () => {
    const ctx = fakeCtx(() => {
      throw new Error("istek beklenmiyordu");
    });
    for (const tool of ["send_message", "send_draft", "reply", "__proto__", "toString"])
      expect(() => GMAIL_SERVICE.call(ctx, tool, { to: "a@b.c" })).toThrow(d.errors.mcpToolError);
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("Gmail arama", () => {
  it("varsayılan sınır 10, sorgu yoksa q gönderilmez, sonuç yoksa meta veri çağrısı yapılmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    const r = await GMAIL_SERVICE.call(ctx, "search_messages", {});
    expect(textOf(r)).toBe(d.prompt.gmailNone);
    expect(r.details).toEqual({ messages: [] });
    expect(ctx.calls).toHaveLength(1);
    const p = callAt(ctx, 0).url.searchParams;
    expect(p.get("maxResults")).toBe("10");
    expect(p.has("q")).toBe(false);
    expect(callAt(ctx, 0).method).toBe("GET");
  });

  it("sınır 1-50 aralığına kırpılır, boşluklu sorgu kırpılır", async () => {
    const ctx = fakeCtx(() => ({ messages: [] }));
    await GMAIL_SERVICE.call(ctx, "search_messages", { limit: 500, query: "  is:unread  " });
    await GMAIL_SERVICE.call(ctx, "search_messages", { limit: 0 });
    await GMAIL_SERVICE.call(ctx, "search_messages", { limit: 3.9, query: "   " });
    expect(callAt(ctx, 0).url.searchParams.get("maxResults")).toBe("50");
    expect(callAt(ctx, 0).url.searchParams.get("q")).toBe("is:unread");
    expect(callAt(ctx, 1).url.searchParams.get("maxResults")).toBe("1");
    expect(callAt(ctx, 2).url.searchParams.get("maxResults")).toBe("3");
    expect(callAt(ctx, 2).url.searchParams.has("q")).toBe(false);
  });

  it("her ileti meta veri biçimiyle ayrı istenir; kimlik URL'de kodlanır; özet ayrıntıya yazılır", async () => {
    const ctx = fakeCtx((url) => {
      if (url.pathname === "/v1/messages") return { messages: [{ id: "a/b" }] };
      return {
        id: "a/b",
        snippet: "kısa",
        payload: {
          headers: [
            { name: "subject", value: "Küçük harfli başlık" },
            { name: "FROM", value: "x@y.z" },
            { name: "Date", value: "Sat, 26 Sep 2026" },
          ],
        },
      };
    });
    const r = await GMAIL_SERVICE.call(ctx, "search_messages", { query: "x" });
    const meta = callAt(ctx, 1).url;
    expect(meta.pathname).toBe("/v1/messages/a%2Fb");
    expect(meta.searchParams.get("format")).toBe("metadata");
    expect(meta.searchParams.getAll("metadataHeaders")).toEqual(["From", "To", "Subject", "Date"]);
    // Başlık adı büyük/küçük harf duyarsız eşleşir.
    expect(textOf(r)).toBe("- Küçük harfli başlık · x@y.z · Sat, 26 Sep 2026 · id: a/b\n  kısa");
    expect(r.details).toEqual({
      messages: [
        {
          id: "a/b",
          from: "x@y.z",
          subject: "Küçük harfli başlık",
          date: "Sat, 26 Sep 2026",
          snippet: "kısa",
        },
      ],
    });
  });

  it("iptal sinyali her isteğe iletilir", async () => {
    const ac = new AbortController();
    const ctx = fakeCtx(
      (url) =>
        url.pathname === "/v1/messages" ? { messages: [{ id: "m1" }] } : { id: "m1", payload: {} },
      { signal: ac.signal },
    );
    await GMAIL_SERVICE.call(ctx, "search_messages", {});
    expect(ctx.calls).toHaveLength(2);
    for (const c of ctx.calls) expect(c.signal).toBe(ac.signal);
  });
});

describe("Gmail okuma", () => {
  it("kimlik yoksa istek atmadan hata verir", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GMAIL_SERVICE.call(ctx, "read_message", {})).rejects.toThrow(
      d.errors.gmailIdRequired,
    );
    await expect(GMAIL_SERVICE.call(ctx, "read_message", { messageId: "  " })).rejects.toThrow(
      d.errors.gmailIdRequired,
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it("text/plain yoksa HTML gövde düz metne indirilir; ayrıntılar kimlik ve etiketleri taşır", async () => {
    const ctx = fakeCtx(() => ({
      id: "m1",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "a@b.c" },
          { name: "To", value: "ben@b.c" },
        ],
        body: { data: b64url("<html><body><p>Merhaba <b>dünya</b></p></body></html>") },
      },
    }));
    const r = await GMAIL_SERVICE.call(ctx, "read_message", { messageId: "m1" });
    const t = textOf(r);
    expect(callAt(ctx, 0).url.searchParams.get("format")).toBe("full");
    expect(t.startsWith("From: a@b.c\nTo: ben@b.c\nSubject: \nDate: \n\n")).toBe(true);
    expect(t).toContain("Merhaba");
    expect(t).toContain("dünya");
    expect(t).not.toContain("<p>");
    expect(r.details).toEqual({
      id: "m1",
      threadId: null,
      labels: ["INBOX", "UNREAD"],
      attachments: [],
    });
  });

  it("uzun gövde kesilir ve not düşülür", async () => {
    const long = "a".repeat(MAX_READ_CHARS + 50);
    const ctx = fakeCtx(() => ({
      id: "m1",
      payload: { mimeType: "text/plain", body: { data: b64url(long) } },
    }));
    const t = textOf(await GMAIL_SERVICE.call(ctx, "read_message", { messageId: "m1" }));
    expect(t).toContain(d.prompt.gdriveTruncated.replace("{{chars}}", String(MAX_READ_CHARS)));
    expect(t).not.toContain("a".repeat(MAX_READ_CHARS + 1));
  });

  it("eklerin içeriği gövdeye karışmaz, yalnız adları listelenir", async () => {
    const ctx = fakeCtx(() => ({
      id: "m1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", filename: "not.txt", body: { data: b64url("GİZLİ EK") } },
          { mimeType: "text/plain", body: { data: b64url("asıl gövde") } },
        ],
      },
    }));
    const r = await GMAIL_SERVICE.call(ctx, "read_message", { messageId: "m1" });
    expect(textOf(r)).toContain("asıl gövde");
    expect(textOf(r)).not.toContain("GİZLİ EK");
    expect((r.details as { attachments: string[] }).attachments).toEqual(["not.txt"]);
  });
});

describe("Gmail taslak", () => {
  it("yalnız /drafts'a tek bir POST gider; gönderme ucu çağrılmaz", async () => {
    const ctx = fakeCtx(() => ({ id: "d1", message: { id: "m1" } }));
    const r = await GMAIL_SERVICE.call(ctx, "create_draft", {
      to: "a@b.c",
      subject: "Merhaba",
      body: "gövde",
    });
    expect(ctx.calls).toHaveLength(1);
    const c = callAt(ctx, 0);
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/v1/drafts");
    expect(c.url.pathname).not.toMatch(/send/);
    expect(c.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    // threadId verilmediyse gövdede de yok.
    expect(Object.keys((c.body as { message: object }).message)).toEqual(["raw"]);
    expect(r.details).toEqual({ draftId: "d1", messageId: "m1" });
    expect(textOf(r)).toBe(`${d.prompt.gmailDrafted} a@b.c · Merhaba · draft id: d1`);
  });

  it("ASCII konu olduğu gibi yazılır, Cc eklenir, gövde base64 ve UTF-8", async () => {
    const ctx = fakeCtx(() => ({ id: "d1" }));
    const r = await GMAIL_SERVICE.call(ctx, "create_draft", {
      to: "a@b.c",
      cc: "c@d.e",
      subject: "Plain subject",
      body: "Şişli'de görüşürüz",
    });
    const mime = rawMime(callAt(ctx, 0).body);
    const [head = "", body = ""] = mime.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "To: a@b.c",
      "Cc: c@d.e",
      "Subject: Plain subject",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Şişli'de görüşürüz");
    expect(r.details).toEqual({ draftId: "d1", messageId: null });
  });

  it("alıcı alanlarındaki satır sonu başlık enjeksiyonu (gizli Bcc) etkisizleştirilir", async () => {
    const ctx = fakeCtx(() => ({ id: "d1" }));
    await GMAIL_SERVICE.call(ctx, "create_draft", {
      to: "a@b.c\r\nBcc: saldirgan@evil.com",
      cc: "c@d.e\nBcc: iki@evil.com\u0085",
      subject: "x",
      body: "",
    });
    const mime = rawMime(callAt(ctx, 0).body);
    const headers = mime.split("\r\n\r\n")[0]?.split("\r\n") ?? [];
    expect(headers.some((h) => /^bcc:/i.test(h))).toBe(false);
    expect(headers[0]).toBe("To: a@b.c  Bcc: saldirgan@evil.com");
    expect(headers[1]).toBe("Cc: c@d.e Bcc: iki@evil.com");
  });

  it("yalnız denetim karakterinden oluşan alıcı reddedilir", async () => {
    const ctx = fakeCtx(() => ({ id: "d1" }));
    await expect(
      GMAIL_SERVICE.call(ctx, "create_draft", { to: "\r\n", subject: "", body: "" }),
    ).rejects.toThrow(d.errors.gmailDraftArgs);
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("Gmail hata yolları ve bağlantı denetimi", () => {
  it("401 durum kodu NativeHttpError olarak taşınır (bağlayıcı bunu 'giriş gerekli'ye çevirir)", async () => {
    const ctx = fakeCtx(() => googleError(401, "Invalid Credentials"));
    const err = await GMAIL_SERVICE.call(ctx, "search_messages", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect(err).toMatchObject({
      status: 401,
      message: `${d.errors.mcpHttpError.replace("{{status}}", "401")} · Invalid Credentials`,
    });
  });

  it("JSON olmayan 5xx gövdesi ham metinle, uzun mesaj 200 karakterde kesilir", async () => {
    const plain = fakeCtx(() => new Response("Backend Error", { status: 503 }));
    await expect(GMAIL_SERVICE.call(plain, "read_message", { messageId: "m" })).rejects.toThrow(
      "HTTP 503 döndürdü · Backend Error",
    );
    const long = fakeCtx(() => googleError(400, "x".repeat(300)));
    const err = await GMAIL_SERVICE.probe(long).catch((e: Error) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect((err as Error).message.endsWith(`· ${"x".repeat(200)}…`)).toBe(true);
    const empty = fakeCtx(() => new Response("", { status: 500 }));
    await expect(GMAIL_SERVICE.probe(empty)).rejects.toThrow(/^Sunucu HTTP 500 döndürdü$/);
  });

  it("taslakta sunucu hatası kullanıcıya iletilir, sonuç üretilmez", async () => {
    const ctx = fakeCtx(() => googleError(403, "Insufficient Permission"));
    await expect(
      GMAIL_SERVICE.call(ctx, "create_draft", { to: "a@b.c", subject: "", body: "" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("probe profil ucunu çağırır; e-posta yoksa null döner", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GMAIL_SERVICE.probe(ctx)).resolves.toBeNull();
    expect(callAt(ctx, 0).url.href).toBe("https://api.test/v1/profile");
    expect(GMAIL_SERVICE.authServerUrl).toBe("https://accounts.google.com");
  });
});
