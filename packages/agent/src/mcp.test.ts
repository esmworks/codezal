import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accountFromIdToken,
  agentToolName,
  assertConnectorUrl,
  canonicalJson,
  catalogLine,
  catalogText,
  DIRECT_TOOL_LIMIT,
  McpManager,
  matchTools,
  mentionedConnectors,
  RESOURCES_TOOL,
  TOOL_SEARCH_TOOL,
  toAgentContent,
} from "./mcp.js";
import { unwrapUntrusted } from "./untrusted.js";

const root = mkdtempSync(join(tmpdir(), "codezal-mcp-"));

/** Test sunucusu: /mcp uç noktası, isteğe bağlı Bearer zorunluluğu ve küçük bir OAuth taklidi. */
interface TestServer {
  base: string;
  close: () => Promise<void>;
  requireToken: string | null;
  registered: number;
  tokensIssued: number;
  /** true: initialize ve tools/list belirteçsiz geçer, yalnızca tools/call 401 döner (Google gibi). */
  openInitialize: boolean;
  /** false: /register 404 ve metadata'da registration_endpoint yok (Google gibi). */
  allowDcr: boolean;
  /** Belirteç uç noktasının istediği client_secret (kendi istemci akışı). */
  requiredSecret: string | null;
  lastTokenForm: URLSearchParams | null;
  /** Ayarlıysa kod takası bu yenileme belirtecini de verir ve `refresh_token` grant'ı kabul edilir. */
  refreshToken: string | null;
  /** Ayarlıysa kod takası OIDC `id_token` da verir (hesap adı için). */
  idToken: string | null;
  /** Drive API taklidi (`/drive/v3`): son liste sorgusu, dışa aktarma biçimi ve yükleme gövdesi. */
  lastDriveQuery: string | null;
  lastExportMime: string | null;
  lastUpload: string | null;
  /** Tarayıcı taklidi: yetki adresinden yönlendirme adresini alıp kodla geri döner. */
  authorize: (authorizeUrl: string) => Promise<number>;
}

function mcpHandler() {
  return createMcpHandler(
    () => {
      const s = new McpServer({ name: "test", version: "1.0.0" });
      s.registerTool(
        "echo",
        {
          description: "Metni geri döndürür",
          inputSchema: { text: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ text }) => ({ content: [{ type: "text", text: `yankı: ${text}` }] }),
      );
      s.registerTool("fail", { description: "Hep hata" }, async () => ({
        content: [{ type: "text", text: "olmadı" }],
        isError: true,
      }));
      return s;
    },
    { legacy: "stateless" },
  );
}

/** Sınırı aşan sayıda araç: erteleme ve katalog testleri için (count + 1 araç döner). */
function manyToolsHandler(count = DIRECT_TOOL_LIMIT + 4) {
  return createMcpHandler(
    () => {
      const s = new McpServer({ name: "buyuk", version: "1.0.0" });
      for (let i = 1; i <= count; i += 1)
        s.registerTool(`arac_${i}`, { description: `Deneme aracı ${i}` }, async () => ({
          content: [{ type: "text", text: String(i) }],
        }));
      s.registerTool(
        "etkinlik_olustur",
        {
          description: "Takvimde etkinlik oluşturur. Başlık, tarih ve saat ister.",
          inputSchema: { title: z.string() },
        },
        async ({ title }) => ({ content: [{ type: "text", text: `oluşturuldu: ${title}` }] }),
      );
      return s;
    },
    { legacy: "stateless" },
  );
}

const DRIVE_FILES = [
  {
    id: "doc1",
    name: "Plan",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-09-11T10:00:00Z",
    webViewLink: "https://docs.google.com/document/d/doc1",
  },
  { id: "txt1", name: "notlar.txt", mimeType: "text/plain", size: "13" },
  { id: "bin1", name: "logo.png", mimeType: "image/png", size: "4096" },
];

/** Drive API taklidi: about, files (liste, meta veri, alt=media, export) ve çok parçalı yükleme. */
function driveHandler(
  state: TestServer,
  url: URL,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
): void {
  if (req.headers.authorization !== `Bearer ${state.requireToken}`) {
    json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
    return;
  }
  const path = url.pathname;
  if (path === "/drive/v3/about") {
    json(res, 200, { user: { emailAddress: "test@example.com" } });
    return;
  }
  if (path === "/drive/v3/files" && req.method === "GET") {
    state.lastDriveQuery = url.searchParams.get("q");
    json(res, 200, { files: DRIVE_FILES });
    return;
  }
  if (path === "/upload/drive/v3/files" && req.method === "POST") {
    state.lastUpload = body.toString("utf8");
    const metaJson = /\r\n\r\n(\{.*?\})\r\n/s.exec(state.lastUpload)?.[1] ?? "{}";
    const meta = JSON.parse(metaJson) as { name?: string };
    json(res, 200, { id: "yeni1", name: meta.name ?? "?", mimeType: "text/markdown" });
    return;
  }
  const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
  const file = m ? DRIVE_FILES.find((f) => f.id === m[1]) : undefined;
  if (!m || !file) {
    json(res, 404, { error: { code: 404, message: "File not found" } });
    return;
  }
  if (m[2]) {
    state.lastExportMime = url.searchParams.get("mimeType");
    res.writeHead(200, { "content-type": "text/markdown" });
    res.end("# Plan\n\nİlk madde");
    return;
  }
  if (url.searchParams.get("alt") === "media") {
    res.writeHead(200, { "content-type": file.mimeType });
    res.end("merhaba drive");
    return;
  }
  json(res, 200, file);
}

