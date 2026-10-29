import { describe, expect, it } from "vitest";
import {
  type AgentProfile,
  builtInAgents,
  DEFAULT_AGENT_TYPE,
  EXPLORE_AGENT,
  GENERAL_AGENT,
  isReservedAgentName,
  parseAgentId,
  parseAgentMarkdown,
  resolveAgentTools,
  SUBAGENT_TOOLS,
  serializeAgentMarkdown,
  splitAgentMarkdown,
  validateDraft,
} from "./profile.js";

const SAMPLE = `---
name: rapor-yazari
description: Denetim raporlarını yazar
color: purple
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, grep, write]
disallowedTools: [bash]
injectAgentsMd: false
---

Rapor yazarı olarak çalışırsın.
Bulgu listesini Markdown'a çevir.
`;

describe("ajan Markdown çözümleme", () => {
  it("üst veriyi ve gövdeyi ayırır", () => {
    const { frontmatter, body } = splitAgentMarkdown(SAMPLE);
    expect(frontmatter.values.get("name")).toBe("rapor-yazari");
    expect(frontmatter.values.get("model")).toBe("anthropic/claude-sonnet-4-5");
    expect(frontmatter.lists.get("tools")).toEqual(["read", "grep", "write"]);
    expect(body.trim().startsWith("Rapor yazarı")).toBe(true);
  });

  it("profil alanlarını tipli hâle getirir", () => {
    const file = parseAgentMarkdown("/x/rapor-yazari.md", SAMPLE, "user");
    expect(file.diagnostic).toBeNull();
    expect(file.profile).not.toBeNull();
    const profile = file.profile;
    if (!profile) throw new Error("profil çözülemedi");
    expect(profile.name).toBe("rapor-yazari");
    expect(profile.color).toBe("purple");
    expect(profile.thinking).toBe("high");
    expect(profile.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(profile.tools).toEqual(["read", "grep", "write"]);
    expect(profile.disallowedTools).toEqual(["bash"]);
    expect(profile.injectAgentsMd).toBe(false);
  });

  it("alt alta yazılan araç listesini de okur", () => {
    const list = parseAgentMarkdown(
      "/x/abc.md",
      "---\nname: abc\ndescription: d\ntools:\n  - read\n  - grep\n---\nGövde",
      "user",
    );
    expect(list.profile?.tools).toEqual(["read", "grep"]);
  });

  it("üst veri bloğu olmayan dosyayı tanıyla döner", () => {
    const file = parseAgentMarkdown("/x/plain.md", "Sadece gövde", "project");
    expect(file.profile).toBeNull();
    expect(file.diagnostic).toBe("Üst veri (---) bloğu yok; dosya yok sayıldı.");
  });

  it("açıklaması olmayan dosyayı tanıyla döner", () => {
    const file = parseAgentMarkdown("/x/a-b.md", "---\nname: a-b\n---\nGövde", "user");
    expect(file.profile).toBeNull();
    expect(file.diagnostic).toBe("Açıklama alanı yok; dosya yok sayıldı.");
  });

  it("ad yoksa dosya adını kullanır", () => {
    const file = parseAgentMarkdown("/x/veri-avcisi.md", "---\ndescription: d\n---\nGövde", "user");
    expect(file.profile?.name).toBe("veri-avcisi");
  });

  it("boş ve devral model değerlerini null'a çevirir", () => {
    const inherit = parseAgentMarkdown(
      "/x/abc.md",
      "---\nname: abc\ndescription: d\nmodel: inherit\n---\nG",
      "user",
    );
    expect(inherit.profile?.model).toBeNull();
    const missing = parseAgentMarkdown(
      "/x/abc.md",
      "---\nname: abc\ndescription: d\n---\nG",
      "user",
    );
    expect(missing.profile?.model).toBeNull();
    expect(missing.profile?.thinking).toBeNull();
  });
});

describe("ajan Markdown yazımı", () => {
  it("gidiş dönüşte aynı profili üretir", () => {
    const original = parseAgentMarkdown("/x/rapor-yazari.md", SAMPLE, "user");
    if (!original.profile) throw new Error("profil çözülemedi");
    const draft = {
      scope: "user" as const,
      name: original.profile.name,
      description: original.profile.description,
      systemPrompt: original.profile.systemPrompt,
      color: original.profile.color,
      model: original.profile.model,
      thinking: original.profile.thinking,
      tools: original.profile.tools,
      disallowedTools: original.profile.disallowedTools,
      injectAgentsMd: original.profile.injectAgentsMd,
      isolation: original.profile.isolation,
      background: original.profile.background,
    };
    const round = parseAgentMarkdown("/x/rapor-yazari.md", serializeAgentMarkdown(draft), "user");
    expect(round.profile).toEqual(original.profile);
  });

  it("satır sonlarını tek satıra indirir", () => {
    const text = serializeAgentMarkdown({
      scope: "user",
      name: "abc",
      description: "birinci satır\nikinci satır",
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
    expect(text).toContain("description: birinci satır ikinci satır");
  });
});

describe("taslak doğrulama", () => {
  const base = {
    scope: "user" as const,
    name: "rapor-yazari",
    description: "açıklama",
    systemPrompt: "gövde",
    color: null,
    model: null,
    thinking: null,
    tools: null,
    disallowedTools: [],
    injectAgentsMd: true,
    isolation: "none" as const,
    background: false,
  };

  it("kısa adı reddeder", () => {
    const result = validateDraft({ ...base, name: "ab" });
    expect(result.ok).toBe(false);
  });

  it("geçersiz karakterli adı reddeder", () => {
    expect(validateDraft({ ...base, name: "rapor yazari" }).ok).toBe(false);
    expect(validateDraft({ ...base, name: "rapor_yazari" }).ok).toBe(false);
  });

  it("gömülü adı reddeder", () => {
    expect(validateDraft({ ...base, name: GENERAL_AGENT }).ok).toBe(false);
    expect(validateDraft({ ...base, name: EXPLORE_AGENT.toLocaleUpperCase("en") }).ok).toBe(false);
  });

  it("boş açıklamayı ve istemi reddeder", () => {
    expect(validateDraft({ ...base, description: "  " }).ok).toBe(false);
    expect(validateDraft({ ...base, systemPrompt: "  " }).ok).toBe(false);
  });

  it("geçerli taslağı kırpılmış olarak döner", () => {
    const result = validateDraft({ ...base, name: "  rapor-yazari  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.name).toBe("rapor-yazari");
  });
});

describe("araç kümesi", () => {
  const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
    name: "a",
    description: "d",
    systemPrompt: "p",
    color: null,
    model: null,
    thinking: null,
    tools: null,
    disallowedTools: [],
    injectAgentsMd: true,
    isolation: "none",
    background: false,
    ...overrides,
  });

  it("boş araç listesinde alt ajan araçlarının tamamını verir", () => {
    expect(resolveAgentTools(profile())).toEqual([...SUBAGENT_TOOLS]);
  });

  it("açık listeyi disallowedTools ile daraltır", () => {
    expect(
      resolveAgentTools(profile({ tools: ["read", "write", "bash"], disallowedTools: ["bash"] })),
    ).toEqual(["read", "write"]);
  });

  it("alt oturumda kayıtlı olmayan araçlar varsayılan kümeye girmez", () => {
    expect(resolveAgentTools(profile())).not.toContain("mcp_github_list");
    expect(resolveAgentTools(profile())).not.toContain("task_list");
  });

  it("iç içe ajan ve plan araçlarını açık listede yazılsa bile eler", () => {
    expect(
      resolveAgentTools(profile({ tools: ["read", "agent", "agent_stop", "plan_exit"] })),
    ).toEqual(["read"]);
  });
});

describe("gömülü ajanlar", () => {
  it("genel ve keşif ajanlarını üretir", () => {
    const agents = builtInAgents("tr");
    expect(agents.map((a) => a.profile.name)).toEqual([GENERAL_AGENT, EXPLORE_AGENT]);
  });

  it("keşif ajanı salt-okunur araç kümesiyle gelir", () => {
    const explore = builtInAgents("tr").find((a) => a.profile.name === EXPLORE_AGENT);
    expect(explore?.profile.tools).not.toContain("edit");
    expect(explore?.profile.injectAgentsMd).toBe(false);
  });

  it("varsayılan ajan geneldir ve gömülü adlar korunur", () => {
    expect(DEFAULT_AGENT_TYPE).toBe(GENERAL_AGENT);
    expect(isReservedAgentName("General")).toBe(true);
    expect(isReservedAgentName("keşif")).toBe(false);
  });
});

describe("kimlik", () => {
  it("kapsam ve adı birleştirir", () => {
    expect(parseAgentId("user:Rapor-Yazari")).toEqual({
      scope: "user",
      name: "Rapor-Yazari",
    });
    expect(parseAgentId("project:abc")?.scope).toBe("project");
    expect(parseAgentId("bozuk")).toBeNull();
    expect(parseAgentId(":abc")).toBeNull();
    expect(parseAgentId("other:abc")).toBeNull();
  });
});
