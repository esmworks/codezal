import { describe, expect, it } from "vitest";
import { callAt, fakeCtx, googleError, textOf } from "./native.fixture.js";
import { dict, NativeHttpError } from "./native.js";
import { GSHEETS_SERVICE } from "./native-gsheets.js";

const d = dict("tr");

/** Değer yolunun (URL'de kodlanmış) çözülmüş hali. */
const valuesPath = (u: URL) => decodeURIComponent(u.pathname);

describe("E-Tablolar araç tanımları", () => {
  it("arama/okuma salt okunur; yazma, ekleme ve oluşturma yazan araç", () => {
    expect(
      GSHEETS_SERVICE.tools("tr").map((t) => [t.name, t.annotations?.readOnlyHint ?? false]),
    ).toEqual([
      ["search_spreadsheets", true],
      ["read_sheet", true],
      ["write_cells", false],
      ["append_rows", false],
      ["create_spreadsheet", false],
    ]);
  });

  it("değer şeması satır dizisi; hücre dize/sayı/mantıksal/null olabilir", () => {
    const byName = Object.fromEntries(GSHEETS_SERVICE.tools("en").map((t) => [t.name, t]));
    expect(byName.write_cells?.inputSchema.required).toEqual(["spreadsheetId", "range", "values"]);
    expect(byName.append_rows?.inputSchema.required).toEqual(["spreadsheetId", "values"]);
    const v = byName.write_cells?.inputSchema.properties?.values as {
      type: string;
      items: { type: string; items: { anyOf: Array<{ type: string }> } };
    };
    expect(v.type).toBe("array");
    expect(v.items.items.anyOf.map((x) => x.type)).toEqual(["string", "number", "boolean", "null"]);
  });
});

