import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkerItem } from "@codezal/contracts";
import {
  type Context,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";
import {
  CodezalEngine,
  encodeCwd,
  rewriteSessionCwd,
  turnBackupPath,
  withChangedFiles,
} from "./engine.js";

const root = mkdtempSync(join(tmpdir(), "codezal-engine-"));
const engine = new CodezalEngine({
  agentDir: join(root, "pi"),
  sessionsDir: join(root, "sessions"),
  memoryDir: join(root, "memory"),
});

afterAll(async () => {
  await engine.dispose();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Ağa çıkmayan sahte model: Pi'nin faux çekirdeği çalışma zamanına sağlayıcı olarak kaydedilir.
 * `baseUrl` Pi'nin kayıt doğrulaması için zorunlu; akış `streamSimple`den geldiği için hiç
 * kullanılmaz. Düşünme `max` kademesine kadar açıktır (eşleme verilmezse Pi `xhigh`/`max`ı kırpar).
 */
async function registerFaux(provider: string) {
  const faux = createFauxCore({ api: provider, provider, models: [{ id: "faux-1" }] });
  const runtime = await engine.runtime();
  runtime.registerProvider(provider, {
    api: provider,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test",
    streamSimple: faux.streamSimple,
    models: [
      {
        id: "faux-1",
        name: "Faux",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    ],
  });
  // Önceki testin `unregisterProvider`'ı arka planda erişilebilirlik taraması başlatır; o tarama
  // bu kaydın geçici "yapılandırılmış" işaretini ezebilir (kayıt kendi taramasıyla düzelir).
  // Beklenmezse oturum yeniden açılırken model geri yüklenemiyor.
  await runtime.refresh({ allowNetwork: false });
  return { faux, dispose: () => runtime.unregisterProvider(provider) };
}

describe("CodezalEngine + Pi (çevrimdışı)", () => {
  it("ModelRuntime oluşturur ve sağlayıcıları listeler", async () => {
    const providers = await engine.providers();
    expect(providers.length).toBeGreaterThan(5);
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.connected).toBe(false);
    for (const p of providers) expect(p).not.toHaveProperty("apiKey");
  }, 30_000);

  it("kataloğu arayüz modeline çevirir", async () => {
    const catalog = await engine.catalog();
    expect(catalog.length).toBeGreaterThan(20);
    const m = catalog[0];
    expect(m).toMatchObject({
      provider: expect.any(String),
      id: expect.any(String),
      available: false,
    });
  });

  it("çevrimdışı katalog tazelemesi listeyi bozmaz ve olay yaymaz", async () => {
    let changed = 0;
    const off = engine.onCatalogChange(() => {
      changed += 1;
    });
    try {
      const before = await engine.catalog();
      const after = await engine.refreshCatalog(true);
      expect(after.map((m) => `${m.provider}/${m.id}`)).toEqual(
        before.map((m) => `${m.provider}/${m.id}`),
      );
      expect(changed).toBe(0);
    } finally {
      off();
    }
  }, 30_000);

  it("boş oturum listesi döner", async () => {
    await expect(engine.listSessions()).resolves.toEqual([]);
    await expect(engine.listSessions(root)).resolves.toEqual([]);
  });

  it("bilinmeyen oturumda kuyruk temizliği hata verir", () => {
    expect(() => engine.clearQueue("yok")).toThrow();
  });

  it("diske düşmemiş açık oturum kendi adıyla listelenir, kapanınca düşer", async () => {
    // Koordinatör gibi main'in kurduğu oturum ilk mesaja kadar diske yazılmaz; liste tazelenince
    // kaybolursa başlık "Oturum"a dönüyordu, kimliği tutan grup da onu açamıyordu.
    const cwd = join(root, "koordinator");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      name: "Bug Tarayıcı",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    const listed = (await engine.listSessions()).find((x) => x.id === s.id);
    expect(listed).toMatchObject({ name: "Bug Tarayıcı", cwd, live: true });
    expect((await engine.listSessions(cwd)).map((x) => x.id)).toEqual([s.id]);
    expect((await engine.listSessions(root)).some((x) => x.id === s.id)).toBe(false);
    await expect(engine.hasSession(s.id)).resolves.toBe(true);
    engine.closeSession(s.id);
    await expect(engine.hasSession(s.id)).resolves.toBe(false);
    expect((await engine.listSessions()).some((x) => x.id === s.id)).toBe(false);
  });

  it("diskteki oturumlar yeniden başlatınca listede görünür (alt klasör taraması)", async () => {
    // Pi, dosyayı ilk asistan yanıtıyla yazar; çevrimdışı testte dosyayı elle üretiriz.
    const cwd = join(root, "proje");
    const dir = join(root, "sessions", "proje-dir");
    mkdirSync(dir, { recursive: true });
    const id = "01a06f94-3a98-763d-8b20-0e04d280d1aa";
    const ts = "2026-09-05T03:19:40.441Z";
    const lines = [
      { type: "session", version: 3, id, timestamp: ts, cwd },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text: "Merhaba" }], timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Selam" }],
          api: "x",
          provider: "p",
          model: "m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ];
    writeFileSync(
      join(dir, `2026-09-05T03-19-40-441Z_${id}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    // Yeni motor = uygulamayı kapatıp açmak: yalnızca diskten okur.
    const fresh = new CodezalEngine({
      agentDir: join(root, "pi"),
      sessionsDir: join(root, "sessions"),
      memoryDir: join(root, "memory"),
    });
    try {
      const all = await fresh.listSessions();
      expect(all.map((s) => s.id)).toContain(id);
      expect(all.find((s) => s.id === id)?.name).toBe("Merhaba");
    } finally {
      await fresh.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /** Süreç içi MCP sunucusunu HTTP'de sunar; test bitince kapatılır. */
  async function serveMcp(build: (srv: McpServer) => void) {
    const handler = createMcpHandler(
      () => {
        const srv = new McpServer({ name: "t", version: "1.0.0" });
        build(srv);
        return srv;
      },
      { legacy: "stateless" },
    );
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const response = await handler.fetch(
        new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers,
          ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const addr = http.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () => new Promise<void>((r) => http.close(() => r())),
    };
  }

  it("bağlayıcı araçları Kodlama ve Asistan oturumlarında aktif araç kümesine girer", async () => {
    // Pi `tools` seçeneği izin listesi gibi çalışıp uzantı araçlarını elerdi; bu test regresyonu tutar.
    const server = await serveMcp((srv) => {
      srv.registerTool("selam", { description: "Selam der" }, async () => ({
        content: [{ type: "text", text: "selam" }],
      }));
    });
    try {
      const c = await engine.mcp.add({ name: "Deneme", url: server.url, token: null });
      expect(c.status).toBe("connected");
      const cwd = join(root, "proje");
      mkdirSync(cwd, { recursive: true });
      for (const mode of ["kodlama", "asistan"] as const) {
        const s = await engine.createSession({
          cwd,
          mode,
          thinking: "low",
          permission: "ask",
          location: "local",
          projectId: null,
        });
        const names = engine.activeToolNames(s.id);
        expect(names).toContain("mcp_deneme_selam");
        expect(names).not.toContain("tool_search");
        expect(names).toContain("read");
        // `bash` sarmalayıcısı yerleşik aracın adıyla kayıtlıdır (otomatik arka plan oradan işler).
        expect(names).toContain("bash");
        expect(names.includes("edit")).toBe(mode === "kodlama");
        // Web araçları, ajan devri ve koşu yönetimi her modda etkin.
        expect(names).toContain("web_search");
        expect(names).toContain("web_fetch");
        expect(names).toContain("agent");
        expect(names).toContain("agent_list");
        expect(names).toContain("bash_background");
        engine.closeSession(s.id);
      }
      await engine.mcp.remove(c.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("araç sınırı aşılınca oturumda bağlayıcı araçları yerine tool_search aktif olur", async () => {
    const server = await serveMcp((srv) => {
      for (let i = 1; i <= 21; i += 1)
        srv.registerTool(`arac_${i}`, { description: `Araç ${i}` }, async () => ({
          content: [{ type: "text", text: String(i) }],
        }));
    });
    try {
      const c = await engine.mcp.add({ name: "Büyük", url: server.url, token: null });
      expect(c.tools).toHaveLength(21);
      const cwd = join(root, "proje");
      mkdirSync(cwd, { recursive: true });
      const s = await engine.createSession({
        cwd,
        mode: "kodlama",
        thinking: "low",
        permission: "ask",
        location: "local",
        projectId: null,
      });
      const names = engine.activeToolNames(s.id);
      expect(names).toContain("tool_search");
      expect(names.some((n) => n.startsWith("mcp_buyuk_"))).toBe(false);
      engine.closeSession(s.id);
      await engine.mcp.remove(c.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("kaynak yenilemesi MCP araçlarını çiftlemez", async () => {
    const server = await serveMcp((srv) => {
      srv.registerTool("selam", { description: "Selam der" }, async () => ({
        content: [{ type: "text", text: "selam" }],
      }));
    });
    try {
      const c = await engine.mcp.add({ name: "Yenile", url: server.url, token: null });
      expect(c.status).toBe("connected");
      const cwd = join(root, "proje-reload-mcp");
      mkdirSync(cwd, { recursive: true });
      const s = await engine.createSession({
        cwd,
        mode: "kodlama",
        thinking: "low",
        permission: "ask",
        location: "local",
        projectId: null,
      });
      try {
        expect(engine.activeToolNames(s.id).filter((n) => n.startsWith("mcp_"))).toEqual([
          "mcp_yenile_selam",
        ]);
        await expect(engine.reloadLiveSessions()).resolves.toBe(1);
        // Reload extension'ları yeniden kurar; araç kaydı çiftlenmemeli, kimlik korunmalı.
        expect(engine.activeToolNames(s.id).filter((n) => n.startsWith("mcp_"))).toEqual([
          "mcp_yenile_selam",
        ]);
      } finally {
        engine.closeSession(s.id);
      }
      await engine.mcp.remove(c.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("API anahtarı kaydeder ve sağlayıcı bağlı görünür", async () => {
    await engine.setApiKey("anthropic", "sk-ant-test-0000000000");
    const providers = await engine.providers();
    expect(providers.find((p) => p.id === "anthropic")?.connected).toBe(true);
    await engine.logout("anthropic");
  });

  it("referanslı anahtar Pi login akışından geçer ve okuma anında çözülür", async () => {
    process.env.CODEZAL_ENGINE_TEST_KEY = "sk-ant-env-00001111";
    try {
      await engine.setApiKey("anthropic", "$CODEZAL_ENGINE_TEST_KEY");
      const p = (await engine.providers()).find((x) => x.id === "anthropic");
      expect(p?.connected).toBe(true);
      expect(p?.keys[0]?.kind).toBe("env");
      expect(p?.keys[0]?.reference).toBe("$CODEZAL_ENGINE_TEST_KEY");
      expect(p?.keys[0]?.hint).toBe("");
      // Pi, özel store'dan okuduğu referansı kendi başına çözemez; çözümleme havuzda olmalı.
      const rt = await engine.runtime();
      expect(await rt.getAuth("anthropic")).toMatchObject({
        auth: { apiKey: "sk-ant-env-00001111" },
      });
    } finally {
      delete process.env.CODEZAL_ENGINE_TEST_KEY;
      await engine.logout("anthropic");
    }
  });

  it("birden fazla anahtar havuzda tutulur, limit dolunca sıradakine geçer", async () => {
    const anthropic = async () => (await engine.providers()).find((p) => p.id === "anthropic");
    await engine.setApiKey("anthropic", "sk-ant-test-aaaa1111", "İş");
    await engine.setApiKey("anthropic", "sk-ant-test-bbbb2222");
    let p = await anthropic();
    expect(p?.connected).toBe(true);
    expect(p?.keys.map((k) => [k.label, k.hint, k.active])).toEqual([
      ["İş", "1111", true],
      [undefined, "2222", false],
    ]);
    for (const k of p?.keys ?? []) expect(JSON.stringify(k)).not.toContain("sk-ant");

    // Limit: aktif yuva soğur, ikinci aktif olur ve Pi bir sonraki istekte onu okur.
    const rotation = engine.keys.markLimited("anthropic", 60_000);
    expect(rotation?.to?.hint).toBe("2222");
    p = await anthropic();
    expect(p?.keys.map((k) => k.active)).toEqual([false, true]);
    expect(p?.keys[0]?.cooldownUntil).toBeGreaterThan(Date.now());
    const rt = await engine.runtime();
    expect(await rt.getAuth("anthropic")).toMatchObject({
      auth: { apiKey: "sk-ant-test-bbbb2222" },
    });

    // Kullan: başa alır ve soğumayı siler.
    const first = p?.keys[0];
    if (!first) throw new Error("yuva yok");
    engine.activateApiKey("anthropic", first.id);
    p = await anthropic();
    expect(p?.keys.map((k) => [k.hint, k.active, k.cooldownUntil])).toEqual([
      ["1111", true, null],
      ["2222", false, null],
    ]);

    // Aktif silinince bağlı kalır; son silinince bağlı değil.
    await engine.removeApiKey("anthropic", first.id);
    p = await anthropic();
    expect(p?.connected).toBe(true);
    expect(p?.keys.map((k) => k.hint)).toEqual(["2222"]);
    const last = p?.keys[0];
    if (!last) throw new Error("yuva yok");
    await engine.removeApiKey("anthropic", last.id);
    p = await anthropic();
    expect(p?.connected).toBe(false);
    expect(p?.keys).toEqual([]);
  }, 30_000);
});

describe("proje taşıma", () => {
  it("rewriteSessionCwd yalnızca eşleşen başlığı değiştirir, gövdeye dokunmaz", () => {
    const dir = mkdtempSync(join(tmpdir(), "codezal-relocate-"));
    const file = join(dir, "s.jsonl");
    const body = '{"type":"message","id":"u1"}\n';
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "s", cwd: "/eski" })}\n${body}`);
    expect(rewriteSessionCwd(file, "/baska", "/yeni")).toBe(false);
    expect(rewriteSessionCwd(file, "/eski", "/yeni")).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text.split("\n")[0] ?? "").cwd).toBe("/yeni");
    expect(text.endsWith(body)).toBe(true);
    writeFileSync(file, "bozuk\n");
    expect(rewriteSessionCwd(file, "/eski", "/yeni")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("relocateProject oturum, bellek ve plan klasörlerini yeni slug'a taşır", async () => {
    const base = mkdtempSync(join(tmpdir(), "codezal-relocate-"));
    const eng = new CodezalEngine({
      agentDir: join(base, "pi"),
      sessionsDir: join(base, "sessions"),
      memoryDir: join(base, "memory"),
      plansDir: join(base, "plans"),
    });
    const from = "/Users/x/eski-ad";
    const to = "/Users/x/yeni-ad";
    const oldSessions = join(base, "sessions", encodeCwd(from));
    mkdirSync(oldSessions, { recursive: true });
    writeFileSync(
      join(oldSessions, "a.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-09-07T00:00:00.000Z", cwd: from })}\n`,
    );
    writeFileSync(
      join(oldSessions, "b.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "b", timestamp: "2026-09-07T00:00:00.000Z", cwd: "/Users/x/baska" })}\n`,
    );
    const oldMemory = eng.memory.ensure({ kind: "proje", cwd: from });
    writeFileSync(
      join(oldMemory, "not.md"),
      "---\nname: not\ndescription: d\ntype: proje\n---\nx\n",
    );
    mkdirSync(join(base, "plans", encodeCwd(from)), { recursive: true });
    writeFileSync(join(base, "plans", encodeCwd(from), "a.md"), "# Plan\n");

    try {
      expect(eng.relocateProject(from, to)).toEqual({ sessions: 1 });
      expect(existsSync(oldSessions)).toBe(false);
      const moved = join(base, "sessions", encodeCwd(to));
      const header = JSON.parse(readFileSync(join(moved, "a.jsonl"), "utf8").split("\n")[0] ?? "");
      expect(header.cwd).toBe(to);
      // Başka klasöre ait oturum taşınan klasörde kalır ama cwd'si değişmez.
      const other = JSON.parse(readFileSync(join(moved, "b.jsonl"), "utf8").split("\n")[0] ?? "");
      expect(other.cwd).toBe("/Users/x/baska");
      expect(existsSync(join(eng.memory.dirFor({ kind: "proje", cwd: to }), "not.md"))).toBe(true);
      expect(existsSync(join(base, "plans", encodeCwd(to), "a.md"))).toBe(true);
      // Pi listesi başlıktaki cwd'ye göre süzer: taşınan oturum yeni yolda görünür.
      const listed = await eng.listSessions(to);
      expect(listed.map((s) => s.id)).toEqual(["a"]);
      expect(eng.planPath("a", to)).toBe(join(base, "plans", encodeCwd(to), "a.md"));
    } finally {
      await eng.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Ajanlar kutusunun verisi", () => {
  it("openSession yanıtı çalışan arka plan görevlerini boş da olsa taşır", async () => {
    const cwd = join(root, "proje-bg");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      const opened = await engine.openSession(s.id);
      expect(opened.backgrounds).toEqual([]);
      // Tur yokken açık tur kimliği de yok: renderer bu alanla snapshot'tan tur kurar.
      expect(opened.runId).toBeNull();
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);
});

describe("düşünme seviyesi kalıcılığı", () => {
  it("çipten seçilen seviye oturum meta'sına yazılır", async () => {
    const cwd = join(root, "proje-think");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    engine.setThinking(s.id, "max");
    // Pi seviyeyi oturum dosyasında tutmaz; açılışta geri verilmesinin kaynağı bu kayıttır.
    const meta = JSON.parse(readFileSync(join(root, "sessions", "meta.json"), "utf8"));
    expect(meta.sessions[s.id].thinking).toBe("max");
    engine.closeSession(s.id);
  }, 30_000);

  /**
   * Regresyon: Pi `max` seviyesini olduğu gibi tutar, geri okuma ise yalnız `xhigh`i "max"e
   * eşliyordu. "max" seçilen oturum açılışta "low" görünüyor, aynı seçim her seferinde yeni bir
   * "low → max" işareti yazıyordu.
   */
  it("max seviyesi geri okumada max kalır ve tekrar seçim işaret yazmaz", async () => {
    const cwd = join(root, "proje-think-max");
    mkdirSync(cwd, { recursive: true });
    const { dispose } = await registerFaux("codezal-faux-think");
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      await engine.setModel(s.id, { provider: "codezal-faux-think", id: "faux-1" });
      engine.setThinking(s.id, "max");
      const opened = await engine.openSession(s.id);
      expect(opened.thinking).toBe("max");
      const marks: string[] = [];
      const off = engine.bus.on("marker", (ev) => marks.push(`${ev.marker.kind}:${ev.marker.to}`));
      engine.setThinking(s.id, "max");
      off();
      expect(marks).toEqual([]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 30_000);
});

describe("geçici sağlayıcı hatasında yeniden deneme", () => {
  /**
   * Regresyon: yeniden deneme beklemesi kesintisizdi ve `abort()` sürdürme durumuna dokunmuyordu.
   * Kullanıcı bekleme sırasında Durdur'a bassa da süre dolunca `agent.continue()` çağrılıyor,
   * tur kendiliğinden devam ediyordu.
   */
  it("bekleme sırasında Durdur turu sürdürmez", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux");
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Provider finish_reason: error",
      }),
      fauxAssistantMessage("devam edildi"),
    ]);
    const cwd = join(root, "proje-retry");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      await engine.setModel(s.id, { provider: "codezal-faux", id: "faux-1" });
      const retried = new Promise<number>((resolve) => {
        const off = engine.bus.on("retry", (ev) => {
          off();
          resolve(ev.delayMs);
        });
      });
      const errors: string[] = [];
      const offError = engine.bus.on("error", (ev) => errors.push(ev.message));
      await engine.prompt(s.id, "merhaba");
      const delayMs = await retried;
      expect(faux.state.callCount).toBe(1);
      await engine.abort(s.id);
      // Bekleme süresi geçer; kesilmemiş olsaydı ikinci istek (devam) burada giderdi.
      await new Promise((resolve) => setTimeout(resolve, delayMs + 500));
      offError();
      expect(faux.state.callCount).toBe(1);
      // Kullanıcı durdurdu: gizlenen geçici hata bant olarak da düşmez.
      expect(errors).toEqual([]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 30_000);
});

describe("geçici hatadan sonra sürdürme bağlamı", () => {
  /**
   * Pi 0.87'den beri bağlam `SessionManager`dan gelir; hata mesajını `agent.state.messages`
   * atamasıyla düşürmek artık sağlayıcıya giden bağlamı değiştirmiyordu. Hatalı yanıt sonraki
   * istekte modele gitmemeli, oturum dosyasında geçmiş olarak kalmalı.
   */
  it("hatalı yanıt sonraki isteğin bağlamına girmez", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-ctx");
    let seen: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Provider finish_reason: error",
      }),
      (context) => {
        seen = context.messages.filter((m) => m.role === "assistant");
        return fauxAssistantMessage("devam edildi");
      },
    ]);
    const cwd = join(root, "proje-retry-ctx");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      await engine.setModel(s.id, { provider: "codezal-faux-ctx", id: "faux-1" });
      const errors: string[] = [];
      const offError = engine.bus.on("error", (ev) => errors.push(ev.message));
      await engine.prompt(s.id, "merhaba");
      // Sürdürme 2 sn bekleyip ikinci isteği yollar.
      for (let i = 0; i < 100 && faux.state.callCount < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      offError();
      expect(errors).toEqual([]);
      expect(faux.state.callCount).toBe(2);
      expect(seen).toEqual([]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 30_000);
});

describe("komut işaretleri", () => {
  it("seçim meta'ya işaret yazar, olay yayar ve açılışta transkripte karışır", async () => {
    const cwd = join(root, "proje-mark");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      const marks: string[] = [];
      const off = engine.bus.on("marker", (ev) => marks.push(`${ev.marker.kind}:${ev.marker.to}`));
      // Aynı değere ikinci seçim satır yazmaz: işaret yalnız gerçek geçişi anlatır.
      engine.setThinking(s.id, "low");
      engine.setThinking(s.id, "max");
      engine.setPermission(s.id, "plan");
      // İşaret meta'da saklanır: Pi'nin oturum dosyası bu komutları hiç görmez.
      const meta = JSON.parse(readFileSync(join(root, "sessions", "meta.json"), "utf8"));
      const saved = meta.sessions[s.id].marks as Array<{ id: string; kind: string; to: string }>;
      expect(saved.map((m) => `${m.kind}:${m.to}`)).toEqual(["thinking:max", "permission:plan"]);
      expect(marks).toEqual(["thinking:max", "permission:plan"]);
      off();
      // Yeniden açılan oturumda işaretler transkripte zaman sırasına karışır.
      const opened = await engine.openSession(s.id);
      const markers = opened.transcript.filter((i) => i.type === "marker");
      expect(markers.map((i) => i.id)).toEqual(saved.map((m) => m.id));
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);
});

describe("geri sarma ve dallandırma işaretleri", () => {
  /** İki turlu, gerçekçi zaman damgalı bir Pi oturum dosyası ve işaret kayıtlı meta üretir. */
  function seedSession(id: string, name: string) {
    const cwd = join(root, name);
    const dir = join(root, "sessions", `${name}-dir`);
    mkdirSync(dir, { recursive: true });
    const base = Date.now() - 60_000;
    const iso = (offset: number) => new Date(base + offset).toISOString();
    const assistant = (id0: string, parent: string, text: string, at: number) => ({
      type: "message",
      id: id0,
      parentId: parent,
      timestamp: iso(at),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "x",
        provider: "p",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop",
        timestamp: base + at,
      },
    });
    const lines = [
      { type: "session", version: 3, id, timestamp: iso(0), cwd },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: iso(0),
        message: { role: "user", content: [{ type: "text", text: "ilk" }], timestamp: base },
      },
      assistant("a1", "u1", "yanıt 1", 1000),
      {
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: iso(2000),
        message: {
          role: "user",
          content: [{ type: "text", text: "ikinci" }],
          timestamp: base + 2000,
        },
      },
      assistant("a2", "u2", "yanıt 2", 3000),
    ];
    writeFileSync(
      join(dir, `${iso(0).replace(/[:.]/g, "-")}_${id}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    // İşaretler: biri ilk mesajdan önce, biri iki turun arasında, biri son yanıttan sonra.
    const metaPath = join(root, "sessions", "meta.json");
    const prev = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as { sessions: Record<string, unknown> })
      : { sessions: {} };
    prev.sessions[id] = {
      marks: [
        { id: "mk-old", kind: "compact", outcome: "done", at: base - 500 },
        { id: "mk-mid", kind: "thinking", from: "low", to: "max", at: base + 2500 },
        { id: "mk-late", kind: "model", to: "acme/opus", at: base + 5000 },
      ],
    };
    writeFileSync(metaPath, JSON.stringify(prev));
    return { cwd, dir };
  }

  const markerIds = (items: Array<{ type: string; id: string }>) =>
    items.filter((i) => i.type === "marker").map((i) => i.id);

  it("geri sarma sonrası işaretler de o noktadan sonrasını bırakır", async () => {
    const id = "01a06f94-3a98-763d-8b20-0e04d280d1ac";
    const { dir } = seedSession(id, "proje-rewind");
    const fresh = new CodezalEngine({
      agentDir: join(root, "pi"),
      sessionsDir: join(root, "sessions"),
      memoryDir: join(root, "memory"),
    });
    try {
      const opened = await fresh.openSession(id);
      expect(markerIds(opened.transcript)).toEqual(["mk-old", "mk-mid", "mk-late"]);
      const result = await fresh.rewindSession(id, 2);
      // İkinci kullanıcı mesajı ve sonrası daldan düştü: yalnız ondan önceki işaret kalır.
      expect(markerIds(result.transcript)).toEqual(["mk-old"]);
      // Kayıt da temizlendi: yeniden açılışta eski dalın satırları geri gelmez.
      const meta = JSON.parse(readFileSync(join(root, "sessions", "meta.json"), "utf8"));
      expect(meta.sessions[id].marks.map((m: { id: string }) => m.id)).toEqual(["mk-old"]);
    } finally {
      await fresh.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("dallandırma kopyalanan aralıktaki işaretleri taşır, sonrasını taşımaz", async () => {
    const id = "01a06f94-3a98-763d-8b20-0e04d280d1ad";
    const { dir } = seedSession(id, "proje-fork");
    const fresh = new CodezalEngine({
      agentDir: join(root, "pi"),
      sessionsDir: join(root, "sessions"),
      memoryDir: join(root, "memory"),
    });
    try {
      const forked = await fresh.forkSession(id);
      const meta = JSON.parse(readFileSync(join(root, "sessions", "meta.json"), "utf8"));
      expect(meta.sessions[forked.id].marks.map((m: { id: string }) => m.id)).toEqual([
        "mk-old",
        "mk-mid",
      ]);
    } finally {
      await fresh.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("yan sohbet", () => {
  it("salt okunur gizli dal açar, ayrı oturuma çevrilir, ana oturumla silinir, açılışta temizlenir", async () => {
    const cwd = join(root, "proje-side");
    mkdirSync(cwd, { recursive: true });
    const { faux, dispose } = await registerFaux("codezal-faux-side");
    faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("yanıt")));
    // Ortak motor: açık bırakılan oturumlar sonraki testlerin canlı oturum sayısını bozar.
    const created: string[] = [];
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "auto-edit",
      location: "local",
      projectId: null,
    });
    try {
      await engine.setModel(s.id, { provider: "codezal-faux-side", id: "faux-1" });
      await engine.rename(s.id, "Ana iş");
      await engine.promptAndWait(s.id, "merhaba");

      const side = await engine.openSideChat(s.id);
      created.push(side.id);
      expect(side.sideOf).toBe(s.id);
      expect(side.name).toBe("Ana iş (yan sohbet)");
      const opened = await engine.openSession(side.id);
      expect(opened.permission).toBe("plan");
      // Kopya ana oturumun geçmişini taşır; izin değişimi sohbete işaret satırı düşmez.
      expect(opened.transcript.filter((i) => i.type === "marker")).toEqual([]);
      expect(opened.transcript.some((i) => i.type === "user" && i.text === "merhaba")).toBe(true);
      const listed = await engine.listSessions(cwd);
      expect(listed.find((x) => x.id === side.id)?.sideOf).toBe(s.id);

      const promoted = await engine.promoteSideChat(side.id);
      expect(promoted.sideOf).toBeNull();
      expect((await engine.openSession(side.id)).permission).toBe("auto-edit");

      const other = await engine.openSideChat(s.id);
      await engine.deleteSession(s.id);
      const after = (await engine.listSessions(cwd)).map((x) => x.id);
      expect(after).not.toContain(other.id);
      expect(after).toContain(side.id);

      const orphanParent = await engine.createSession({
        cwd,
        mode: "kodlama",
        thinking: "low",
        permission: "ask",
        location: "local",
        projectId: null,
      });
      created.push(orphanParent.id);
      await engine.setModel(orphanParent.id, { provider: "codezal-faux-side", id: "faux-1" });
      await engine.promptAndWait(orphanParent.id, "ikinci");
      const orphan = await engine.openSideChat(orphanParent.id);
      expect(await engine.pruneSideChats()).toEqual([orphan.id]);
      expect((await engine.listSessions(cwd)).map((x) => x.id)).not.toContain(orphan.id);
    } finally {
      for (const id of [s.id, ...created]) await engine.deleteSession(id).catch(() => undefined);
      dispose();
    }
  }, 30_000);
});

describe("kaynak yenileme", () => {
  it("kaynak değişikliğinde açık oturumları tazeler", async () => {
    const cwd = join(root, "proje-reload");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      expect(engine.activeToolNames(s.id).length).toBeGreaterThan(0);
      // Extension'lar yeniden bağlanır; oturum çalışmaya devam eder.
      await expect(engine.reloadLiveSessions()).resolves.toBe(1);
      expect(engine.activeToolNames(s.id).length).toBeGreaterThan(0);
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);
});

describe("read sarmalayıcısı", () => {
  it("oturumda yerleşik read'in yerine geçer; açıklaması PDF'i söyler, alt ajan da alır", async () => {
    const cwd = join(root, "proje-read");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      const tools = engine.activeTools(s.id);
      const reads = tools.filter((t) => t.name === "read");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.description).toContain("PDF");
      expect(reads[0]?.description).toContain("render");
      // Yerleşik araçlar da yerinde: sarmalayıcı yalnızca `read`i değiştirir.
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["bash", "edit", "write", "grep", "find", "ls"]),
      );
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);

  it("elle sıkıştırma: kapalı oturumda gerekçe döner, boş oturumda hata vermez", async () => {
    // `/compact` komutu bu yolu kullanır; kullanıcıya ne olduğunu söyleyebilmek için sonuç
    // fırlatmak yerine gerekçeyle döner.
    await expect(engine.compactNow("olmayan-oturum")).resolves.toEqual({
      ok: false,
      reason: "not-open",
    });

    const cwd = join(root, "proje-compact");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      // Durum defteri: sıkıştırma "çalışıyor" yayıp "boşta" yaymazsa arayüz sonsuza kadar süren
      // bir tur gösterir ve Durdur işe yaramaz (ortada durdurulacak koşu yoktur). Bu yüzden her
      // çıkışta kapanması gerekir — burada no-op çıkışında sınanıyor.
      const statuses: string[] = [];
      const off = engine.bus.on("status", (ev) => statuses.push(ev.status));
      // Boş oturumda sıkıştırılacak eski içerik yok: çağrı fırlatmamalı ve bunu "başarısız"
      // değil **yapacak iş yok** olarak bildirmeli. Pi bu durumu hata olarak fırlatır
      // ("Nothing to compact (session too small)"); arayüzün doğru metni seçebilmesi için
      // sebep ayrıştırılır.
      const result = await engine.compactNow(s.id);
      off();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("nothing-to-compact");
      // Arıza olmadığı için kullanıcıya gösterilecek bir "ayrıntı" da yok.
      expect(result.detail).toBeUndefined();
      expect(statuses).toEqual(["working", "idle"]);
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);
});

describe("turnBackupPath", () => {
  it("`~` ve `@` önekini Pi gibi genişletir, göreli yolu cwd'ye göre çözer", () => {
    expect(turnBackupPath("write", "~/notlar/a.md", "/proje")).toBe(join(homedir(), "notlar/a.md"));
    expect(turnBackupPath("edit", "@src/a.ts", "/proje")).toBe(join("/proje", "src/a.ts"));
    expect(turnBackupPath("edit", "src/../b.ts", "/proje")).toBe(join("/proje", "b.ts"));
    expect(turnBackupPath("write", "/mutlak/../c.ts", "/proje")).toBe("/c.ts");
  });
});

describe("withChangedFiles", () => {
  it("aracın kendi alanlarını korur; nesne olmayan details'e dokunmaz", () => {
    const files = [{ path: "/p/a.ts", kind: "edit" as const }];
    expect(withChangedFiles({ truncation: 1 }, files)).toEqual({
      details: { truncation: 1, changedFiles: files },
    });
    expect(withChangedFiles(undefined, files)).toEqual({ details: { changedFiles: files } });
    expect(withChangedFiles("metin", files)).toBeUndefined();
    expect(withChangedFiles([1], files)).toBeUndefined();
  });
});

describe("tur sonrası mesaj teslimi", () => {
  // 1x1 şeffaf PNG
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  /** Model isteğindeki son kullanıcı mesajının metni. */
  function lastUserText(context: Context): string {
    const user = context.messages.filter((m) => m.role === "user").at(-1);
    if (!user) return "";
    return typeof user.content === "string"
      ? user.content
      : user.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  /** Arayüzün kuyruk şeridi gibi: son `queue` olayındaki bekleyen mesajlar. */
  function queueStrip(id: string) {
    let last: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
    const off = engine.bus.on("queue", (ev) => {
      if (ev.sessionId === id) last = { steering: [...ev.steering], followUp: [...ev.followUp] };
    });
    return { last: () => last, off };
  }

  async function liveSession(provider: string, cwd: string) {
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    await engine.setModel(s.id, { provider, id: "faux-1" });
    return s;
  }

  /**
   * Regresyon: eşleyici `run_end`'i `agent_end`'de yayar ama Pi koşuyu `agent_settled`'a kadar
   * sürdürür (tur sonu işleyicileri, `agent_before_settle`). Bu aralıkta gelen mesaj
   * `isStreaming` görüldüğü için sessizce düşüyordu.
   */
  it("run_end'den hemen sonra gönderilen mesaj yeni tur olarak modele ulaşır", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-ardisik");
    const seen: string[] = [];
    faux.setResponses(
      ["birinci yanıt", "ikinci yanıt"].map((reply) => (context: Context) => {
        seen.push(lastUserText(context));
        return fauxAssistantMessage(reply);
      }),
    );
    const s = await liveSession("codezal-faux-ardisik", join(root, "proje-ardisik"));
    try {
      const ends: number[] = [];
      const second = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          ends.push(ev.at);
          if (ends.length === 1) {
            // Arayüz boşta görür görmez yeni mesaj: Pi henüz oturmamıştır.
            void engine.prompt(s.id, "ikinci mesaj");
            return;
          }
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "birinci mesaj");
      await second;
      expect(seen).toEqual(["birinci mesaj", "ikinci mesaj"]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  it("zamanlayıcı yolu (promptAndWait) da run_end'den hemen sonra mesajı işletip bekler", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-zamanlayici");
    const seen: string[] = [];
    faux.setResponses(
      ["birinci yanıt", "ikinci yanıt"].map((reply) => (context: Context) => {
        seen.push(lastUserText(context));
        return fauxAssistantMessage(reply);
      }),
    );
    const s = await liveSession("codezal-faux-zamanlayici", join(root, "proje-zamanlayici"));
    try {
      const done = new Promise<void>((resolve, reject) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          engine.promptAndWait(s.id, "ikinci mesaj").then(resolve, reject);
        });
      });
      await engine.prompt(s.id, "birinci mesaj");
      await done;
      // Döndüğünde iş bitmiş olmalı: mesaj kuyrukta değil, modele gitmiş.
      expect(seen).toEqual(["birinci mesaj", "ikinci mesaj"]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  for (const kind of ["steer", "followUp"] as const) {
    /**
     * Regresyon: `steer`/`followUp` `isStreaming`'i başta görür, mesajı birkaç beklemeden sonra
     * kuyruğa koyar. Pi bu arada oturursa mesaj başlatanı olmayan kuyrukta kalıyor, ancak bir
     * sonraki kullanıcı mesajıyla gidiyordu.
     */
    it(`tur sonunda ${kind} ile gelen mesaj kuyrukta kalmaz, yeni tur olarak işlenir`, async () => {
      const provider = `codezal-faux-kuyruk-${kind}`;
      const { faux, dispose } = await registerFaux(provider);
      const seen: string[] = [];
      let withImage = false;
      faux.setResponses(
        ["birinci yanıt", "ikinci yanıt"].map((reply) => (context: Context) => {
          seen.push(lastUserText(context));
          const user = context.messages.filter((m) => m.role === "user").at(-1);
          withImage = Array.isArray(user?.content) && user.content.some((c) => c.type === "image");
          return fauxAssistantMessage(reply);
        }),
      );
      const s = await liveSession(provider, join(root, `proje-kuyruk-${kind}`));
      try {
        const second = new Promise<void>((resolve) => {
          let count = 0;
          const off = engine.bus.on("run_end", (ev) => {
            if (ev.sessionId !== s.id) return;
            count += 1;
            if (count === 1) {
              // Görsel hazırlığı asenkron: Pi bu sırada oturur, mesaj ondan sonra kuyruğa girer.
              void engine[kind](s.id, "kuyruktaki mesaj", [
                { mimeType: "image/png", data: PNG, name: "nokta.png" },
              ]);
              return;
            }
            off();
            resolve();
          });
        });
        await engine.prompt(s.id, "birinci mesaj");
        await second;
        expect(seen).toEqual(["birinci mesaj", "kuyruktaki mesaj"]);
        // Pi kuyruğu yalnız metni verir; görsel motorun kaydından geri gelir.
        expect(withImage).toBe(true);
      } finally {
        engine.closeSession(s.id);
        dispose();
      }
    }, 15_000);
  }

  it("asılı kalan yönlendirme ve takip tek turda, sırayla gider; Durdur'dan sonra kendiliğinden gitmez", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-kuyruk-iki");
    const seen: string[] = [];
    faux.setResponses(
      ["birinci yanıt", "ikinci yanıt", "üçüncü yanıt"].map((reply) => (context: Context) => {
        seen.push(lastUserText(context));
        return fauxAssistantMessage(reply);
      }),
    );
    const s = await liveSession("codezal-faux-kuyruk-iki", join(root, "proje-kuyruk-iki"));
    const strip = queueStrip(s.id);
    const image = [{ mimeType: "image/png", data: PNG, name: "nokta.png" }];
    try {
      const second = new Promise<void>((resolve) => {
        let count = 0;
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          count += 1;
          if (count === 1) {
            void engine.followUp(s.id, "takip", image);
            void engine.steer(s.id, "yönlendirme", image);
            return;
          }
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "birinci mesaj");
      await second;
      expect(seen).toEqual(["birinci mesaj", "yönlendirme\n\ntakip"]);

      // Durdur'dan sonra asılı kalan mesaj tur başlatmaz; kuyruk temizlenir, işaret düşer.
      const marked = new Promise<MarkerItem>((resolve) => {
        const off = engine.bus.on("marker", (ev) => {
          if (ev.sessionId !== s.id || ev.marker.kind !== "unsent") return;
          off();
          resolve(ev.marker);
        });
      });
      const stuck = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          void engine.steer(s.id, "durdurulan", image);
          void engine.abort(s.id).then(() => resolve());
        });
      });
      await engine.prompt(s.id, "üçüncü mesaj");
      await stuck;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual(["birinci mesaj", "yönlendirme\n\ntakip", "üçüncü mesaj"]);
      // Yanıt listesi bitse de istek sayılır: dördüncü istek gitmemeli.
      expect(faux.state.callCount).toBe(3);
      expect((await marked).to).toBe("durdurulan");
      expect(strip.last()).toEqual({ steering: [], followUp: [] });
    } finally {
      strip.off();
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  it("koşu sürerken Durdur kuyruğu temizler, her mesaja işaret düşer, sonraki tur onları taşımaz", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-kuyruk-durdur");
    const seen: string[][] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const users = (context: Context) =>
      context.messages
        .filter((m) => m.role === "user")
        .map((m) => lastUserText({ ...context, messages: [m] }));
    faux.setResponses([
      async (context: Context) => {
        seen.push(users(context));
        await held;
        return fauxAssistantMessage("yarım");
      },
      (context: Context) => {
        seen.push(users(context));
        return fauxAssistantMessage("temiz");
      },
    ]);
    const s = await liveSession("codezal-faux-kuyruk-durdur", join(root, "proje-kuyruk-durdur"));
    const strip = queueStrip(s.id);
    try {
      const markers: string[] = [];
      const offMarker = engine.bus.on("marker", (ev) => {
        if (ev.sessionId === s.id && ev.marker.kind === "unsent") markers.push(ev.marker.to ?? "");
      });
      await engine.prompt(s.id, "uzun iş");
      for (let i = 0; i < 50 && faux.state.callCount < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await engine.steer(s.id, "yön değiştir");
      await engine.followUp(s.id, "sonra şunu yap");
      const aborted = engine.abort(s.id);
      release();
      await aborted;
      expect(markers).toEqual(["yön değiştir", "sonra şunu yap"]);
      expect(strip.last()).toEqual({ steering: [], followUp: [] });

      const ended = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "yeni mesaj");
      await ended;
      offMarker();
      expect(seen[1]).toEqual(["uzun iş", "yeni mesaj"]);
    } finally {
      strip.off();
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  /**
   * Regresyon: araç sürerken Durdur'a basılınca Pi sonraki model isteğini iptal edilmiş sinyalle
   * açıyor, istek kurulumu "This operation was aborted" ile `stopReason: "error"` dönüyordu;
   * sohbete kırmızı hata bandı düşüyordu.
   */
  it("araç sürerken Durdur hata bandı düşürmez, kart ve tur durdurulmuş kapanır", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-durdur-arac");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("olmamalı"),
    ]);
    const s = await liveSession("codezal-faux-durdur-arac", join(root, "proje-durdur-arac"));
    engine.setPermission(s.id, "full");
    const errors: string[] = [];
    const offError = engine.bus.on("error", (ev) => {
      if (ev.sessionId === s.id) errors.push(ev.message);
    });
    const ended = new Promise<boolean>((resolve) => {
      const off = engine.bus.on("run_end", (ev) => {
        if (ev.sessionId !== s.id) return;
        off();
        resolve(ev.aborted);
      });
    });
    const started = new Promise<void>((resolve) => {
      const off = engine.bus.on("tool_start", (ev) => {
        if (ev.sessionId !== s.id) return;
        off();
        resolve();
      });
    });
    const ends: { isError: boolean; stopped?: boolean }[] = [];
    const offEnd = engine.bus.on("tool_end", (ev) => {
      if (ev.sessionId === s.id)
        ends.push({ isError: ev.isError, ...(ev.stopped ? { stopped: true } : {}) });
    });
    try {
      await engine.prompt(s.id, "uzun komut");
      await started;
      await engine.abort(s.id);
      expect(await ended).toBe(true);
      expect(errors).toEqual([]);
      expect(ends).toEqual([{ isError: true, stopped: true }]);
      // Yeniden açılışta da kart "hata" değil "durduruldu" görünür.
      engine.closeSession(s.id);
      const opened = await engine.openSession(s.id);
      const tools = opened.transcript.filter((i) => i.type === "tool");
      expect(tools.map((i) => i.status)).toEqual(["stopped"]);
    } finally {
      offEnd();
      offError();
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  it("gönderimden sonra Durdur'a basılırsa mesaj tur başlatmaz, sohbete işaret düşer", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-durdur");
    faux.setResponses([fauxAssistantMessage("birinci yanıt"), fauxAssistantMessage("olmamalı")]);
    const s = await liveSession("codezal-faux-durdur", join(root, "proje-durdur"));
    try {
      const marked = new Promise<MarkerItem>((resolve) => {
        const off = engine.bus.on("marker", (ev) => {
          if (ev.sessionId !== s.id || ev.marker.kind !== "unsent") return;
          off();
          resolve(ev.marker);
        });
      });
      const stopped = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          void engine.prompt(s.id, `ikinci   mesaj\n${"uzun ".repeat(30)}`);
          void engine.abort(s.id).then(() => resolve());
        });
      });
      await engine.prompt(s.id, "birinci mesaj");
      await stopped;
      const marker = await marked;
      // Boşluklar teke iner, uzun mesaj kısaltılır.
      expect(marker.to).toMatch(/^ikinci mesaj uzun uzun .*…$/);
      expect(marker.to?.length).toBe(81);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(faux.state.callCount).toBe(1);
      // Balon yeniden açılışta yok (mesaj Pi'ye gitmedi); işaret meta'dan transkripte karışır.
      engine.closeSession(s.id);
      const reopened = await engine.openSession(s.id);
      const items = reopened.transcript.filter((i) => i.type === "user" || i.type === "marker");
      expect(items.map((i) => i.type)).toEqual(["user", "marker"]);
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);

  it("hedef başlangıç mesajı da koşu oturduktan sonra yeni tur olarak gider", async () => {
    const { faux, dispose } = await registerFaux("codezal-faux-hedef");
    const seen: string[] = [];
    faux.setResponses(
      ["birinci yanıt", "bitti\n[GOAL_DONE]"].map((reply) => (context: Context) => {
        seen.push(lastUserText(context));
        return fauxAssistantMessage(reply);
      }),
    );
    const s = await liveSession("codezal-faux-hedef", join(root, "proje-hedef"));
    try {
      const second = new Promise<void>((resolve) => {
        let count = 0;
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          count += 1;
          if (count === 1) {
            engine.goal(s.id, "set", "hedef-metni-4417");
            return;
          }
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "birinci mesaj");
      await second;
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("hedef-metni-4417");
    } finally {
      engine.closeSession(s.id);
      dispose();
    }
  }, 15_000);
});
