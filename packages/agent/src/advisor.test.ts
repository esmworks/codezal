import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Context,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { ADVISOR_TOOL, clip, serializeTranscript } from "./advisor.js";
import { CodezalEngine } from "./engine.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const result = (text: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId: "t1",
  toolName: "read",
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});
const assistant = (text: string): Message =>
  fauxAssistantMessage([
    { type: "thinking", thinking: "düşünce" },
    { type: "text", text },
    fauxToolCall("read", { path: "a.ts" }),
  ]);

describe("danışman dökümü", () => {
  it("kullanıcı, asistan, araç çağrısı ve sonucunu sırayla yazar", () => {
    const text = serializeTranscript(
      [user("görev"), assistant("bakıyorum"), result("içerik"), result("olmadı", true)],
      100_000,
    );
    expect(text).toBe(
      [
        "[User]\ngörev",
        "[Assistant thinking]\ndüşünce",
        "[Assistant]\nbakıyorum",
        '[Tool call: read] {"path":"a.ts"}',
        "[Tool result: read]\niçerik",
        "[Tool error: read]\nolmadı",
      ].join("\n\n"),
    );
  });

  it("uzun araç sonucunu baştan ve sondan kırpar", () => {
    const long = `BAŞ${"x".repeat(50_000)}SON`;
    const text = serializeTranscript([result(long)], 1_000_000);
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain("BAŞ");
    expect(text).toContain("SON");
    expect(text).toContain("chars omitted");
    expect(clip("kısa", 10)).toBe("kısa");
  });

  it("sınır aşılınca görevi ve son girdileri tutar, aradakileri atar", () => {
    const messages = [user("ilk görev"), ...Array.from({ length: 50 }, (_, i) => user(`m${i}`))];
    const text = serializeTranscript(messages, 200);
    expect(text.startsWith("[User]\nilk görev")).toBe(true);
    expect(text).toContain("earlier entries omitted");
    expect(text.endsWith("[User]\nm49")).toBe(true);
    expect(text).not.toContain("m0\n");
  });
});

