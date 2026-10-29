import { describe, expect, it } from "vitest";
import { callAt, type FakeCall, fakeCtx, googleError, textOf } from "./native.fixture.js";
import { dict, MAX_READ_CHARS, NativeHttpError } from "./native.js";
import {
  DRIVE_TYPES,
  driveProbe,
  fileLine,
  GDRIVE_SERVICE,
  quote,
  searchQuery,
} from "./native-gdrive.js";

const d = dict("tr");

describe("Drive araç tanımları", () => {
  it("dört araç; arama/liste/okuma salt okunur, yükleme yazan araç", () => {
    const tools = GDRIVE_SERVICE.tools("tr");
    expect(tools.map((t) => t.name)).toEqual([
      "search_files",
      "list_recent_files",
      "read_file",
      "upload_file",
    ]);
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(ro).toEqual({
      search_files: true,
      list_recent_files: true,
      read_file: true,
      upload_file: undefined,
    });
  });

  it("arama şeması tür seçeneklerini sabit listeyle sunar; yükleme ad ve içerik ister", () => {
    const byName = Object.fromEntries(GDRIVE_SERVICE.tools("en").map((t) => [t.name, t]));
    const type = byName.search_files?.inputSchema.properties?.type as {
      anyOf: Array<{ const: string }>;
    };
    expect(type.anyOf.map((x) => x.const)).toEqual(Object.keys(DRIVE_TYPES));
    expect(byName.search_files?.inputSchema.required).toEqual(["query"]);
    expect(byName.upload_file?.inputSchema.required).toEqual(["name", "content"]);
    expect(byName.read_file?.inputSchema.required).toEqual(["fileId"]);
  });
});

describe("Drive sorgu dizgesi", () => {
  it("tek tırnak ve ters bölü kaçırılır (sorgu enjeksiyonu yok)", () => {
    expect(quote("O'Brien")).toBe("'O\\'Brien'");
    expect(quote("a\\b")).toBe("'a\\\\b'");
    expect(quote("x' or name contains '")).toBe("'x\\' or name contains \\''");
  });

  it("ad+içerik araması türe ve klasöre daraltılır, çöp hariç tutulur", () => {
    expect(searchQuery("rapor")).toBe(
      "(name contains 'rapor' or fullText contains 'rapor') and trashed = false",
    );
    expect(searchQuery("rapor", "pdf", "klasor1")).toBe(
      "(name contains 'rapor' or fullText contains 'rapor') and mimeType = 'application/pdf' and 'klasor1' in parents and trashed = false",
    );
  });

  it("dosya satırı Google türünü kısaltır ve isteğe bağlı alanları ekler", () => {
    expect(fileLine({ id: "1", name: "A", mimeType: "application/vnd.google-apps.folder" })).toBe(
      "- A (google:folder) · id: 1",
    );
    expect(
      fileLine({
        id: "2",
        name: "B",
        mimeType: "text/plain",
        modifiedTime: "2026-09-26T10:00:00Z",
        size: "12",
        webViewLink: "https://drive/x",
      }),
    ).toBe("- B (text/plain) · id: 2 · 2026-09-26 · 12 B · https://drive/x");
  });
});

