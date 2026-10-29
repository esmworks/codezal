import { describe, expect, it } from "vitest";
import { callAt, fakeCtx, googleError, textOf } from "./native.fixture.js";
import { dict, MAX_READ_CHARS, NativeHttpError } from "./native.js";
import { docText, GDOCS_SERVICE } from "./native-gdocs.js";

const d = dict("tr");

const para = (content: string, extra: Record<string, unknown> = {}) => ({
  paragraph: { elements: [{ textRun: { content } }], ...extra },
});

describe("Dokümanlar araç tanımları", () => {
  it("arama/okuma salt okunur, oluşturma ve ekleme yazan araç", () => {
    const tools = GDOCS_SERVICE.tools("tr");
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint ?? false])).toEqual([
      ["search_documents", true],
      ["read_document", true],
      ["create_document", false],
      ["append_text", false],
    ]);
  });

  it("zorunlu alanlar şemada; arama türsüz ortak Drive şemasını kullanır", () => {
    const byName = Object.fromEntries(GDOCS_SERVICE.tools("en").map((t) => [t.name, t]));
    expect(byName.read_document?.inputSchema.required).toEqual(["documentId"]);
    expect(byName.create_document?.inputSchema.required).toEqual(["title"]);
    expect(byName.append_text?.inputSchema.required).toEqual(["documentId", "content"]);
    expect(byName.search_documents?.inputSchema.required).toEqual(["query"]);
    expect(byName.search_documents?.inputSchema.properties?.type).toBeUndefined();
  });

  it("bilinmeyen araç reddedilir", () => {
    expect(() =>
      GDOCS_SERVICE.call(
        fakeCtx(() => ({})),
        "delete_document",
        {},
      ),
    ).toThrow(d.errors.mcpToolError);
  });
});

describe("docText", () => {
  it("TITLE ve başlık düzeyleri, madde imleri, boş gövde", () => {
    expect(docText(undefined)).toBe("");
    expect(
      docText([
        para("Ana\n", { paragraphStyle: { namedStyleType: "TITLE" } }),
        para("Alt\n", { paragraphStyle: { namedStyleType: "HEADING_3" } }),
        para("Normal\n", { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } }),
        para("iç satır\nsonu\n"),
      ]),
    ).toBe("# Ana\n### Alt\nNormal\niç satır\nsonu");
  });

  it("çok paragraflı tablo hücresi tek satıra iner", () => {
    const cell = (a: string, b: string) => ({ content: [para(`${a}\n`), para(`${b}\n`)] });
    expect(
      docText([{ table: { tableRows: [{ tableCells: [cell("a", "b"), cell("c", "")] }] } }]),
    ).toBe("a b | c");
  });
});

describe("Dokümanlar okuma ve arama", () => {
  it("bağlantıdan kimlik çıkarılır ve kodlanır; ayrıntı başlığı taşır", async () => {
    const ctx = fakeCtx(() => ({ documentId: "doc-1", body: { content: [para("x\n")] } }));
    const r = await GDOCS_SERVICE.call(ctx, "read_document", {
      documentId: "https://docs.google.com/document/d/doc-1/edit?tab=t.0",
    });
    expect(callAt(ctx, 0).url.pathname).toBe("/v1/documents/doc-1");
    expect(textOf(r)).toBe("#  · id: doc-1\n\nx");
    expect(r.details).toEqual({ documentId: "doc-1", title: "" });
  });

  it("uzun belge kesilir; kimlik yoksa istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({
      documentId: "d",
      title: "T",
      body: { content: [para("y".repeat(MAX_READ_CHARS + 10))] },
    }));
    const t = textOf(await GDOCS_SERVICE.call(ctx, "read_document", { documentId: "d" }));
    expect(t).toContain(d.prompt.gdriveTruncated.replace("{{chars}}", String(MAX_READ_CHARS)));
    await expect(GDOCS_SERVICE.call(ctx, "read_document", {})).rejects.toThrow(
      d.errors.gdriveIdRequired,
    );
    expect(ctx.calls).toHaveLength(1);
  });

  it("arama Drive köküne belge türü ve klasörle gider; sorgu zorunlu", async () => {
    const ctx = fakeCtx(() => ({ files: [] }));
    await GDOCS_SERVICE.call(ctx, "search_documents", { query: "plan", folderId: "k" });
    const u = callAt(ctx, 0).url;
    expect(u.origin + u.pathname).toBe("https://drive.test/v3/files");
    expect(u.searchParams.get("q")).toBe(
      "(name contains 'plan' or fullText contains 'plan') and mimeType = 'application/vnd.google-apps.document' and 'k' in parents and trashed = false",
    );
    await expect(GDOCS_SERVICE.call(ctx, "search_documents", {})).rejects.toThrow(
      d.errors.gdriveQueryRequired,
    );
  });
});