describe("E-Tablolar okuma", () => {
  it("meta veri alanları sınırlı istenir; sayfa adındaki tırnak A1 kuralıyla ikilenir", async () => {
    const ctx = fakeCtx((url) =>
      url.pathname.includes("/values/")
        ? { values: [["x"]] }
        : { spreadsheetId: "s", sheets: [{ properties: { title: "Ali'nin sayfası" } }] },
    );
    await GSHEETS_SERVICE.call(ctx, "read_sheet", { spreadsheetId: "s" });
    expect(callAt(ctx, 0).url.searchParams.get("fields")).toBe(
      "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties",
    );
    expect(valuesPath(callAt(ctx, 1).url)).toBe(
      "/v1/spreadsheets/s/values/'Ali''nin sayfası'!A1:Z200",
    );
  });

  it("sayfa yoksa Sheet1; aralık verilirse aynen kullanılır; boş aralık metni", async () => {
    const ctx = fakeCtx((url) =>
      url.pathname.includes("/values/") ? {} : { spreadsheetId: "s", properties: { title: "T" } },
    );
    const r1 = await GSHEETS_SERVICE.call(ctx, "read_sheet", { spreadsheetId: "s" });
    expect(valuesPath(callAt(ctx, 1).url)).toBe("/v1/spreadsheets/s/values/'Sheet1'!A1:Z200");
    expect(textOf(r1)).toBe(
      `# T · id: s\n${d.prompt.gsheetsSheets} \n${d.prompt.gsheetsRange} 'Sheet1'!A1:Z200\n\n${d.prompt.gsheetsEmpty}`,
    );
    const r2 = await GSHEETS_SERVICE.call(ctx, "read_sheet", {
      spreadsheetId: "s",
      range: "B2:C3",
    });
    expect(valuesPath(callAt(ctx, 3).url)).toBe("/v1/spreadsheets/s/values/B2:C3");
    expect(r2.details).toEqual({ spreadsheetId: "s", sheets: [], range: "B2:C3", rows: 0 });
  });

  it("200 satırdan fazlası kesilir ve kalan satır sayısı bildirilir; null hücre boş yazılır", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => [i, null, true]);
    const ctx = fakeCtx((url) =>
      url.pathname.includes("/values/")
        ? { range: "A1:C205", values: rows }
        : { spreadsheetId: "s" },
    );
    const t = textOf(await GSHEETS_SERVICE.call(ctx, "read_sheet", { spreadsheetId: "s" }));
    expect(t).toContain("1: 0 |  | true");
    expect(t).toContain("200: 199 |  | true");
    expect(t).not.toContain("201: ");
    expect(t).toContain(d.prompt.gsheetsMore.replace("{{count}}", "5"));
  });

  it("kimlik yoksa istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    await expect(GSHEETS_SERVICE.call(ctx, "read_sheet", {})).rejects.toThrow(
      d.errors.gdriveIdRequired,
    );
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("E-Tablolar yazma", () => {
  it("write_cells: PUT, USER_ENTERED, gövde aralık ve satır boyutunu taşır; hücreler dizgeye iner", async () => {
    const ctx = fakeCtx(() => ({ updatedRange: "Sayfa1!A1:C1", updatedCells: 3 }));
    const r = await GSHEETS_SERVICE.call(ctx, "write_cells", {
      spreadsheetId: "https://docs.google.com/spreadsheets/d/s1/edit",
      range: "Sayfa1!A1",
      values: [[1, { a: 1 }, null], "tek"],
    });
    const c = callAt(ctx, 0);
    expect(c.method).toBe("PUT");
    expect(valuesPath(c.url)).toBe("/v1/spreadsheets/s1/values/Sayfa1!A1");
    expect(c.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(c.body).toEqual({
      range: "Sayfa1!A1",
      majorDimension: "ROWS",
      values: [[1, "[object Object]", null], ["tek"]],
    });
    expect(textOf(r)).toBe(`${d.prompt.gsheetsWritten} Sayfa1!A1:C1 · 3 ${d.prompt.gsheetsCells}`);
  });

  it("write_cells: aralık, kimlik ya da satır eksikse istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({}));
    for (const args of [
      { spreadsheetId: "s", values: [["a"]] },
      { range: "A1", values: [["a"]] },
      { spreadsheetId: "s", range: "A1", values: "a" },
    ])
      await expect(GSHEETS_SERVICE.call(ctx, "write_cells", args)).rejects.toThrow(
        d.errors.gsheetsWriteArgs,
      );
    expect(ctx.calls).toHaveLength(0);
  });

  it("append_rows: aralık verilirse meta veri istenmez; yanıt yoksa satır sayısı girdiden", async () => {
    const ctx = fakeCtx(() => ({}));
    const r = await GSHEETS_SERVICE.call(ctx, "append_rows", {
      spreadsheetId: "s",
      range: "Veri!A:B",
      values: [["a"], ["b"]],
    });
    expect(ctx.calls).toHaveLength(1);
    const c = callAt(ctx, 0);
    expect(c.method).toBe("POST");
    expect(valuesPath(c.url)).toBe("/v1/spreadsheets/s/values/Veri!A:B:append");
    expect(c.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(c.body).toEqual({ majorDimension: "ROWS", values: [["a"], ["b"]] });
    expect(textOf(r)).toBe(`${d.prompt.gsheetsAppended} Veri!A:B · 2 ${d.prompt.gsheetsRows}`);
  });

  it("create_spreadsheet: değer yoksa tek istek; bağlantı yoksa düzenleme adresi üretilir", async () => {
    const ctx = fakeCtx(() => ({ spreadsheetId: "n1" }));
    const r = await GSHEETS_SERVICE.call(ctx, "create_spreadsheet", { title: "Yeni" });
    expect(ctx.calls).toHaveLength(1);
    expect(callAt(ctx, 0).body).toEqual({ properties: { title: "Yeni" } });
    expect(r.details).toEqual({
      spreadsheetId: "n1",
      link: "https://docs.google.com/spreadsheets/d/n1/edit",
    });
    await expect(GSHEETS_SERVICE.call(ctx, "create_spreadsheet", {})).rejects.toThrow(
      d.errors.gdocsTitleRequired,
    );
  });

  it("create_spreadsheet: değerler ilk sayfanın A1'ine yazılır (sayfa adı yoksa Sheet1)", async () => {
    const ctx = fakeCtx(() => ({ spreadsheetId: "n2" }));
    await GSHEETS_SERVICE.call(ctx, "create_spreadsheet", { title: "Y", values: [["a"]] });
    expect(valuesPath(callAt(ctx, 1).url)).toBe("/v1/spreadsheets/n2/values/'Sheet1'!A1");
  });
});

describe("E-Tablolar arama, bağlantı denetimi ve hatalar", () => {
  it("arama Drive'a e-tablo türüyle gider", async () => {
    const ctx = fakeCtx(() => ({ files: [] }));
    await GSHEETS_SERVICE.call(ctx, "search_spreadsheets", { query: "bütçe" });
    const u = callAt(ctx, 0).url;
    expect(u.host).toBe("drive.test");
    expect(u.searchParams.get("q")).toContain(
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
    );
  });

  it("probe Drive about ucunu kullanır", async () => {
    const ctx = fakeCtx(() => ({ user: { emailAddress: "a@b.c" } }));
    await expect(GSHEETS_SERVICE.probe(ctx)).resolves.toBe("a@b.c");
    expect(callAt(ctx, 0).url.host).toBe("drive.test");
  });

  it("değer yazımında 400/401 durum kodlu hata olarak yükselir", async () => {
    const bad = fakeCtx(() => googleError(400, "Unable to parse range: Yok!A1"));
    const err = await GSHEETS_SERVICE.call(bad, "write_cells", {
      spreadsheetId: "s",
      range: "Yok!A1",
      values: [["a"]],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect((err as Error).message).toContain("Unable to parse range");
    const un = fakeCtx(() => googleError(401, "x"));
    await expect(
      GSHEETS_SERVICE.call(un, "read_sheet", { spreadsheetId: "s" }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