describe("danışman aracı (motor, çevrimdışı)", () => {
  const root = mkdtempSync(join(tmpdir(), "codezal-advisor-"));
  let advisorRef: { provider: string; id: string } | null = null;
  let scheduled = false;
  const engine = new CodezalEngine({
    agentDir: join(root, "pi"),
    sessionsDir: join(root, "sessions"),
    memoryDir: join(root, "memory"),
    advisorModel: () => advisorRef,
    advisorScheduled: () => scheduled,
  });

  afterAll(async () => {
    await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  });

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
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
        },
      ],
    });
    return { faux, dispose: () => runtime.unregisterProvider(provider) };
  }

  it("ayar açılıp kapanınca araç açık oturuma eklenir ve düşer", async () => {
    const cwd = join(root, "proje-toggle");
    mkdirSync(cwd, { recursive: true });
    advisorRef = null;
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    try {
      expect(engine.activeToolNames(s.id)).not.toContain(ADVISOR_TOOL);
      advisorRef = { provider: "x", id: "y" };
      await engine.reloadLiveSessions();
      expect(engine.activeToolNames(s.id)).toContain(ADVISOR_TOOL);
      advisorRef = null;
      await engine.reloadLiveSessions();
      expect(engine.activeToolNames(s.id)).not.toContain(ADVISOR_TOOL);
    } finally {
      engine.closeSession(s.id);
    }
  }, 30_000);

  it("konuşmayı seçili modele gönderir, tavsiyeyi araç sonucu olarak döndürür", async () => {
    const main = await registerFaux("codezal-main");
    const adv = await registerFaux("codezal-adv");
    let advisorContext: Context | undefined;
    let followUp: Context | undefined;
    adv.faux.setResponses([
      (context) => {
        advisorContext = context;
        return fauxAssistantMessage("Önce testi yaz.");
      },
    ]);
    main.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(ADVISOR_TOOL, {})], { stopReason: "toolUse" }),
      (context) => {
        followUp = context;
        return fauxAssistantMessage("tamam");
      },
    ]);
    advisorRef = { provider: "codezal-adv", id: "faux-1" };
    const cwd = join(root, "proje-call");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    const usage: Array<string | undefined> = [];
    const offUsage = engine.bus.on("usage", (ev) => usage.push(ev.model));
    try {
      await engine.setModel(s.id, { provider: "codezal-main", id: "faux-1" });
      const ended = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "sayfayı düzelt");
      await ended;
      expect(adv.faux.state.callCount).toBe(1);
      // Pi sistem istemini `system` rolüne çevirir; döküm tek kullanıcı mesajıdır, ham geçmiş
      // gönderilmez (sonuçsuz araç çağrısı sağlayıcıya gitmez).
      const roles = advisorContext?.messages.map((m) => m.role);
      expect(roles).toEqual(["system", "user"]);
      const text = (i: number) => {
        const content = advisorContext?.messages[i]?.content;
        return typeof content === "string" ? content : "";
      };
      expect(text(0)).toContain("danışman");
      expect(text(1)).toContain("<agent_system_prompt>");
      expect(text(1)).toContain("[User]\nsayfayı düzelt");
      // Pi asistan mesajını araç çalışmadan önce kaydeder: danışman kendi çağrısını da görür.
      expect(text(1)).toContain("[Tool call: advisor]");
      const toolResult = followUp?.messages.find((m) => m.role === "toolResult");
      expect(toolResult).toMatchObject({
        toolName: ADVISOR_TOOL,
        isError: false,
        content: [{ type: "text", text: "Önce testi yaz." }],
      });
      expect(usage).toContain("codezal-adv/faux-1");
    } finally {
      offUsage();
      engine.closeSession(s.id);
      main.dispose();
      adv.dispose();
    }
  }, 30_000);

  it("seçili modelin anahtarı yoksa görevin modeline düşmez, hata döner", async () => {
    const main = await registerFaux("codezal-main2");
    let followUp: Context | undefined;
    main.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(ADVISOR_TOOL, {})], { stopReason: "toolUse" }),
      (context) => {
        followUp = context;
        return fauxAssistantMessage("tamam");
      },
    ]);
    advisorRef = { provider: "yok", id: "model" };
    const cwd = join(root, "proje-missing");
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
      await engine.setModel(s.id, { provider: "codezal-main2", id: "faux-1" });
      const ended = new Promise<void>((resolve) => {
        const off = engine.bus.on("run_end", (ev) => {
          if (ev.sessionId !== s.id) return;
          off();
          resolve();
        });
      });
      await engine.prompt(s.id, "merhaba");
      await ended;
      expect(main.faux.state.callCount).toBe(2);
      const toolResult = followUp?.messages.find((m) => m.role === "toolResult");
      expect(toolResult).toMatchObject({ toolName: ADVISOR_TOOL, isError: true });
      expect(JSON.stringify(toolResult)).toContain("yok/model");
    } finally {
      engine.closeSession(s.id);
      main.dispose();
    }
  }, 30_000);

  it("zamanlanmış koşuda ayar kapalıysa araç gizlenir, gözetim bitince geri açılır", async () => {
    const main = await registerFaux("codezal-main3");
    const seen: boolean[] = [];
    let sessionId = "";
    // Faux bağlamı araç tanımı taşımaz; istek anındaki etkin küme motordan okunur.
    const reply = () => {
      seen.push(engine.activeToolNames(sessionId).includes(ADVISOR_TOOL));
      return fauxAssistantMessage("tamam");
    };
    main.faux.setResponses([reply, reply, reply]);
    advisorRef = { provider: "codezal-main3", id: "faux-1" };
    scheduled = false;
    const cwd = join(root, "proje-scheduled");
    mkdirSync(cwd, { recursive: true });
    const s = await engine.createSession({
      cwd,
      mode: "asistan",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    sessionId = s.id;
    try {
      await engine.setModel(s.id, { provider: "codezal-main3", id: "faux-1" });
      engine.permissions.setUnattended(s.id, true);
      await engine.promptAndWait(s.id, "görev");
      engine.permissions.setUnattended(s.id, false);
      await engine.promptAndWait(s.id, "devam");
      scheduled = true;
      engine.permissions.setUnattended(s.id, true);
      await engine.promptAndWait(s.id, "yine görev");
      expect(seen).toEqual([false, true, true]);
    } finally {
      engine.permissions.setUnattended(s.id, false);
      scheduled = false;
      engine.closeSession(s.id);
      main.dispose();
    }
  }, 30_000);
});