describe("Dokümanlar yazma", () => {
  it("içeriksiz oluşturma tek POST atar ve düzenleme bağlantısı döner", async () => {
    const ctx = fakeCtx(() => ({ documentId: "n1" }));
    const r = await GDOCS_SERVICE.call(ctx, "create_document", { title: "  Rapor  " });
    expect(ctx.calls).toHaveLength(1);
    expect(callAt(ctx, 0).method).toBe("POST");
    expect(callAt(ctx, 0).body).toEqual({ title: "Rapor" });
    expect(r.details).toEqual({
      documentId: "n1",
      link: "https://docs.google.com/document/d/n1/edit",
    });
    expect(textOf(r)).toBe(
      `${d.prompt.gdocsCreated} Rapor · id: n1 · https://docs.google.com/document/d/n1/edit`,
    );
  });

  it("başlık yoksa istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GDOCS_SERVICE.call(ctx, "create_document", { title: " " })).rejects.toThrow(
      d.errors.gdocsTitleRequired,
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it("ekleme yalnız bitiş indeksini ister; boş belgeye satır sonu koymadan 1'e yazar", async () => {
    const ctx = fakeCtx((url) =>
      url.pathname.endsWith(":batchUpdate") ? {} : { documentId: "e", body: { content: [] } },
    );
    const r = await GDOCS_SERVICE.call(ctx, "append_text", { documentId: "e", content: "İlk" });
    expect(callAt(ctx, 0).url.searchParams.get("fields")).toBe("documentId,body.content.endIndex");
    const upd = callAt(ctx, 1);
    expect(upd.method).toBe("POST");
    expect(upd.url.pathname).toBe("/v1/documents/e:batchUpdate");
    expect(upd.body).toEqual({
      requests: [{ insertText: { location: { index: 1 }, text: "İlk" } }],
    });
    expect(r.details).toEqual({ documentId: "e", chars: 3 });
  });

  it("eklemede kimlik ya da içerik eksikse istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GDOCS_SERVICE.call(ctx, "append_text", { documentId: "e" })).rejects.toThrow(
      d.errors.gdocsAppendArgs,
    );
    await expect(GDOCS_SERVICE.call(ctx, "append_text", { content: "x" })).rejects.toThrow(
      d.errors.gdocsAppendArgs,
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it("oluşturma sonrası içerik yazımı başarısızsa hata yükselir", async () => {
    const ctx = fakeCtx((url) =>
      url.pathname.endsWith(":batchUpdate")
        ? googleError(400, "Invalid requests[0].insertText")
        : { documentId: "n2" },
    );
    const err = await GDOCS_SERVICE.call(ctx, "create_document", {
      title: "T",
      content: "x",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect(err).toMatchObject({ status: 400 });
    expect(ctx.calls.map((c) => c.url.pathname)).toEqual([
      "/v1/documents",
      "/v1/documents/n2:batchUpdate",
    ]);
  });

  it("probe Drive about ucunu kullanır; 401 taşınır", async () => {
    const ok = fakeCtx(() => ({ user: { emailAddress: "a@b.c" } }));
    await expect(GDOCS_SERVICE.probe(ok)).resolves.toBe("a@b.c");
    expect(callAt(ok, 0).url.href).toBe("https://drive.test/v3/about?fields=user");
    const un = fakeCtx(() => googleError(401, "x"));
    await expect(GDOCS_SERVICE.probe(un)).rejects.toMatchObject({ status: 401 });
  });
});