/** Servis sonucu güvenilmez veri zarfıyla gelir; testler içeriği karşılaştırır. */
function textOf(result: AgentToolResult<unknown>): string {
  return unwrapUntrusted(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startServer(handler = mcpHandler()): Promise<TestServer> {
  const codes = new Set<string>();
  const state: TestServer = {
    base: "",
    close: async () => {},
    requireToken: null,
    openInitialize: false,
    registered: 0,
    tokensIssued: 0,
    allowDcr: true,
    requiredSecret: null,
    lastTokenForm: null,
    refreshToken: null,
    idToken: null,
    lastDriveQuery: null,
    lastExportMime: null,
    lastUpload: null,
    authorize: async (authorizeUrl) => {
      const u = new URL(authorizeUrl);
      const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
      const code = randomUUID();
      codes.add(code);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
      redirect.searchParams.set("iss", state.base);
      const r = await fetch(redirect);
      return r.status;
    },
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.base);
    const body = await readBody(req);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: `${state.base}/mcp`, authorization_servers: [state.base] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: state.base,
        authorization_endpoint: `${state.base}/authorize`,
        token_endpoint: `${state.base}/token`,
        ...(state.allowDcr ? { registration_endpoint: `${state.base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        // Google gibi kendi istemcili sunucular gizli anahtarı gövdede ister.
        token_endpoint_auth_methods_supported: state.allowDcr ? ["none"] : ["client_secret_post"],
      });
      return;
    }
    if (url.pathname === "/register") {
      if (!state.allowDcr) {
        res.writeHead(404).end();
        return;
      }
      state.registered += 1;
      const meta = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      json(res, 201, { ...meta, client_id: "codezal-test-client" });
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body.toString("utf8"));
      state.lastTokenForm = form;
      const code = form.get("code") ?? "";
      if (state.requiredSecret && form.get("client_secret") !== state.requiredSecret) {
        json(res, 401, { error: "invalid_client" });
        return;
      }
      const refresh = state.refreshToken ? { refresh_token: state.refreshToken } : {};
      if (form.get("grant_type") === "refresh_token") {
        if (!state.refreshToken || form.get("refresh_token") !== state.refreshToken) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        // Taze belirteç: o an beklenen belirteç (test bunu değiştirip süre dolmasını taklit eder).
        json(res, 200, {
          access_token: state.requireToken,
          token_type: "bearer",
          expires_in: 3600,
          ...refresh,
        });
        return;
      }
      if (form.get("grant_type") !== "authorization_code" || !codes.delete(code)) {
        json(res, 400, { error: "invalid_grant" });
        return;
      }
      state.tokensIssued += 1;
      json(res, 200, {
        access_token: "gizli-belirtec",
        token_type: "bearer",
        expires_in: 3600,
        ...refresh,
        ...(state.idToken ? { id_token: state.idToken } : {}),
      });
      return;
    }
    if (url.pathname.startsWith("/drive/v3/") || url.pathname.startsWith("/upload/drive/v3/")) {
      driveHandler(state, url, req, body, res);
      return;
    }
    if (url.pathname === "/mcp") {
      const method = state.openInitialize
        ? (JSON.parse(body.toString("utf8") || "{}") as { method?: string }).method
        : undefined;
      const open = state.openInitialize && method !== "tools/call";
      if (
        !open &&
        state.requireToken &&
        req.headers.authorization !== `Bearer ${state.requireToken}`
      ) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  state.close = async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer();
});

afterAll(async () => {
  await srv.close();
  rmSync(root, { recursive: true, force: true });
});

describe("yardımcılar", () => {
  it("araç adını ajan için güvenli hale getirir", () => {
    expect(agentToolName("Notion Çalışma Alanı", "search-pages")).toBe(
      "mcp_notion_calisma_alani_search_pages",
    );
    expect(agentToolName("", "")).toBe("mcp_sunucu_arac");
    expect(agentToolName("a".repeat(80), "b").length).toBeLessThanOrEqual(64);
  });

  it("adresi doğrular: https ya da yerel http", () => {
    expect(assertConnectorUrl("https://mcp.ornek.dev/mcp").href).toBe("https://mcp.ornek.dev/mcp");
    expect(assertConnectorUrl("http://localhost:3000/mcp").href).toBe("http://localhost:3000/mcp");
    expect(() => assertConnectorUrl("http://ornek.dev/mcp")).toThrow(/https/);
    expect(() => assertConnectorUrl("bozuk")).toThrow(/Geçersiz/);
  });

  it("katalog satırı açıklamanın ilk cümlesidir ve kısaltılır", () => {
    expect(catalogLine("Sayfa arar.  İkinci cümle burada.")).toBe("Sayfa arar.");
    expect(catalogLine("Satır\nkırığı olan açıklama")).toBe("Satır kırığı olan açıklama");
    expect(catalogLine(`${"a".repeat(200)}`)).toHaveLength(110);
    expect(catalogLine("")).toBe("");
  });

  it("araç aramasında ad eşleşmesi ağır basar, bağlayıcı adı tüm araçlarını getirir", () => {
    const entries = [
      { connector: "Notion", name: "mcp_notion_sayfa_ara", description: "Sayfalarda arama yapar." },
      { connector: "Notion", name: "mcp_notion_sayfa_oku", description: "Bir sayfayı okur." },
      { connector: "Takvim", name: "mcp_takvim_etkinlik", description: "Etkinlik oluşturur." },
    ];
    expect(matchTools("sayfa ara", entries).map((e) => e.name)).toEqual([
      "mcp_notion_sayfa_ara",
      "mcp_notion_sayfa_oku",
    ]);
    // Türkçe harf ve büyük harf duyarsız; bağlayıcı adı o bağlayıcının hepsini getirir.
    expect(matchTools("NOTİON", entries)).toHaveLength(2);
    expect(matchTools("mcp_takvim_etkinlik", entries)[0]?.name).toBe("mcp_takvim_etkinlik");
    expect(matchTools("", entries)).toEqual([]);
    // "bir" açıklamada geçse de sözcük bütünü aranır; "oluş" öneki "oluşturur"u bulur.
    expect(matchTools("bir uzay gemisi", entries)).toHaveLength(1);
    expect(matchTools("uzay gemisi", entries)).toEqual([]);
    expect(matchTools("etkinlik oluş", entries).map((e) => e.name)).toEqual([
      "mcp_takvim_etkinlik",
    ]);
  });

  it("istemde anılan bağlayıcıyı çok sözcüklü ve noktalamalı adlarda da bulur", () => {
    const names = [
      "Google Drive",
      "Google Docs",
      "monday.com",
      "Atlassian (Jira, Confluence)",
      "Takvim",
    ];
    // Adın tamamı alt dize olarak aransaydı bunların hiçbiri tutmazdı.
    expect(mentionedConnectors("Drive'daki sunumu aç", names)).toEqual(["Google Drive"]);
    expect(mentionedConnectors("monday'de görev aç", names)).toEqual(["monday.com"]);
    expect(mentionedConnectors("Jira'da issue aç", names)).toEqual([
      "Atlassian (Jira, Confluence)",
    ]);
    expect(mentionedConnectors("Google Docs'u aç", names)).toEqual(["Google Docs"]);
    // Çekim eki: "takvimdeki" → "Takvim".
    expect(mentionedConnectors("takvimdeki toplantıyı sil", names)).toEqual(["Takvim"]);
    // Paylaşılan sözcük tek başına yetmez; yoksa yalın "google" iki bağlayıcıyı birden yüklerdi.
    expect(mentionedConnectors("google'da ara", names)).toEqual([]);
    expect(mentionedConnectors("merhaba dünya", names)).toEqual([]);
    expect(mentionedConnectors("", names)).toEqual([]);
  });

  it("çekimli sorgu doğru aracı bulur", () => {
    const entries = [
      {
        connector: "Takvim",
        name: "mcp_takvim_etkinlik_olustur",
        description: "Takvimde etkinlik oluşturur.",
      },
      {
        connector: "Notion",
        name: "mcp_notion_sayfa_listele",
        description: "Sayfaları listeler.",
      },
    ];
    // Ek yüzünden "etkinlikleri" eskiden "etkinlik"i hiç tutmuyordu; sonuç yalnızca Notion'du.
    expect(matchTools("etkinlikleri", entries).map((e) => e.name)).toEqual([
      "mcp_takvim_etkinlik_olustur",
    ]);
    expect(matchTools("etkinlikleri listele", entries).map((e) => e.name)).toContain(
      "mcp_takvim_etkinlik_olustur",
    );
    expect(matchTools("sayfaları getir", entries).map((e) => e.name)).toEqual([
      "mcp_notion_sayfa_listele",
    ]);
  });

  it("katalog metni bağlayıcıya göre gruplar ve tek satırlık açıklama yazar", () => {
    const text = catalogText(
      [
        { connector: "Notion", name: "mcp_notion_ara", description: "Arar. Uzun ayrıntı." },
        { connector: "Takvim", name: "mcp_takvim_ekle", description: "" },
        { connector: "Notion", name: "mcp_notion_oku", description: "Okur." },
      ],
      "tr",
    );
    expect(text.startsWith("Servis kataloğu:")).toBe(true);
    expect(text).toContain("## Notion (2)\n- mcp_notion_ara: Arar.\n- mcp_notion_oku: Okur.");
    expect(text).toContain("## Takvim (1)\n- mcp_takvim_ekle: mcp_takvim_ekle");
  });

  it("id_token gövdesinden hesap adını okur; bozuk ya da boş belirteç null döner", () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.imza`;
    expect(accountFromIdToken(jwt({ email: "ayse@ornek.com", name: "Ayşe" }))).toBe(
      "ayse@ornek.com",
    );
    expect(accountFromIdToken(jwt({ preferred_username: "ayse" }))).toBe("ayse");
    expect(accountFromIdToken(jwt({ sub: "123" }))).toBeNull();
    expect(accountFromIdToken("bozuk")).toBeNull();
    expect(accountFromIdToken(undefined)).toBeNull();
  });

  it("içerik bloklarını Pi biçimine çevirir", () => {
    const out = toAgentContent([
      { type: "text", text: "a" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "resource", resource: { uri: "x://1", text: "kaynak" } },
    ]);
    expect(out).toEqual([
      { type: "text", text: "a" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: "kaynak" },
    ]);
  });
});

describe("McpManager", () => {
  it("bağlayıcı ekler, araçları listeler ve çağırır; belirteç renderer özetine çıkmaz", async () => {
    const storePath = join(root, "a", "mcp.json");
    const m = new McpManager({ storePath, openExternal: () => {} });
    const changes: number[] = [];
    m.onChange(() => changes.push(1));
    const c = await m.add({ name: "Test Sunucu", url: `${srv.base}/mcp`, token: null });
    expect(c.status).toBe("connected");
    expect(c.tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
    expect(c.tools[0]?.agentName.startsWith("mcp_test_sunucu_")).toBe(true);
    expect(c).not.toHaveProperty("token");
    expect(changes.length).toBeGreaterThan(0);
    // Dosya izni yalnızca sahibine açık.
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    // Atomik yazım: belirteç dosyası geçici kopyadan taşınır, geride `.tmp` kalmaz.
    expect(existsSync(`${storePath}.tmp`)).toBe(false);

    const defs = m.toolDefinitions();
    const echo = defs.find((d) => d.name.endsWith("_echo"));
    expect(echo).toBeDefined();
    expect(echo?.description).toContain("[Test Sunucu]");
    const stubCtx = {} as Parameters<NonNullable<typeof echo>["execute"]>[4];
    const result = await echo?.execute("1", { text: "selam" }, undefined, undefined, stubCtx);
    // Sonuç modele güvenilmez servis verisi zarfında gider; içerik aynen korunur.
    expect(result?.content).toHaveLength(1);
    const wrapped = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(wrapped).toMatch(
      /^<<<UNTRUSTED_SERVICE_CONTENT id=[0-9a-f]+ source=Test Sunucu\/echo>>>/,
    );
    expect(unwrapUntrusted(wrapped)).toBe("yankı: selam");

    const fail = defs.find((d) => d.name.endsWith("_fail"));
    await expect(fail?.execute("2", {}, undefined, undefined, stubCtx)).rejects.toThrow("olmadı");

    // Kapatınca araçlar listeden düşer, açınca geri gelir.
    const inode = statSync(storePath).ino;
    await m.update(c.id, { enabled: false });
    // Yerinde kırpılmaz: yeni dosya taşınır (inode değişir) ve izin 0600 kalır.
    expect(statSync(storePath).ino).not.toBe(inode);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(m.list()[0]?.status).toBe("disconnected");
    expect(m.toolDefinitions()).toEqual([]);
    await m.update(c.id, { enabled: true });
    expect(m.list()[0]?.status).toBe("connected");

    await m.remove(c.id);
    expect(m.list()).toEqual([]);
    await m.dispose();
  });

  it("aynı adı ve https dışı adresi reddeder", async () => {
    const m = new McpManager({ storePath: join(root, "b", "mcp.json"), openExternal: () => {} });
    await m.add({ name: "Bir", url: `${srv.base}/mcp`, token: null });
    await expect(m.add({ name: "bir", url: `${srv.base}/mcp`, token: null })).rejects.toThrow(
      /zaten var/,
    );
    await expect(m.add({ name: "İki", url: "http://ornek.dev/mcp", token: null })).rejects.toThrow(
      /https/,
    );
    await m.dispose();
  });

  it("Bearer belirteciyle bağlanır; yanlış belirteç hata verir", async () => {
    srv.requireToken = "anahtar-123";
    try {
      const m = new McpManager({ storePath: join(root, "c", "mcp.json"), openExternal: () => {} });
      const ok = await m.add({ name: "Anahtarlı", url: `${srv.base}/mcp`, token: "anahtar-123" });
      expect(ok.status).toBe("connected");
      expect(ok.auth).toBe("bearer");
      const bad = await m.add({ name: "Yanlış", url: `${srv.base}/mcp`, token: "yanlis" });
      expect(bad.status).toBe("error");
      expect(bad.error).toMatch(/401/);
      // Belirteç diske yazılır ama özete girmez.
      const raw = readFileSync(join(root, "c", "mcp.json"), "utf8");
      expect(raw).toContain("anahtar-123");
      expect(JSON.stringify(m.list())).not.toContain("anahtar-123");
      await m.dispose();
    } finally {
      srv.requireToken = null;
    }
  });

  it("401 alınca giriş ister; tarayıcı akışı ve dinamik kayıtla bağlanır, çıkış belirteci siler", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.idToken = `h.${Buffer.from(JSON.stringify({ email: "ayse@ornek.com" })).toString("base64url")}.i`;
    try {
      const opened: string[] = [];
      const storePath = join(root, "d", "mcp.json");
      const m = new McpManager({ storePath, openExternal: (u) => void opened.push(u) });
      const c = await m.add({ name: "OAuth Sunucu", url: `${srv.base}/mcp`, token: null });
      expect(c.status).toBe("needs-login");
      expect(c.auth).toBe("oauth");

      const login = m.login(c.id);
      // Tarayıcı açılana kadar bekle, sonra kullanıcı yerine yetki ver.
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(opened[0]).toContain("/authorize?");
      expect(await srv.authorize(opened[0] ?? "")).toBe(200);
      await login;

      const after = m.list()[0];
      expect(after?.status).toBe("connected");
      expect(after?.tools.length).toBe(2);
      // Hesap OIDC id_token'dan okunur; belirteç değil, yalnız gösterim.
      expect(after?.account).toBe("ayse@ornek.com");
      expect(srv.registered).toBe(1);
      expect(srv.tokensIssued).toBe(1);
      const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
        connectors: Array<{ auth: { tokens?: { access_token: string }; client?: unknown } }>;
      };
      expect(stored.connectors[0]?.auth.tokens?.access_token).toBe("gizli-belirtec");
      expect(stored.connectors[0]?.auth.client).toBeDefined();

      // Yeniden başlatma: saklı belirteçle doğrudan bağlanır, yeni kayıt/giriş olmaz.
      await m.dispose();
      const m2 = new McpManager({ storePath, openExternal: (u) => void opened.push(u) });
      await m2.connect(c.id);
      expect(m2.list()[0]?.status).toBe("connected");
      expect(srv.registered).toBe(1);

      expect(m2.list()[0]?.account).toBe("ayse@ornek.com");
      await m2.logout(c.id);
      expect(m2.list()[0]?.status).toBe("needs-login");
      expect(m2.list()[0]?.account).toBeNull();
      const cleared = JSON.parse(readFileSync(storePath, "utf8")) as {
        connectors: Array<{ auth: { tokens?: unknown } }>;
      };
      expect(cleared.connectors[0]?.auth.tokens).toBeUndefined();
      await m2.dispose();
    } finally {
      srv.requireToken = null;
      srv.idToken = null;
    }
  }, 20_000);

  it("kendi OAuth istemcisiyle (DCR yok) giriş yapar, yetki parametrelerini ekler, istemciyi kopyalar", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.allowDcr = false;
    srv.requiredSecret = "cok-gizli";
    const registeredBefore = srv.registered;
    try {
      const opened: string[] = [];
      const storePath = join(root, "f", "mcp.json");
      const m = new McpManager({ storePath, openExternal: (u) => void opened.push(u) });
      const c = await m.add({
        name: "Google Drive",
        url: `${srv.base}/mcp`,
        token: null,
        oauthClient: { clientId: "ozel-kimlik", clientSecret: "cok-gizli" },
        authorizeParams: { access_type: "offline", prompt: "consent" },
        clientGroup: "google",
      });
      // Belirteç yokken ağa çıkmadan "giriş gerekli"; özet istemci kimliğini taşımaz.
      expect(c.status).toBe("needs-login");
      expect(c.ownClient).toBe(true);
      expect(c.clientGroup).toBe("google");
      expect(JSON.stringify(c)).not.toContain("cok-gizli");

      const login = m.login(c.id);
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      const authorizeUrl = new URL(opened[0] ?? "http://x");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("ozel-kimlik");
      expect(authorizeUrl.searchParams.get("access_type")).toBe("offline");
      expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47821/callback");
      expect(await srv.authorize(opened[0] ?? "")).toBe(200);
      await login;
      expect(m.list()[0]?.status).toBe("connected");
      expect(srv.registered).toBe(registeredBefore);
      expect(srv.lastTokenForm?.get("client_secret")).toBe("cok-gizli");
      const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
        connectors: Array<{ auth: { discovery?: unknown; preset?: { clientId: string } } }>;
      };
      expect(stored.connectors[0]?.auth.discovery).toBeDefined();

      // Aynı aileden ikinci bağlayıcı istemciyi kopyalar.
      const c2 = await m.add({
        name: "Gmail",
        url: `${srv.base}/mcp`,
        token: null,
        copyClientFrom: c.id,
        clientGroup: "google",
      });
      expect(c2.ownClient).toBe(true);
      expect(c2.status).toBe("needs-login");
      expect(stored.connectors[0]?.auth.preset?.clientId).toBe("ozel-kimlik");
      await m.dispose();
    } finally {
      srv.requireToken = null;
      srv.allowDcr = true;
      srv.requiredSecret = null;
    }
  }, 20_000);

  it("belirteçsiz initialize'ı kabul eden sunucuda (Google) giriş yine tarayıcıyı açar", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.openInitialize = true;
    srv.allowDcr = false;
    srv.requiredSecret = "gomulu-gizli";
    try {
      const opened: string[] = [];
      const m = new McpManager({
        storePath: join(root, "i", "mcp.json"),
        openExternal: (u) => void opened.push(u),
        builtInClients: { google: { clientId: "gomulu-kimlik", clientSecret: "gomulu-gizli" } },
      });
      const c = await m.add({
        name: "Google Drive",
        url: `${srv.base}/mcp`,
        token: null,
        clientGroup: "google",
      });
      expect(c.status).toBe("needs-login");
      const login = m.login(c.id);
      // Sunucu 401 döndürmediği için akış kendiliğinden başlamalı; tarayıcı yine açılır.
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(opened[0]).toContain("/authorize?");
      expect(await srv.authorize(opened[0] ?? "")).toBe(200);
      await login;
      expect(m.list()[0]?.status).toBe("connected");
      expect(srv.lastTokenForm?.get("client_secret")).toBe("gomulu-gizli");
      // Belirteç alındı ve araç çağrısı yetkili gidiyor.
      const echo = m.toolDefinitions().find((d) => d.name.endsWith("_echo"));
      const stubCtx = {} as Parameters<NonNullable<typeof echo>["execute"]>[4];
      const result = await echo?.execute("1", { text: "selam" }, undefined, undefined, stubCtx);
      expect(result && textOf(result)).toBe("yankı: selam");
      await m.dispose();
    } finally {
      srv.requireToken = null;
      srv.openInitialize = false;
      srv.allowDcr = true;
      srv.requiredSecret = null;
    }
  });

  it("uygulama içi Google Drive servisi: giriş, araçlar, okuma, yükleme ve belirteç yenileme", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.allowDcr = false;
    srv.requiredSecret = "gomulu-gizli";
    srv.refreshToken = "yenileme-belirteci";
    try {
      const opened: string[] = [];
      const m = new McpManager({
        storePath: join(root, "j", "mcp.json"),
        openExternal: (u) => void opened.push(u),
        builtInClients: { google: { clientId: "gomulu-kimlik", clientSecret: "gomulu-gizli" } },
      });
      const c = await m.add({
        name: "Google Drive",
        url: `${srv.base}/drive/v3`,
        token: null,
        clientGroup: "google",
        authorizeParams: { scope: "drive.readonly" },
        native: { service: "gdrive", authServerUrl: srv.base },
      });
      expect(c.native).toBe("gdrive");
      expect(c.status).toBe("needs-login");
      // Giriş MCP el sıkışması yapmaz: yetki sunucusunda keşif, tarayıcı, kod takası.
      const login = m.login(c.id);
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(opened[0]).toContain("/authorize?");
      expect(new URL(opened[0] ?? "").searchParams.get("scope")).toBe("drive.readonly");
      expect(await srv.authorize(opened[0] ?? "")).toBe(200);
      await login;
      const connected = m.list()[0];
      expect(connected?.status).toBe("connected");
      // Bağlantı denetimi (about.user) hesabı da verir; okuma araçları salt okunur işaretlidir.
      expect(connected?.account).toBe("test@example.com");
      expect(connected?.tools.filter((t) => t.readOnly).map((t) => t.name)).toEqual([
        "search_files",
        "list_recent_files",
        "read_file",
      ]);
      expect(connected?.tools.map((t) => t.agentName)).toEqual([
        "mcp_google_drive_search_files",
        "mcp_google_drive_list_recent_files",
        "mcp_google_drive_read_file",
        "mcp_google_drive_upload_file",
      ]);
      const defs = m.toolDefinitions();
      const stubCtx = {} as Parameters<(typeof defs)[number]["execute"]>[4];
      const run = async (suffix: string, args: Record<string, unknown>) => {
        const def = defs.find((d) => d.name.endsWith(suffix));
        if (!def) throw new Error(`araç yok: ${suffix}`);
        return textOf(await def.execute("1", args, undefined, undefined, stubCtx));
      };
      // Arama: ad + içerik, türe daraltma, çöp hariç.
      expect(await run("_search_files", { query: "plan", type: "document" })).toContain(
        "Plan (google:document) · id: doc1",
      );
      expect(srv.lastDriveQuery).toBe(
        "(name contains 'plan' or fullText contains 'plan') and mimeType = 'application/vnd.google-apps.document' and trashed = false",
      );
      // Okuma: Doküman Markdown olarak dışa aktarılır, metin dosyası olduğu gibi, ikili dosya bağlantıyla.
      expect(await run("_read_file", { fileId: "doc1" })).toContain("# Plan");
      expect(srv.lastExportMime).toBe("text/markdown");
      expect(await run("_read_file", { fileId: "txt1" })).toContain("merhaba drive");
      expect(await run("_read_file", { fileId: "bin1" })).toContain("İkili dosya");
      // Yükleme: çok parçalı gövdede meta veri (klasör) ve içerik.
      expect(
        await run("_upload_file", {
          name: "rapor.md",
          content: "# Rapor",
          mimeType: "text/markdown",
          folderId: "klasor1",
        }),
      ).toContain("Yüklendi");
      expect(srv.lastUpload).toContain('"parents":["klasor1"]');
      expect(srv.lastUpload).toContain("# Rapor");
      // Belirteç süresi doldu: 401 → yenileme belirteciyle taze belirteç → çağrı yinelenir.
      srv.requireToken = "taze-belirtec";
      expect(await run("_list_recent_files", { limit: 5 })).toContain("notlar.txt");
      expect(srv.lastTokenForm?.get("grant_type")).toBe("refresh_token");
      // Yenileme de reddedilirse bağlayıcı "giriş gerekli"ye düşer; tarayıcı kendiliğinden açılmaz.
      srv.requireToken = "baska";
      srv.refreshToken = null;
      await expect(run("_list_recent_files", {})).rejects.toThrow(/bağlı değil/);
      expect(m.list()[0]?.status).toBe("needs-login");
      expect(opened).toHaveLength(1);
      await m.dispose();
    } finally {
      srv.requireToken = null;
      srv.allowDcr = true;
      srv.requiredSecret = null;
      srv.refreshToken = null;
    }
  });

  it("uygulamayla gelen istemci varsa kimlik sorulmadan kullanılır", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.allowDcr = false;
    srv.requiredSecret = "gomulu-gizli";
    try {
      const opened: string[] = [];
      const m = new McpManager({
        storePath: join(root, "g", "mcp.json"),
        openExternal: (u) => void opened.push(u),
        builtInClients: { google: { clientId: "gomulu-kimlik", clientSecret: "gomulu-gizli" } },
      });
      expect(m.builtInClientGroups()).toEqual(["google"]);
      // Kullanıcı yalnızca aileyi söyler; istemci kimliği/gizli anahtarı girmez.
      const c = await m.add({
        name: "Gmail",
        url: `${srv.base}/mcp`,
        token: null,
        clientGroup: "google",
      });
      expect(c.status).toBe("needs-login");
      // Kullanıcı kimlik girmedi: uygulamayla gelen istemci "kendi istemcin" diye gösterilmez.
      expect(c.ownClient).toBe(false);
      const login = m.login(c.id);
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      const first = opened[0] ?? "";
      expect(new URL(first).searchParams.get("client_id")).toBe("gomulu-kimlik");
      expect(await srv.authorize(first)).toBe(200);
      await login;
      expect(m.list()[0]?.status).toBe("connected");
      expect(srv.lastTokenForm?.get("client_secret")).toBe("gomulu-gizli");
      await m.dispose();
    } finally {
      srv.requireToken = null;
      srv.allowDcr = true;
      srv.requiredSecret = null;
    }
  });

  it("uygulamayla gelen istemcide sabit kapı dolu olsa da başka kapıdan giriş yapılır", async () => {
    srv.requireToken = "gizli-belirtec";
    srv.allowDcr = false;
    srv.requiredSecret = "gomulu-gizli";
    // 47821 başka bir süreçte açıkken masaüstü istemcisi herhangi bir loopback kapısını kabul eder.
    const blocker = createServer(() => {});
    await new Promise<void>((r, j) => {
      blocker.once("error", j);
      blocker.listen(47821, "127.0.0.1", r);
    });
    try {
      const opened: string[] = [];
      const m = new McpManager({
        storePath: join(root, "h", "mcp.json"),
        openExternal: (u) => void opened.push(u),
        builtInClients: { google: { clientId: "gomulu-kimlik", clientSecret: "gomulu-gizli" } },
      });
      const c = await m.add({
        name: "Google Takvim",
        url: `${srv.base}/mcp`,
        token: null,
        clientGroup: "google",
      });
      const login = m.login(c.id);
      for (let i = 0; i < 100 && opened.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      const redirect = new URL(opened[0] ?? "http://x").searchParams.get("redirect_uri") ?? "";
      expect(redirect).toContain("127.0.0.1:");
      expect(redirect).not.toContain(":47821/");
      expect(await srv.authorize(opened[0] ?? "")).toBe(200);
      await login;
      expect(m.list()[0]?.status).toBe("connected");
      await m.dispose();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
      srv.requireToken = null;
      srv.allowDcr = true;
      srv.requiredSecret = null;
    }
  });

  it("kendi istemcili bağlayıcıda sabit kapı doluysa giriş açık hata verir", async () => {
    const blocker = createServer(() => {});
    const bound = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false));
      blocker.listen(47821, "127.0.0.1", () => resolve(true));
    });
    try {
      const m = new McpManager({ storePath: join(root, "g", "mcp.json"), openExternal: () => {} });
      const c = await m.add({
        name: "Kapı",
        url: `${srv.base}/mcp`,
        token: null,
        oauthClient: { clientId: "a", clientSecret: "b" },
      });
      await expect(m.login(c.id)).rejects.toThrow(/47821/);
      await m.dispose();
    } finally {
      if (bound) blocker.close();
    }
  });

  it("uzantı araçları oturuma kaydeder ve sonradan bağlananları ekler", async () => {
    const m = new McpManager({ storePath: join(root, "e", "mcp.json"), openExternal: () => {} });
    const registered: string[] = [];
    let shutdown: (() => void) | null = null;
    const pi = {
      registerTool: (def: { name: string }) => registered.push(def.name),
      on: (event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdown = handler;
      },
    };
    m.extension()(pi as unknown as Parameters<ReturnType<McpManager["extension"]>>[0]);
    expect(registered).toEqual([]);
    await m.add({ name: "Sonradan", url: `${srv.base}/mcp`, token: null });
    expect(registered.sort()).toEqual(["mcp_sonradan_echo", "mcp_sonradan_fail"]);
    (shutdown as (() => void) | null)?.();
    await m.dispose();
  });

  it("toplam araç sınırı aşılınca kalanlar ertelenir: katalog, tool_search ve önden yükleme", async () => {
    const big = await startServer(manyToolsHandler());
    const registered = new Map<string, ToolDefinition>();
    type Start = (event: { prompt: string; systemPrompt: string }) => unknown;
    let start: Start | null = null;
    const pi = {
      registerTool: (def: ToolDefinition) => registered.set(def.name, def),
      on: (event: string, handler: Start) => {
        if (event === "before_agent_start") start = handler;
      },
    };
    // Katalog artık sistem istemine eklenmez: uzak sunucudan gelen metin en yüksek güven
    // konumuna yazılmasın diye çizilmeyen bir kullanıcı mesajı olarak döner.
    const run = async (prompt: string) =>
      (await (start as Start | null)?.({ prompt, systemPrompt: "S" })) as
        | { message?: { content: string } }
        | undefined;
    const catalogOf = (r: { message?: { content: string } } | undefined) =>
      r?.message?.content ?? "";
    try {
      const m = new McpManager({ storePath: join(root, "f", "mcp.json"), openExternal: () => {} });
      m.extension()(pi as unknown as Parameters<ReturnType<McpManager["extension"]>>[0]);
      // Sınırın altındaki bağlayıcı tam şemayla kaydedilir.
      await m.add({ name: "Küçük", url: `${srv.base}/mcp`, token: null });
      expect([...registered.keys()].sort()).toEqual(["mcp_kucuk_echo", "mcp_kucuk_fail"]);
      expect(await run("merhaba")).toBeUndefined();
      // Büyük bağlayıcı gelince yalnızca arama aracı eklenir; tam kayıtlılar yerinde kalır.
      await m.add({ name: "Takvim Servisi", url: `${big.base}/mcp`, token: null });
      expect([...registered.keys()].sort()).toEqual([
        "mcp_kucuk_echo",
        "mcp_kucuk_fail",
        TOOL_SEARCH_TOOL,
      ]);
      const r1 = await run("merhaba");
      expect(catalogOf(r1)).toContain(`## Takvim Servisi (${DIRECT_TOOL_LIMIT + 5})`);
      expect(catalogOf(r1)).toContain(
        "- mcp_takvim_servisi_etkinlik_olustur: Takvimde etkinlik oluşturur.",
      );
      expect(catalogOf(r1)).not.toContain("mcp_kucuk_echo");
      // Aynı katalog ikinci turda yeniden eklenmez: her turda eklenirse bağlam şişer.
      expect(await run("merhaba")).toBeUndefined();
      // Bekleyen küme değişince (araç yüklenince) katalog yeniden verilir.

      // Arama eşleşeni kaydeder; yüklenen araç katalogdan düşer.
      const search = registered.get(TOOL_SEARCH_TOOL);
      if (!search) throw new Error("tool_search kayıtlı değil");
      const exec = (query: string) =>
        search.execute("t", { query }, undefined, undefined, undefined as never);
      const hit = textOf(await exec("etkinlik oluştur"));
      expect(hit).toContain("mcp_takvim_servisi_etkinlik_olustur: Takvimde etkinlik oluşturur.");
      expect(hit).not.toContain("eşleşme daha var");
      expect(registered.size).toBe(3 + 1);
      // Bağlayıcı adıyla arama hepsini eşler ama tek seferde en çok 8 yükler.
      expect(textOf(await exec("takvim servisi"))).toContain("eşleşme daha var");
      expect(registered.size).toBe(3 + 1 + 8);
      const r2 = await run("merhaba");
      expect(catalogOf(r2)).not.toContain("mcp_takvim_servisi_etkinlik_olustur:");
      expect(textOf(await exec("hiçbiriyle eşleşmeyen"))).toContain("Takvim Servisi");
      // İstemde bağlayıcı adı geçince kalan araçlar önden yüklenir, katalog kalkar.
      expect(await run("Takvim Servisi'nde bu hafta ne var?")).toBeUndefined();
      expect(registered.size).toBe(3 + DIRECT_TOOL_LIMIT + 5);
      expect(textOf(await exec("etkinlik"))).toContain("zaten yüklü");
      await m.dispose();
    } finally {
      await big.close();
    }
  });

  it("önden yükleme tur bütçesini aşmaz; sığmayan bağlayıcı katalogda kalır", async () => {
    const a = await startServer(manyToolsHandler());
    const b = await startServer(manyToolsHandler());
    const registered = new Set<string>();
    type Start = (event: { prompt: string; systemPrompt: string }) => unknown;
    let start: Start | null = null;
    const pi = {
      registerTool: (def: ToolDefinition) => registered.add(def.name),
      on: (event: string, handler: Start) => {
        if (event === "before_agent_start") start = handler;
      },
    };
    // Katalog artık sistem istemine eklenmez: uzak sunucudan gelen metin en yüksek güven
    // konumuna yazılmasın diye çizilmeyen bir kullanıcı mesajı olarak döner.
    const run = async (prompt: string) =>
      (await (start as Start | null)?.({ prompt, systemPrompt: "S" })) as
        | { message?: { content: string } }
        | undefined;
    const catalogOf = (r: { message?: { content: string } } | undefined) =>
      r?.message?.content ?? "";
    try {
      const m = new McpManager({ storePath: join(root, "h", "mcp.json"), openExternal: () => {} });
      m.extension()(pi as unknown as Parameters<ReturnType<McpManager["extension"]>>[0]);
      await m.add({ name: "Alfa", url: `${a.base}/mcp`, token: null });
      await m.add({ name: "Beta", url: `${b.base}/mcp`, token: null });
      expect([...registered]).toEqual([TOOL_SEARCH_TOOL]);
      // İkisi de anılıyor ama 25 + 25 araç tur bütçesine sığmıyor: yalnızca ilki yüklenir.
      const r = await run("Alfa ve Beta servislerine bak");
      expect([...registered].filter((n) => n.startsWith("mcp_alfa_"))).toHaveLength(
        DIRECT_TOOL_LIMIT + 5,
      );
      expect([...registered].some((n) => n.startsWith("mcp_beta_"))).toBe(false);
      expect(catalogOf(r)).toContain(`## Beta (${DIRECT_TOOL_LIMIT + 5})`);
      expect(catalogOf(r)).not.toContain("## Alfa");
      await m.dispose();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("çok araçlı servis anılsa da önden yüklenmez, aramayla araç yüklendikten sonra da", async () => {
    // MANY_TOOLS üstü: 35 araç.
    const huge = await startServer(manyToolsHandler(34));
    const registered = new Map<string, ToolDefinition>();
    type Start = (event: { prompt: string; systemPrompt: string }) => unknown;
    let start: Start | null = null;
    const pi = {
      registerTool: (def: ToolDefinition) => registered.set(def.name, def),
      on: (event: string, handler: Start) => {
        if (event === "before_agent_start") start = handler;
      },
    };
    // Katalog artık sistem istemine eklenmez: uzak sunucudan gelen metin en yüksek güven
    // konumuna yazılmasın diye çizilmeyen bir kullanıcı mesajı olarak döner.
    const run = async (prompt: string) =>
      (await (start as Start | null)?.({ prompt, systemPrompt: "S" })) as
        | { message?: { content: string } }
        | undefined;
    const catalogOf = (r: { message?: { content: string } } | undefined) =>
      r?.message?.content ?? "";
    try {
      const m = new McpManager({ storePath: join(root, "i", "mcp.json"), openExternal: () => {} });
      m.extension()(pi as unknown as Parameters<ReturnType<McpManager["extension"]>>[0]);
      await m.add({ name: "Devasa", url: `${huge.base}/mcp`, token: null });
      const r1 = await run("Devasa serviste ne var?");
      expect([...registered.keys()].some((n) => n.startsWith("mcp_devasa_"))).toBe(false);
      expect(catalogOf(r1)).toContain("## Devasa (35)");
      // Aramayla 8 araç yüklendikten sonra kapı yine toplam sayıya bakar; eskiden bekleyen
      // sayısına baktığı için servis birkaç adımda tümüyle yüklenebiliyordu.
      const search = registered.get(TOOL_SEARCH_TOOL);
      if (!search) throw new Error("tool_search kayıtlı değil");
      await search.execute("t", { query: "devasa" }, undefined, undefined, undefined as never);
      expect([...registered.keys()].filter((n) => n.startsWith("mcp_devasa_"))).toHaveLength(8);
      const r2 = await run("Devasa serviste ne var?");
      expect([...registered.keys()].filter((n) => n.startsWith("mcp_devasa_"))).toHaveLength(8);
      expect(catalogOf(r2)).toContain("## Devasa (27)");
      await m.dispose();
    } finally {
      await huge.close();
    }
  });
});

describe("McpManager — reconnectFailed", () => {
  it("yalnız düşmüş etkin bağlayıcıyı dener; debounce eşzamanlı tetikleri tekler", async () => {
    let now = 1_000_000;
    const m = new McpManager({
      storePath: join(root, "r", "mcp.json"),
      openExternal: () => {},
      now: () => now,
    });
    const ok = await m.add({ name: "Sağlam", url: `${srv.base}/mcp`, token: null });
    expect(ok.status).toBe("connected");
    const broken = await m.add({ name: "Kopuk", url: "http://127.0.0.1:9/mcp", token: null });
    expect(broken.status).not.toBe("connected");

    // Yalnız kopuk olan denenir; sağlam bağlantıya dokunulmaz.
    expect(await m.reconnectFailed()).toBe(1);
    expect(m.list().find((c) => c.id === ok.id)?.status).toBe("connected");
    // Hemen ardından gelen ikinci tetik (resume + çevrimiçi geçişi) debounce'a takılır.
    expect(await m.reconnectFailed()).toBe(0);
    now += 6_000;
    expect(await m.reconnectFailed()).toBe(1);

    // Kapatılan bağlayıcı otomatik denemeye girmez.
    await m.update(broken.id, { enabled: false });
    now += 6_000;
    expect(await m.reconnectFailed()).toBe(0);
    await m.dispose();
  });
});

describe("McpManager — canlı araç listesi", () => {
  it("araç kümesi değişince onToolsChanged tetiklenir", async () => {
    const m = new McpManager({ storePath: join(root, "t1", "mcp.json"), openExternal: () => {} });
    const fired: number[] = [];
    m.onToolsChanged(() => fired.push(1));
    const c = await m.add({ name: "Canli", url: `${srv.base}/mcp`, token: null });
    expect(fired.length).toBe(1); // bağlanınca araçlar geldi
    await m.update(c.id, { enabled: false }); // küme boşaldı
    expect(fired.length).toBe(2);
    await m.update(c.id, { enabled: true }); // yeniden bağlandı
    expect(fired.length).toBe(3);
    await m.remove(c.id); // kaldırıldı
    expect(fired.length).toBe(4);
    await m.dispose();
  });
});

describe("McpManager — araç izinleri", () => {
  it("Kapalı araç ajana gitmez, Otomatik/Sor kapıya bildirilir, varsayılan kayda yazılmaz", async () => {
    const storePath = join(root, "p1", "mcp.json");
    const m = new McpManager({ storePath, openExternal: () => {} });
    const fired: number[] = [];
    m.onToolsChanged(() => fired.push(1));
    const c = await m.add({ name: "Izinli", url: `${srv.base}/mcp`, token: null });
    const echo = c.tools.find((t) => t.name === "echo");
    expect(echo?.policy).toBe("ask");
    expect(echo?.readOnly).toBe(true);
    expect(c.tools.find((t) => t.name === "fail")?.readOnly).toBe(false);
    const echoName = echo?.agentName ?? "";
    expect(m.toolPolicy(echoName)).toBe("ask");
    expect(m.toolPolicy("read")).toBeUndefined();

    // Kapatılan araç tanımlardan düşer ve açık oturumlar tazelenir (araç kümesi değişti).
    const before = fired.length;
    m.setToolPolicy(c.id, ["fail"], "off");
    expect(m.toolDefinitions().map((d) => d.name)).toEqual([echoName]);
    expect(m.list()[0]?.tools.find((t) => t.name === "fail")?.policy).toBe("off");
    expect(fired.length).toBe(before + 1);

    // Otomatik araç kümesini değiştirmez; kapı her çağrıda yeni izni okur.
    m.setToolPolicy(c.id, ["echo"], "auto");
    expect(m.toolPolicy(echoName)).toBe("auto");
    expect(fired.length).toBe(before + 1);

    // İzinler diske yazılır ve yeniden açılışta korunur; varsayılana dönen araç kayıttan silinir.
    await m.dispose();
    const m2 = new McpManager({ storePath, openExternal: () => {} });
    await m2.connect(c.id);
    expect(m2.toolPolicy(echoName)).toBe("auto");
    m2.setToolPolicy(c.id, ["echo", "fail"], "ask");
    const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
      connectors: Array<{ toolPolicies?: unknown }>;
    };
    expect(stored.connectors[0]?.toolPolicies).toBeUndefined();
    expect(m2.toolDefinitions()).toHaveLength(2);
    await m2.dispose();
  });
});