describe("Drive arama ve liste", () => {
  it("files.list parametreleri: sıralama, alanlar, paylaşılan sürücüler, sınır", async () => {
    const ctx = fakeCtx(() => ({ files: [] }));
    const r = await GDRIVE_SERVICE.call(ctx, "search_files", {
      query: "bütçe",
      type: "spreadsheet",
      limit: 99,
    });
    expect(textOf(r)).toBe(d.prompt.gdriveNone);
    const u = callAt(ctx, 0).url;
    expect(u.pathname).toBe("/v1/files");
    expect(u.searchParams.get("pageSize")).toBe("50");
    expect(u.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(u.searchParams.get("fields")).toBe(
      "files(id,name,mimeType,modifiedTime,size,webViewLink)",
    );
    expect(u.searchParams.get("supportsAllDrives")).toBe("true");
    expect(u.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(u.searchParams.get("q")).toContain(
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
    );
  });

  it("geçersiz tür yok sayılır; sorgu yoksa istek atılmaz", async () => {
    const ctx = fakeCtx(() => ({ files: [] }));
    await GDRIVE_SERVICE.call(ctx, "search_files", { query: "x", type: "constructor" });
    expect(callAt(ctx, 0).url.searchParams.get("q")).not.toContain("mimeType");
    await expect(GDRIVE_SERVICE.call(ctx, "search_files", { query: " " })).rejects.toThrow(
      d.errors.gdriveQueryRequired,
    );
    expect(ctx.calls).toHaveLength(1);
  });

  it("son dosyalar: yalnız çöp filtresi, klasör verilirse eklenir; sonuç satır listesi", async () => {
    const files = [
      { id: "f1", name: "Not", mimeType: "text/plain" },
      { id: "f2", name: "Tablo", mimeType: "application/vnd.google-apps.spreadsheet" },
    ];
    const ctx = fakeCtx(() => ({ files }));
    await GDRIVE_SERVICE.call(ctx, "list_recent_files", {});
    const r = await GDRIVE_SERVICE.call(ctx, "list_recent_files", { folderId: "k1", limit: 5 });
    expect(callAt(ctx, 0).url.searchParams.get("q")).toBe("trashed = false");
    expect(callAt(ctx, 0).url.searchParams.get("pageSize")).toBe("20");
    expect(callAt(ctx, 1).url.searchParams.get("q")).toBe("trashed = false and 'k1' in parents");
    expect(textOf(r)).toBe("- Not (text/plain) · id: f1\n- Tablo (google:spreadsheet) · id: f2");
    expect(r.details).toEqual({ files });
  });
});

describe("Drive okuma", () => {
  /** Meta veri yanıtı `mimeType`e göre, içerik yanıtı sabit metin. */
  function readCtx(mimeType: string, content = "içerik", webViewLink?: string) {
    return fakeCtx((url) => {
      if (url.pathname.endsWith("/export") || url.searchParams.get("alt") === "media")
        return new Response(content, { status: 200 });
      return { id: "f1", name: "Dosya", mimeType, ...(webViewLink ? { webViewLink } : {}) };
    });
  }

  it.each([
    ["application/vnd.google-apps.document", "text/markdown"],
    ["application/vnd.google-apps.spreadsheet", "text/csv"],
    ["application/vnd.google-apps.presentation", "text/plain"],
  ])("Google türü %s, %s olarak dışa aktarılır", async (mime, format) => {
    const ctx = readCtx(mime);
    const r = await GDRIVE_SERVICE.call(ctx, "read_file", { fileId: "f1" });
    const meta = callAt(ctx, 0).url;
    expect(meta.pathname).toBe("/v1/files/f1");
    expect(meta.searchParams.get("supportsAllDrives")).toBe("true");
    const exp = callAt(ctx, 1).url;
    expect(exp.pathname).toBe("/v1/files/f1/export");
    expect(exp.searchParams.get("mimeType")).toBe(format);
    expect(textOf(r)).toContain("\n\niçerik");
    expect(r.details).toMatchObject({ truncated: false });
  });

  it.each(["text/plain", "application/json", "application/x-sh", "text/csv"])(
    "metin türü %s doğrudan indirilir (alt=media)",
    async (mime) => {
      const ctx = readCtx(mime);
      await GDRIVE_SERVICE.call(ctx, "read_file", {
        fileId: "https://drive.google.com/file/d/f1/view",
      });
      const u = callAt(ctx, 1).url;
      expect(u.pathname).toBe("/v1/files/f1");
      expect(u.searchParams.get("alt")).toBe("media");
    },
  );

  it("ikili dosya ve dışa aktarılamayan Google türü içerik istemeden bağlantı döner", async () => {
    for (const mime of ["image/png", "application/vnd.google-apps.form"]) {
      const ctx = readCtx(mime, "", "https://drive/v");
      const r = await GDRIVE_SERVICE.call(ctx, "read_file", { fileId: "f1" });
      expect(ctx.calls).toHaveLength(1);
      expect(textOf(r)).toContain(d.prompt.gdriveBinary.replace("{{link}}", "https://drive/v"));
      expect(r.details).toMatchObject({ content: null });
    }
  });

  it("uzun içerik kesilir ve ayrıntıda işaretlenir", async () => {
    const ctx = readCtx("text/plain", "z".repeat(MAX_READ_CHARS + 1));
    const r = await GDRIVE_SERVICE.call(ctx, "read_file", { fileId: "f1" });
    expect(textOf(r)).toContain(
      d.prompt.gdriveTruncated.replace("{{chars}}", String(MAX_READ_CHARS)),
    );
    expect(r.details).toMatchObject({ truncated: true });
  });

  it("kimlik yoksa hata; içerik isteği başarısızsa durum kodlu hata", async () => {
    const none = fakeCtx(() => ({}));
    await expect(GDRIVE_SERVICE.call(none, "read_file", {})).rejects.toThrow(
      d.errors.gdriveIdRequired,
    );
    const ctx = fakeCtx((url) =>
      url.searchParams.get("alt") === "media"
        ? googleError(403, "cannotDownloadAbusiveFile")
        : { id: "f1", name: "x", mimeType: "text/plain" },
    );
    const err = await GDRIVE_SERVICE.call(ctx, "read_file", { fileId: "f1" }).catch((e) => e);
    expect(err).toBeInstanceOf(NativeHttpError);
    expect(err).toMatchObject({ status: 403 });
    expect((err as Error).message).toContain("cannotDownloadAbusiveFile");
  });

  it("kimlik URL'de kodlanır", async () => {
    const ctx = readCtx("image/png");
    await GDRIVE_SERVICE.call(ctx, "read_file", { fileId: "a b?c" });
    expect(callAt(ctx, 0).url.pathname).toBe("/v1/files/a%20b%3Fc");
  });
});

describe("Drive yükleme", () => {
  function uploadCtx() {
    const base = fakeCtx(() => ({ id: "u1", name: "not.md", mimeType: "text/markdown" }));
    return { ...base, baseUrl: "https://www.googleapis.com/drive/v3" };
  }

  function parts(call: FakeCall): { boundary: string; sections: string[] } {
    const ct = call.headers.get("content-type") ?? "";
    const boundary = /boundary=(.+)$/.exec(ct)?.[1] ?? "";
    const sections = (call.rawBody ?? "").split(`--${boundary}`);
    return { boundary, sections };
  }

  it("çok parçalı gövde: meta JSON + içerik, yükleme uç adresine POST", async () => {
    const ctx = uploadCtx();
    const r = await GDRIVE_SERVICE.call(ctx, "upload_file", {
      name: "not.md",
      content: "# Başlık",
      mimeType: "text/markdown",
      folderId: "k1",
    });
    const c = callAt(ctx, 0);
    expect(c.method).toBe("POST");
    expect(c.url.origin + c.url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files");
    expect(c.url.searchParams.get("uploadType")).toBe("multipart");
    expect(c.url.searchParams.get("supportsAllDrives")).toBe("true");
    const { boundary, sections } = parts(c);
    expect(boundary).toMatch(/^codezal-/);
    expect(sections).toHaveLength(4);
    expect(sections[1]).toBe(
      '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"not.md","parents":["k1"]}\r\n',
    );
    expect(sections[2]).toBe("\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n# Başlık\r\n");
    expect(sections[3]).toBe("--\r\n");
    expect(textOf(r)).toBe(`${d.prompt.gdriveUploaded}\n- not.md (text/markdown) · id: u1`);
  });

  it("Google Dokümanı'na dönüştürme hedef türü meta veriye yazar; varsayılan tür text/plain", async () => {
    const ctx = uploadCtx();
    await GDRIVE_SERVICE.call(ctx, "upload_file", { name: "a", content: "", asGoogleDoc: true });
    const { sections } = parts(callAt(ctx, 0));
    expect(sections[1]).toContain('{"name":"a","mimeType":"application/vnd.google-apps.document"}');
    expect(sections[2]).toContain("Content-Type: text/plain; charset=UTF-8");
  });

  it("ad ya da içerik eksikse istek atılmaz", async () => {
    const ctx = uploadCtx();
    await expect(GDRIVE_SERVICE.call(ctx, "upload_file", { name: "a" })).rejects.toThrow(
      d.errors.gdriveUploadArgs,
    );
    await expect(GDRIVE_SERVICE.call(ctx, "upload_file", { content: "x" })).rejects.toThrow(
      d.errors.gdriveUploadArgs,
    );
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("Drive bağlantı denetimi", () => {
  it("about?fields=user; e-posta yoksa görünen ad, o da yoksa null", async () => {
    let user: unknown = { displayName: "Ayşe" };
    const ctx = fakeCtx(() => ({ user }));
    await expect(GDRIVE_SERVICE.probe(ctx)).resolves.toBe("Ayşe");
    expect(callAt(ctx, 0).url.href).toBe("https://api.test/v1/about?fields=user");
    user = undefined;
    await expect(driveProbe(ctx, ctx.driveUrl)).resolves.toBeNull();
    expect(callAt(ctx, 1).url.host).toBe("drive.test");
  });

  it("401 durum kodu taşınır", async () => {
    const ctx = fakeCtx(() => googleError(401, "Invalid Credentials"));
    await expect(GDRIVE_SERVICE.probe(ctx)).rejects.toMatchObject({ status: 401 });
  });
});
