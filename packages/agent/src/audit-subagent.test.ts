import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createI18n } from "@codezal/i18n";
import {
  type Context,
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { CodezalEngine } from "./engine.js";

/**
 * Denetim avcısının süre ve onarım davranışı, motor + sahte model üzerinden. Sahada görülen:
 * süre dolan avcının 30-70 araç çağrılık okuması çöpe gidiyor, ardından görevi bilmeyen YENİ bir
 * oturum "önceki yanıtın şemaya uymadı" diye açılıp 5 dk daha sıfırdan avlanıyor, birim
 * `planned`a döndüğü için ana ajan aynı birimi tekrar tekrar avlatıp bütçeyi yakıyordu.
 */
describe.skipIf(process.platform === "win32")("denetim avcısı süre ve onarım", () => {
  const t = createI18n("tr").t;
  const root = mkdtempSync(join(tmpdir(), "codezal-audit-sub-"));
  const engines: CodezalEngine[] = [];

  afterAll(async () => {
    for (const engine of engines) await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function repo(name: string): string {
    const cwd = join(root, name);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const secret = process.env.KEY;\n", "utf8");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "ignore",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "ilk");
    return cwd;
  }

  /** Modelin bu istekte çağırabileceği araçlar (Pi bunları sistem mesajlarında taşır). */
  const toolNames = (context: Context) => getCurrentTools(context.messages).map((x) => x.name);

  function lastUserText(context: Context): string {
    const user = context.messages.filter((m) => m.role === "user").at(-1);
    if (!user) return "";
    return typeof user.content === "string"
      ? user.content
      : user.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  function allText(context: Context): string {
    return context.messages
      .map((m) => {
        if (m.role !== "user" && m.role !== "assistant") return "";
        if (typeof m.content === "string") return m.content;
        return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      })
      .join("\n");
  }

  const CANDIDATE_JSON = JSON.stringify({
    candidates: [
      {
        title: "Anahtar ortam değişkeninden sızıyor",
        description: "Gizli anahtar dışa aktarılan sabitte.",
        claimed_root_cause: "Gizli değer modül dışına açılıyor.",
        trace: [
          {
            kind: "entrypoint",
            file: "src/app.ts",
            line: 1,
            scope: "modül",
            description: "Giriş.",
          },
        ],
        evidence: [{ file: "src/app.ts", line: 1, description: "Dışa aktarım." }],
      },
    ],
  });

  /**
   * Denetimi başlatır, ana modele tek birimi avlatır. `hunter` adımları avcı alt oturumunun
   * model istekleridir; ana model önce `audit_hunt` çağırır, en sonda "bitti" der.
   */
  async function huntOnce(
    name: string,
    timeouts: { huntMs: number; verifyMs: number; graceMs: number },
    hunter: (unitId: string) => FauxResponseStep[],
  ) {
    const cwd = repo(name);
    const engine = new CodezalEngine({
      agentDir: join(root, name, "pi"),
      sessionsDir: join(root, name, "sessions"),
      memoryDir: join(root, name, "memory"),
      auditsDir: join(root, name, "audits"),
      auditTimeouts: timeouts,
    });
    engines.push(engine);
    const provider = `codezal-audit-${name}`;
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
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
        },
      ],
    });
    await runtime.refresh({ allowNetwork: false });
    const s = await engine.createSession({
      cwd,
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
      projectId: null,
    });
    await engine.setModel(s.id, { provider, id: "faux-1" });
    const view = engine.startAudit(s.id, { profile: "quick" });
    const ledgerPath = join(view.runDir, "coverage-ledger.json");
    const ledger = () =>
      JSON.parse(readFileSync(ledgerPath, "utf8")) as {
        units: Array<{ id: string; status: string; note?: string }>;
      };
    const unitId = ledger().units[0]?.id ?? "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("audit_hunt", { units: [unitId] }), {
        stopReason: "toolUse",
      }),
      ...hunter(unitId),
      fauxAssistantMessage("bitti"),
    ]);
    const ended = new Promise<void>((resolve) => {
      const off = engine.bus.on("run_end", (ev) => {
        if (ev.sessionId !== s.id) return;
        off();
        resolve();
      });
    });
    await engine.prompt(s.id, "denetle");
    await ended;
    const unit = ledger().units.find((u) => u.id === unitId);
    const used = engine.auditView(s.id)?.budget.used;
    engine.closeSession(s.id);
    runtime.unregisterProvider(provider);
    return { unit, used };
  }

  it("süre dolunca avcı araçsız yönlendirilir ve elindekiyle yazar; birim kısmi işaretlenir", async () => {
    const seen: Array<{ tools: string[]; user: string }> = [];
    const record = (context: Context) =>
      seen.push({ tools: toolNames(context), user: lastUserText(context) });
    const { unit, used } = await huntOnce(
      "yumusak",
      { huntMs: 500, verifyMs: 500, graceMs: 4000 },
      () => [
        async (context: Context) => {
          record(context);
          // Model süre dolarken hâlâ okuyor: yanıtı süre sınırını aşar.
          await sleep(1200);
          return fauxAssistantMessage(fauxToolCall("read", { path: "src/app.ts" }), {
            stopReason: "toolUse",
          });
        },
        (context: Context) => {
          record(context);
          return fauxAssistantMessage(CANDIDATE_JSON);
        },
      ],
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]?.tools).toContain("read");
    expect(seen[1]?.tools).toEqual([]);
    expect(seen[1]?.user).toBe(t("prompt.auditHunterFinalize"));
    expect(unit?.status).toBe("candidate");
    expect(unit?.note).toContain("kısmi tarama");
    expect(used).toBe(1);
  }, 30_000);

  it("şemaya uymayan yanıt AYNI oturumda, araçsız onarılır ve bütçeden düşer", async () => {
    const seen: Array<{ tools: string[]; text: string }> = [];
    const { unit, used } = await huntOnce(
      "onarim",
      { huntMs: 60_000, verifyMs: 60_000, graceMs: 60_000 },
      (unitId) => [
        (context: Context) => {
          seen.push({ tools: toolNames(context), text: allText(context) });
          return fauxAssistantMessage("Bu birimde sorun görmedim.");
        },
        (context: Context) => {
          seen.push({ tools: toolNames(context), text: allText(context) });
          expect(allText(context)).toContain(unitId);
          return fauxAssistantMessage('{"candidates":[]}');
        },
      ],
    );
    expect(seen).toHaveLength(2);
    // Onarım turu görevi ve önceki yanıtı görür; yeni oturum ikisini de bilmiyordu.
    expect(seen[1]?.text).toContain("Bu birimde sorun görmedim.");
    expect(seen[1]?.text).toContain("Önceki yanıtın şemaya uymadı");
    expect(seen[1]?.tools).toEqual([]);
    expect(unit?.status).toBe("covered");
    expect(used).toBe(2);
  }, 30_000);

  it("son söz penceresinde de yanıt yoksa birim ertelenir, onarım açılmaz", async () => {
    let hunterCalls = 0;
    const { unit, used } = await huntOnce(
      "sert",
      { huntMs: 300, verifyMs: 300, graceMs: 600 },
      () => [
        async () => {
          hunterCalls += 1;
          await sleep(2500);
          return fauxAssistantMessage("geç kalan yanıt");
        },
      ],
    );
    expect(hunterCalls).toBe(1);
    expect(unit?.status).toBe("deferred");
    expect(used).toBe(1);
  }, 30_000);
});