const STDIO_FIXTURE = fileURLToPath(new URL("./__fixtures__/stdio-server.mjs", import.meta.url));

/** Koşul sağlanana kadar bekler (süreç kapanışı gibi eşzamansız olaylar için). */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("zaman aşımı");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ajan araç tanımını adıyla bulup çağırır; metin sonucunu döner. */
async function callTool(
  m: McpManager,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const def = m.toolDefinitions().find((d) => d.name === name);
  if (!def) throw new Error(`${name} kayıtlı değil`);
  return textOf(await def.execute("t", args, undefined, undefined, undefined as never));
}

describe("McpManager — yerel komut (stdio)", () => {
  it("komutu başlatır; Codezal kimlik ortamı geçmez, PATH main'den gelir, kapatınca süreç ölür", async () => {
    const saved = {
      dir: process.env.PI_CODING_AGENT_DIR,
      key: process.env.CODEZAL_TEST_API_KEY,
    };
    process.env.PI_CODING_AGENT_DIR = "/gizli/agent";
    process.env.CODEZAL_TEST_API_KEY = "sk-gizli";
    const storePath = join(root, "s1", "mcp.json");
    const m = new McpManager({
      storePath,
      openExternal: () => {},
      stdioPath: () => "/ozel/bin:/usr/bin",
    });
    try {
      const c = await m.addStdio({
        name: "Yerel",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: { FIXTURE_TOKEN: "deger-123" },
        cwd: root,
      });
      expect(c.status).toBe("connected");
      expect(c.transport).toBe("stdio");
      expect(c.url).toBe("");
      expect(c.envKeys).toEqual(["FIXTURE_TOKEN"]);
      expect(c.command).toContain("stdio-server.mjs");
      // Ortam değeri renderer özetine çıkmaz; dosyada (0600) kalır.
      expect(JSON.stringify(m.list())).not.toContain("deger-123");
      expect(readFileSync(storePath, "utf8")).toContain("deger-123");
      expect(statSync(storePath).mode & 0o777).toBe(0o600);

      const out = JSON.parse(await callTool(m, "mcp_yerel_env")) as {
        keys: string[];
        path: string;
        cwd: string;
        pid: number;
      };
      expect(out.keys).not.toContain("PI_CODING_AGENT_DIR");
      expect(out.keys).not.toContain("CODEZAL_TEST_API_KEY");
      expect(out.keys).toContain("FIXTURE_TOKEN");
      expect(out.path).toBe("/ozel/bin:/usr/bin");
      expect(realpathSync(out.cwd)).toBe(realpathSync(root));
      expect(alive(out.pid)).toBe(true);

      // Kapatınca süreç sonlanır.
      await m.update(c.id, { enabled: false });
      await until(() => !alive(out.pid));
      expect(m.list()[0]?.status).toBe("disconnected");
    } finally {
      await m.dispose();
      if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved.dir;
      if (saved.key === undefined) delete process.env.CODEZAL_TEST_API_KEY;
      else process.env.CODEZAL_TEST_API_KEY = saved.key;
    }
  });

  it("başlamayan komutta hata ve maskelenmiş stderr; bulunmayan komut açık hata verir", async () => {
    const m = new McpManager({ storePath: join(root, "s2", "mcp.json"), openExternal: () => {} });
    try {
      const crashed = await m.addStdio({
        name: "Coken",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: { FIXTURE_CRASH: "gizli-anahtar-999" },
      });
      expect(crashed.status).toBe("error");
      await until(() => (m.list()[0]?.stderr ?? "").includes("başlangıç hatası"));
      const stderr = m.list()[0]?.stderr ?? "";
      expect(stderr).toContain("başlangıç hatası: ••••");
      expect(stderr).not.toContain("gizli-anahtar-999");

      const missing = await m.addStdio({
        name: "Yok",
        command: "codezal-olmayan-komut-xyz",
        args: [],
        env: {},
      });
      expect(missing.status).toBe("error");
      expect(missing.error).toContain("Komut bulunamadı: codezal-olmayan-komut-xyz");

      await expect(
        m.addStdio({ name: "Bozuk", command: "node", args: [], env: { "1A": "x" } }),
      ).rejects.toThrow("Geçersiz ortam değişkeni adı");
      await expect(
        m.addStdio({ name: "Klasor", command: "node", args: [], env: {}, cwd: "goreli/yol" }),
      ).rejects.toThrow("Çalışma klasörü bulunamadı");
    } finally {
      await m.dispose();
    }
  });

  it("süreç beklenmedik kapanırsa satır hataya düşer ve stderr'i gösterir", async () => {
    const m = new McpManager({ storePath: join(root, "s3", "mcp.json"), openExternal: () => {} });
    try {
      await m.addStdio({
        name: "Kirilgan",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: {},
      });
      await callTool(m, "mcp_kirilgan_mutate", { action: "exit" });
      await until(() => m.list()[0]?.status === "error");
      expect(m.list()[0]?.error).toBe("Yerel sunucu süreci kapandı.");
      await until(() => (m.list()[0]?.stderr ?? "").includes("beklenmedik çöküş"));
      expect(m.toolDefinitions()).toEqual([]);
    } finally {
      await m.dispose();
    }
  });
});

