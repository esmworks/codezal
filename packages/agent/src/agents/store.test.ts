import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDraft } from "@codezal/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "./store.js";

let root = "";
let userDir = "";
let statePath = "";
let projectDir = "";

// Proje ajanları güven kapısına bağlıdır; testler projeyi güvenilir sayar (motor da
// kullanıcı kararını `projectTrusted` ile verir).
function store(projectTrusted = true): AgentStore {
  return new AgentStore({ userDir, statePath, lang: "tr", projectTrusted: () => projectTrusted });
}

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    scope: "user",
    name: "rapor-yazari",
    description: "Denetim raporlarını yazar",
    systemPrompt: "Rapor yazarsın.",
    color: "purple",
    model: null,
    thinking: null,
    tools: null,
    disallowedTools: [],
    injectAgentsMd: true,
    isolation: "none",
    background: false,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codezal-agents-"));
  userDir = join(root, "agents");
  statePath = join(root, "agents-state.json");
  projectDir = join(root, "proje");
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("AgentStore", () => {
  it("boş klasörde yalnızca gömülü ajanları listeler", () => {
    const catalog = store().list(null);
    expect(catalog.agents.map((a) => a.name).sort()).toEqual(["explore", "general"]);
    expect(catalog.projectDir).toBeNull();
    expect(catalog.diagnostics).toEqual([]);
  });

  it("oluşturulan ajanı dosyaya yazar ve listede gösterir", () => {
    const agents = store();
    const info = agents.create(null, draft());
    expect(info.id).toBe("user:rapor-yazari");
    expect(info.scope).toBe("user");
    const text = readFileSync(join(userDir, "rapor-yazari.md"), "utf8");
    expect(text).toContain("name: rapor-yazari");
    expect(text).toContain("Rapor yazarsın.");
    const catalog = agents.list(null);
    expect(catalog.agents.map((a) => a.name)).toContain("rapor-yazari");
  });

  it("aynı adı ikinci kez reddeder", () => {
    const agents = store();
    agents.create(null, draft());
    expect(() => agents.create(null, draft())).toThrow("zaten var");
  });

  it("geçersiz taslağı yazmaz", () => {
    const agents = store();
    expect(() => agents.create(null, draft({ name: "ab" }))).toThrow();
    expect(agents.list(null).agents).toHaveLength(2);
  });

  it("güncellemede adı değiştirir ve eski dosyayı siler", () => {
    const agents = store();
    const info = agents.create(null, draft());
    const updated = agents.update(null, info.id, draft({ name: "rapor-cu", tools: ["read"] }));
    expect(updated.id).toBe("user:rapor-cu");
    expect(updated.tools).toEqual(["read"]);
    expect(() => readFileSync(join(userDir, "rapor-yazari.md"), "utf8")).toThrow();
    expect(readFileSync(join(userDir, "rapor-cu.md"), "utf8")).toContain("rapor-cu");
  });

  it("ad değişince kapalı işareti yeni kimliğe taşınır", () => {
    const agents = store();
    const info = agents.create(null, draft());
    agents.setEnabled(info.id, false);
    const updated = agents.update(null, info.id, draft({ name: "rapor-cu" }));
    expect(updated.enabled).toBe(false);
    expect(agents.list(null).agents.find((a) => a.name === "rapor-cu")?.enabled).toBe(false);
  });

  it("kapatılan ajan koşullara hazır listesinden düşer", () => {
    const agents = store();
    const info = agents.create(null, draft());
    agents.setEnabled(info.id, false);
    expect(agents.runnable(null).map((a) => a.name)).not.toContain("rapor-yazari");
    expect(agents.list(null).agents.map((a) => a.name)).toContain("rapor-yazari");
    agents.setEnabled(info.id, true);
    expect(agents.runnable(null).map((a) => a.name)).toContain("rapor-yazari");
  });

  it("gömülü ajanın modelini geçersiz kılar, kalıcı yazar ve devralmaya dönebilir", () => {
    const agents = store();
    expect(agents.find(null, "general")?.model).toBeNull();
    const ref = { provider: "anthropic", id: "claude-haiku-4-5" };
    agents.setModelOverride("built-in:general", ref);
    expect(agents.find(null, "general")?.model).toEqual(ref);
    // Durum dosyası kalıcıdır: yeni depo aynı geçersiz kılmayı okur.
    expect(store().find(null, "general")?.model).toEqual(ref);
    // Keşif ajanı etkilenmez.
    expect(agents.find(null, "explore")?.model).toBeNull();
    agents.setModelOverride("built-in:general", null);
    expect(store().find(null, "general")?.model).toBeNull();
  });

  it("geçersiz kılma yalnızca gömülü ajanlarda yazılır", () => {
    const agents = store();
    const info = agents.create(null, draft());
    expect(() =>
      agents.setModelOverride(info.id, { provider: "anthropic", id: "claude-haiku-4-5" }),
    ).toThrow("gömülü");
  });

  it("açma/kapama ve silme, model geçersiz kılmasını korur", () => {
    const agents = store();
    const ref = { provider: "anthropic", id: "claude-haiku-4-5" };
    agents.setModelOverride("built-in:general", ref);
    const info = agents.create(null, draft());
    agents.setEnabled(info.id, false);
    agents.remove(null, info.id);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      overrides: Record<string, unknown>;
    };
    expect(state.overrides["built-in:general"]).toEqual(ref);
    expect(agents.find(null, "general")?.model).toEqual(ref);
  });

  it("bozuk geçersiz kılma kaydını yok sayar", () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        disabled: [],
        overrides: { "built-in:general": { provider: "", id: "x" }, "built-in:explore": "x" },
      }),
      "utf8",
    );
    const agents = store();
    expect(agents.find(null, "general")?.model).toBeNull();
    expect(agents.find(null, "explore")?.model).toBeNull();
    expect(agents.runnable(null).map((a) => a.name)).toEqual(["general", "explore"]);
  });

  it("gömülü ajanı kapatmayı ve silmeyi reddeder", () => {
    const agents = store();
    expect(() => agents.setEnabled("built-in:general", false)).toThrow("Gömülü ajanlar");
    expect(() => agents.remove(null, "built-in:general")).toThrow("Gömülü ajanlar");
  });

  it("ajanı siler ve durum kaydını temizler", () => {
    const agents = store();
    const info = agents.create(null, draft());
    agents.setEnabled(info.id, false);
    agents.remove(null, info.id);
    expect(agents.list(null).agents.map((a) => a.name)).not.toContain("rapor-yazari");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ disabled: [], overrides: {} });
  });

  it("proje ajanını proje klasöründen okur ve aynı adı geçersiz kılar", () => {
    const agents = store();
    agents.create(null, draft());
    const projectAgents = join(projectDir, ".codezal", "agents");
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(
      join(projectAgents, "rapor-yazari.md"),
      "---\nname: rapor-yazari\ndescription: Projeye özel\n---\nProje gövdesi",
      "utf8",
    );
    const catalog = agents.list(projectDir);
    const found = catalog.agents.find((a) => a.name === "rapor-yazari");
    expect(found?.scope).toBe("project");
    expect(found?.description).toBe("Projeye özel");
    expect(catalog.projectDir).toBe(projectAgents);
    // Kullanıcı ajanı dosyası yerinde kalır: yalnızca liste önceliği değişir.
    expect(readFileSync(join(userDir, "rapor-yazari.md"), "utf8")).toContain("Denetim raporlarını");
  });

  it("bozuk dosyayı tanı olarak raporlar, listeyi düşürmez", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "bozuk.md"), "Üst veri yok", "utf8");
    const catalog = store().list(null);
    expect(catalog.agents).toHaveLength(2);
    expect(catalog.diagnostics).toHaveLength(1);
    expect(catalog.diagnostics[0]?.path).toContain("bozuk.md");
  });

  it("gömülü adı taşıyan dosyayı uyarıyla yok sayar", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, "general.md"),
      "---\nname: general\ndescription: Kendi genelim\n---\nGövde",
      "utf8",
    );
    const catalog = store().list(null);
    const general = catalog.agents.find((a) => a.name === "general");
    expect(general?.scope).toBe("built-in");
    expect(catalog.diagnostics.some((d) => d.message.includes("general"))).toBe(true);
  });

  it("adı ayraç farkıyla da bulur", () => {
    const agents = store();
    agents.create(null, draft({ name: "rapor-yazari" }));
    expect(agents.find(null, "rapor yazari")?.name).toBe("rapor-yazari");
    expect(agents.find(null, "RAPOR-YAZARI")?.name).toBe("rapor-yazari");
    expect(agents.find(null, "yok")).toBeNull();
  });

  it("proje kapsamı proje seçilmeden yazılmaz", () => {
    expect(() => store().create(null, draft({ scope: "project" }))).toThrow("proje");
  });
});
