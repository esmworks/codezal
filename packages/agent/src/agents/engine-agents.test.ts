import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodezalEngine } from "../engine.js";

/**
 * Motorun ajan bağlantısı: `agent` aracı oturumda etkin mi, tanımında hangi ajanlar listeleniyor
 * ve Ajanlar sayfasındaki değişiklik açık oturuma yansıyor mu. Model çağrılmaz: oturum yalnızca
 * katalogdan bir model kimliğiyle açılır, araç listesi yerel olarak okunur.
 */
const root = mkdtempSync(join(tmpdir(), "codezal-agents-engine-"));
const cwd = join(root, "proje");
mkdirSync(cwd, { recursive: true });
const engine = new CodezalEngine({
  agentDir: join(root, "pi"),
  sessionsDir: join(root, "sessions"),
  memoryDir: join(root, "memory"),
  agentsDir: join(root, "agents"),
  agentsStateFile: join(root, "agents-state.json"),
});

afterAll(async () => {
  await engine.dispose();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Çevrimdışı oturum girdisi: katalogdan bir model kimliği seçilir (kimlik doğrulama gerekmez,
 * tur çalıştırılmıyor), kalan alanlar sözleşmedeki varsayılanlarla verilir.
 */
async function options(): Promise<Parameters<CodezalEngine["createSession"]>[0]> {
  const [first] = await engine.catalog();
  if (!first) throw new Error("katalog boş");
  return {
    cwd,
    mode: "kodlama",
    model: { provider: first.provider, id: first.id },
    thinking: "low",
    permission: "ask",
    location: "local",
    projectId: null,
  };
}

describe("motor + ajan aracı", () => {
  it("oturumda `agent` aracını etkinleştirir ve gömülü ajanları listeler", async () => {
    const session = await engine.createSession(await options());
    const agent = engine.activeTools(session.id).find((t) => t.name === "agent");
    expect(agent, "agent aracı etkin olmalı").toBeDefined();
    expect(agent?.description).toContain("general");
    expect(agent?.description).toContain("explore");
    await engine.closeSession(session.id);
  }, 30_000);

  it("tanımlı ajanı araç tanımına ekler ve oturum tazelenince listeyi yeniler", async () => {
    const session = await engine.createSession(await options());
    const before = engine.activeTools(session.id).find((t) => t.name === "agent");
    expect(before?.description).not.toContain("rapor-yazari");

    engine.agents.create(cwd, {
      scope: "user",
      name: "rapor-yazari",
      description: "Denetim raporlarını yazar",
      systemPrompt: "Rapor yazarsın.",
      color: null,
      model: null,
      thinking: null,
      tools: ["read", "write"],
      disallowedTools: [],
      injectAgentsMd: true,
      isolation: "none",
      background: false,
    });
    await engine.reloadLiveSessions();

    const after = engine.activeTools(session.id).find((t) => t.name === "agent");
    expect(after?.description).toContain("rapor-yazari");
    await engine.closeSession(session.id);
  }, 30_000);

  it("kapatılan ajan koşullara hazır listeden düşer", () => {
    const info = engine.agents.create(cwd, {
      scope: "user",
      name: "gecici-ajan",
      description: "Geçici",
      systemPrompt: "Gövde",
      color: null,
      model: null,
      thinking: null,
      tools: null,
      disallowedTools: [],
      injectAgentsMd: true,
      isolation: "none",
      background: false,
    });
    expect(engine.agents.runnable(cwd).map((a) => a.name)).toContain("gecici-ajan");
    engine.agents.setEnabled(info.id, false);
    expect(engine.agents.runnable(cwd).map((a) => a.name)).not.toContain("gecici-ajan");
    engine.agents.remove(cwd, info.id);
  });
});