/**
 * Pi taklidi: kayıt ve etkin küme. Pi gibi davranır: ilk kez kaydedilen araç etkinleşir, aynı adla
 * yeniden kaydedilen araç etkinliğini kendiliğinden geri almaz.
 */
function fakePi() {
  const registered = new Map<string, ToolDefinition>();
  let active: string[] = [];
  const pi = {
    registerTool: (def: ToolDefinition) => {
      if (!registered.has(def.name)) active.push(def.name);
      registered.set(def.name, def);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    on: () => {},
  };
  return {
    registered,
    active: () => active,
    api: pi as unknown as Parameters<ReturnType<McpManager["extension"]>>[0],
  };
}

describe("McpManager — tools/list_changed", () => {
  it("sunucu araç ekleyip kaldırınca liste, satır notu ve canlı oturum güncellenir", async () => {
    const m = new McpManager({ storePath: join(root, "lc1", "mcp.json"), openExternal: () => {} });
    const pi = fakePi();
    m.extension()(pi.api);
    const fired: number[] = [];
    m.onToolsChanged(() => fired.push(1));
    try {
      const c = await m.addStdio({
        name: "Canli Liste",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: {},
      });
      expect(c.toolChange).toBeNull();
      expect(pi.active()).toContain("mcp_canli_liste_echo");
      const oldEcho = pi.registered.get("mcp_canli_liste_echo");
      const firedBefore = fired.length;

      // Eklenen araç satırda fark olarak görünür; onaylanınca canlı oturuma kaydedilip etkinleşir.
      await callTool(m, "mcp_canli_liste_mutate", { action: "add" });
      await until(() => m.list()[0]?.tools.some((t) => t.name === "extra") ?? false);
      expect(m.list()[0]?.toolChange).toMatchObject({ added: ["extra"], removed: [] });
      expect(pi.active()).not.toContain("mcp_canli_liste_extra");
      m.approveTools(c.id, ["extra"]);
      expect(pi.active()).toContain("mcp_canli_liste_extra");
      expect(fired.length).toBeGreaterThan(firedBefore);

      // Kaldırılan araç etkin kümeden düşer; eski tanım çağrılırsa sunucuya gitmeden açık hata.
      await callTool(m, "mcp_canli_liste_mutate", { action: "remove-echo" });
      await until(() => !(m.list()[0]?.tools.some((t) => t.name === "echo") ?? true));
      expect(m.list()[0]?.toolChange).toMatchObject({ added: ["extra"], removed: ["echo"] });
      expect(pi.active()).not.toContain("mcp_canli_liste_echo");
      await expect(
        oldEcho?.execute("x", { text: "a" }, undefined, undefined, undefined as never),
      ).rejects.toThrow("echo aracı Canli Liste servisinde artık yok");

      // Yeniden bağlanınca fark sıfırlanır; geri gelen araç (aynı adla) yeniden etkinleşir.
      await m.connect(c.id);
      expect(m.list()[0]?.toolChange).toBeNull();
      expect(pi.active()).toContain("mcp_canli_liste_echo");
      expect(await callTool(m, "mcp_canli_liste_echo", { text: "geri" })).toBe("yankı: geri");
    } finally {
      await m.dispose();
    }
  });
});

describe("McpManager — araç tanımı sabitleme", () => {
  it("kanonik JSON anahtar sırasından bağımsızdır, undefined alanları atlar", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [2, { x: 0, y: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });

  it("ilk listede sabitler; değişen ve yeni araç onaylanana kadar ajana gitmez", async () => {
    const storePath = join(root, "pin1", "mcp.json");
    const m = new McpManager({ storePath, openExternal: () => {} });
    const pi = fakePi();
    m.extension()(pi.api);
    try {
      const c = await m.addStdio({
        name: "Sabit",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: {},
      });
      // İlk bağlantı: hepsi onaylı sayılır ve sabitlenir.
      expect(c.tools.every((t) => t.review === null)).toBe(true);
      const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
        connectors: Array<{ pins?: Record<string, { hash: string; description: string }> }>;
      };
      expect(Object.keys(stored.connectors[0]?.pins ?? {}).sort()).toEqual([
        "echo",
        "env",
        "mutate",
      ]);
      const oldEcho = pi.registered.get("mcp_sabit_echo");

      // Açıklama değişti (zehirleme): araç modelden çekilir, eski kayıt çağrılırsa reddedilir.
      await callTool(m, "mcp_sabit_mutate", { action: "poison" });
      await until(() => m.list()[0]?.tools.find((t) => t.name === "echo")?.review === "changed");
      const echo = m.list()[0]?.tools.find((t) => t.name === "echo");
      expect(echo?.previousDescription).toBe("Metni geri döndürür");
      expect(echo?.description).toContain("id_rsa");
      expect(echo?.schemaChanged).toBe(false);
      expect(m.toolDefinitions().map((d) => d.name)).not.toContain("mcp_sabit_echo");
      expect(pi.active()).not.toContain("mcp_sabit_echo");
      await expect(
        oldEcho?.execute("x", { text: "a" }, undefined, undefined, undefined as never),
      ).rejects.toThrow("onaylayana kadar kullanılamaz");

      // Sonradan eklenen araç da onay bekler.
      await callTool(m, "mcp_sabit_mutate", { action: "add" });
      await until(() => m.list()[0]?.tools.some((t) => t.name === "extra") ?? false);
      expect(m.list()[0]?.tools.find((t) => t.name === "extra")?.review).toBe("new");
      expect(m.toolDefinitions().map((d) => d.name)).not.toContain("mcp_sabit_extra");
      // Değişmeyen araçlar çalışmaya devam eder.
      expect(await callTool(m, "mcp_sabit_env")).toContain("keys");

      // Onay: güncel tanım sabitlenir, araç yeni açıklamayla oturuma döner ve etkinleşir.
      m.approveTools(c.id, ["echo", "extra"]);
      expect(m.list()[0]?.tools.every((t) => t.review === null)).toBe(true);
      expect(pi.registered.get("mcp_sabit_echo")?.description).toContain("id_rsa");
      expect(pi.active()).toEqual(expect.arrayContaining(["mcp_sabit_echo", "mcp_sabit_extra"]));
      expect(await callTool(m, "mcp_sabit_echo", { text: "b" })).toBe("yankı: b");
      await m.dispose();

      // Sabitleme diskte kalır: yeniden açılışta sunucu eski açıklamaya dönünce bu da bir
      // değişikliktir (onaylanan tanımdan farklı) ve yine onay ister.
      const m2 = new McpManager({ storePath, openExternal: () => {} });
      await m2.connect(c.id);
      const again = m2.list()[0]?.tools.find((t) => t.name === "echo");
      expect(again?.review).toBe("changed");
      expect(again?.previousDescription).toContain("id_rsa");
      expect(m2.list()[0]?.tools.find((t) => t.name === "env")?.review).toBeNull();
      await m2.dispose();
    } finally {
      await m.dispose();
    }
  });
});

describe("McpManager — kaynaklar ve istemler", () => {
  it("kaynakları `mcp_resources` ile listeler ve okur; büyük içerik kırpılır, ikili atlanır", async () => {
    const m = new McpManager({ storePath: join(root, "res1", "mcp.json"), openExternal: () => {} });
    try {
      const c = await m.addStdio({
        name: "Kaynakli",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: {},
      });
      expect(c.resources).toBe(true);
      expect(m.toolDefinitions().map((d) => d.name)).toContain(RESOURCES_TOOL);

      const list = await callTool(m, RESOURCES_TOOL, { action: "list" });
      expect(list).toContain("## Kaynakli");
      expect(list).toContain("test://notlar");
      expect(list).toContain("test://logo");

      // Bağlayıcı adı aksan ve büyük harf duyarsız eşleşir.
      expect(
        await callTool(m, RESOURCES_TOOL, {
          action: "read",
          connector: "KAYNAKLI",
          uri: "test://notlar",
        }),
      ).toContain("not içeriği");

      const big = await callTool(m, RESOURCES_TOOL, {
        action: "read",
        connector: "Kaynakli",
        uri: "test://buyuk",
      });
      expect(big.length).toBeLessThan(200_000);
      expect(big).toContain("[çıktı kırpıldı");

      const logo = await callTool(m, RESOURCES_TOOL, {
        action: "read",
        connector: "Kaynakli",
        uri: "test://logo",
      });
      expect(logo).toContain("image/png");
      expect(logo).not.toContain("AAAA");

      await expect(
        callTool(m, RESOURCES_TOOL, { action: "read", connector: "Yok", uri: "test://notlar" }),
      ).rejects.toThrow("Kaynakli");
      await expect(
        callTool(m, RESOURCES_TOOL, { action: "read", connector: "Kaynakli" }),
      ).rejects.toThrow();

      // Servis kapanınca ortak araç da çekilir.
      await m.update(c.id, { enabled: false });
      expect(m.toolDefinitions().map((d) => d.name)).not.toContain(RESOURCES_TOOL);
    } finally {
      await m.dispose();
    }
  });

  it("istemleri listeler ve argümanla işler; bilinmeyen istem açık hata verir", async () => {
    const m = new McpManager({ storePath: join(root, "pr1", "mcp.json"), openExternal: () => {} });
    try {
      const c = await m.addStdio({
        name: "Istemli",
        command: process.execPath,
        args: [STDIO_FIXTURE],
        env: {},
      });
      expect(c.prompts).toEqual([
        {
          name: "ozet",
          title: null,
          description: "Konuyu özetlet",
          arguments: [{ name: "konu", description: "Özetlenecek konu", required: true }],
        },
        { name: "selam", title: null, description: "Selam ver", arguments: [] },
      ]);
      expect(await m.getPrompt(c.id, "ozet", { konu: "MCP" })).toBe("MCP hakkında kısa özet yaz.");
      expect(await m.getPrompt(c.id, "selam", {})).toBe("Merhaba de.");
      await expect(m.getPrompt(c.id, "yok", {})).rejects.toThrow("yok");

      // Bağlı değilken istem listesi boş görünür ve işleme reddedilir.
      await m.update(c.id, { enabled: false });
      expect(m.list()[0]?.prompts).toEqual([]);
      expect(m.list()[0]?.resources).toBe(false);
      await expect(m.getPrompt(c.id, "selam", {})).rejects.toThrow();
    } finally {
      await m.dispose();
    }
  });
});
