import { describe, expect, it } from "vitest";
import { callAt, fakeCtx, googleError, textOf } from "./native.fixture.js";
import { dict, NativeHttpError } from "./native.js";
import { GSLIDES_SERVICE, slideText } from "./native-gslides.js";

const d = dict("tr");

interface SlideRequests {
  requests: Array<{
    createSlide?: {
      objectId: string;
      placeholderIdMappings: Array<{ layoutPlaceholder: { type: string }; objectId: string }>;
    };
    insertText?: { objectId: string; insertionIndex: number; text: string };
  }>;
}

const run = (content: string) => ({ textRun: { content } });

describe("Slaytlar araç tanımları", () => {
  it("arama/okuma salt okunur; oluşturma ve slayt ekleme yazan araç", () => {
    expect(
      GSLIDES_SERVICE.tools("tr").map((t) => [t.name, t.annotations?.readOnlyHint ?? false]),
    ).toEqual([
      ["search_presentations", true],
      ["read_presentation", true],
      ["create_presentation", false],
      ["add_slide", false],
    ]);
    const byName = Object.fromEntries(GSLIDES_SERVICE.tools("en").map((t) => [t.name, t]));
    expect(byName.add_slide?.inputSchema.required).toEqual(["presentationId", "title"]);
  });
});

describe("slideText", () => {
  it("boş şekiller atlanır, metin kırpılır, tablo hücreleri birleşir", () => {
    expect(
      slideText({
        objectId: "s",
        pageElements: [
          { shape: { text: { textElements: [run("  Başlık\n")] } } },
          { shape: {} },
          { shape: { text: { textElements: [run("   ")] } } },
          {
            table: {
              tableRows: [{ tableCells: [{ text: { textElements: [run("a"), run("b")] } }, {}] }],
            },
          },
        ],
      }),
    ).toBe("Başlık\nab | ");
    expect(slideText({ objectId: "bos" })).toBe("");
  });
});

describe("Slaytlar okuma ve oluşturma", () => {
  it("okuma yalnız metin alanlarını ister; slaytsız sunu 0 slayt der", async () => {
    const ctx = fakeCtx(() => ({ presentationId: "p", title: "Boş" }));
    const r = await GSLIDES_SERVICE.call(ctx, "read_presentation", {
      presentationId: "https://docs.google.com/presentation/d/p/edit",
    });
    const u = callAt(ctx, 0).url;
    expect(u.pathname).toBe("/v1/presentations/p");
    expect(u.searchParams.get("fields")).toBe(
      "presentationId,title,slides(objectId,pageElements(shape.text.textElements.textRun.content,table.tableRows.tableCells.text.textElements.textRun.content))",
    );
    expect(textOf(r)).toBe(`# Boş · id: p · 0 ${d.prompt.gslidesSlides}\n\n`);
    expect(r.details).toEqual({ presentationId: "p", title: "Boş", slides: 0 });
  });

  it("kimlik yoksa okuma, başlık yoksa oluşturma istek atmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GSLIDES_SERVICE.call(ctx, "read_presentation", {})).rejects.toThrow(
      d.errors.gdriveIdRequired,
    );
    await expect(GSLIDES_SERVICE.call(ctx, "create_presentation", {})).rejects.toThrow(
      d.errors.gdocsTitleRequired,
    );
    expect(ctx.calls).toHaveLength(0);
  });

  it("oluşturma POST gövdesi başlığı taşır ve düzenleme bağlantısı döner", async () => {
    const ctx = fakeCtx(() => ({ presentationId: "n1" }));
    const r = await GSLIDES_SERVICE.call(ctx, "create_presentation", { title: "Sunum" });
    expect(callAt(ctx, 0).method).toBe("POST");
    expect(callAt(ctx, 0).url.pathname).toBe("/v1/presentations");
    expect(callAt(ctx, 0).body).toEqual({ title: "Sunum" });
    expect(r.details).toEqual({
      presentationId: "n1",
      link: "https://docs.google.com/presentation/d/n1/edit",
    });
  });
});

describe("Slayt ekleme", () => {
  it("nesne kimlikleri geçerli biçimde ve benzersiz; yer tutucu eşlemesi metin eklemeyle tutarlı", async () => {
    const ctx = fakeCtx(() => ({}));
    const r = await GSLIDES_SERVICE.call(ctx, "add_slide", {
      presentationId: "p",
      title: "Özet",
      body: "madde",
    });
    const { requests } = callAt(ctx, 0).body as SlideRequests;
    const create = requests[0]?.createSlide;
    if (!create) throw new Error("createSlide yok");
    const [titleMap, bodyMap] = create.placeholderIdMappings;
    const ids = [create.objectId, titleMap?.objectId, bodyMap?.objectId];
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_]{5,50}$/);
    expect(new Set(ids).size).toBe(3);
    expect(titleMap?.layoutPlaceholder.type).toBe("TITLE");
    expect(bodyMap?.layoutPlaceholder.type).toBe("BODY");
    expect(requests[1]?.insertText).toEqual({
      objectId: titleMap?.objectId,
      insertionIndex: 0,
      text: "Özet",
    });
    expect(requests[2]?.insertText?.objectId).toBe(bodyMap?.objectId);
    expect(r.details).toEqual({ presentationId: "p", slideId: create.objectId });
    expect(textOf(r)).toBe(`${d.prompt.gslidesAdded} Özet · slide id: ${create.objectId}`);
  });

  it("gövde yoksa gövde metni isteği eklenmez; ardışık çağrılarda kimlikler değişir", async () => {
    const ctx = fakeCtx(() => ({}));
    await GSLIDES_SERVICE.call(ctx, "add_slide", { presentationId: "p", title: "A" });
    await GSLIDES_SERVICE.call(ctx, "add_slide", { presentationId: "p", title: "B" });
    const first = (callAt(ctx, 0).body as SlideRequests).requests;
    const second = (callAt(ctx, 1).body as SlideRequests).requests;
    expect(first).toHaveLength(2);
    expect(first[0]?.createSlide?.objectId).not.toBe(second[0]?.createSlide?.objectId);
    expect(callAt(ctx, 0).url.pathname).toBe("/v1/presentations/p:batchUpdate");
  });

  it("batchUpdate hatası durum koduyla yükselir", async () => {
    const ctx = fakeCtx(() => googleError(404, "Requested entity was not found."));
    const err = await GSLIDES_SERVICE.call(ctx, "add_slide", {
      presentationId: "yok",
      title: "A",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect(err).toMatchObject({ status: 404 });
  });

  it("arama Drive'a sunu türüyle gider; probe Drive about", async () => {
    const ctx = fakeCtx((url) =>
      url.pathname.endsWith("/about") ? { user: { emailAddress: "a@b.c" } } : { files: [] },
    );
    await GSLIDES_SERVICE.call(ctx, "search_presentations", { query: "q", limit: 2 });
    const u = callAt(ctx, 0).url;
    expect(u.host).toBe("drive.test");
    expect(u.searchParams.get("pageSize")).toBe("2");
    expect(u.searchParams.get("q")).toContain(
      "mimeType = 'application/vnd.google-apps.presentation'",
    );
    await expect(GSLIDES_SERVICE.probe(ctx)).resolves.toBe("a@b.c");
  });
});
