import type { AgentInfo } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { AGENT_MAX_CHARS, AGENT_TOOL, type AgentRunInput, agentTool } from "./tool.js";

function info(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "user:rapor-yazari",
    name: "rapor-yazari",
    description: "Denetim raporlarını yazar",
    systemPrompt: "Rapor yazarsın.",
    scope: "user",
    path: "/tmp/rapor-yazari.md",
    color: "purple",
    model: null,
    thinking: null,
    tools: null,
    disallowedTools: [],
    injectAgentsMd: true,
    isolation: "none",
    background: false,
    enabled: true,
    readOnly: false,
    diagnostic: null,
    ...overrides,
  };
}

function textOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

const run = (
  calls: AgentRunInput[],
  reply = "  özet  ",
): ((input: AgentRunInput) => Promise<string>) => {
  return async (input) => {
    calls.push(input);
    return reply;
  };
};

describe("agent aracı", () => {
  it("ajan listesini açıklamaya yazar", () => {
    const tool = agentTool(async () => "", [info()]);
    expect(tool.name).toBe(AGENT_TOOL);
    expect(tool.description).toContain("rapor-yazari");
    expect(tool.description).toContain("Denetim raporlarını yazar");
    expect(tool.description).toContain("tüm araçlar");
  });

  it("araç kümesi verilen ajanı sayıyla listeler", () => {
    const tool = agentTool(async () => "", [info({ tools: ["read", "grep"] })]);
    expect(tool.description).toContain("read, grep");
  });

  it("görevi ve ajan adını köprüye verir", async () => {
    const calls: AgentRunInput[] = [];
    const tool = agentTool(run(calls), [info()]);
    const result = await tool.execute(
      "call-1",
      { prompt: "  raporu yaz  ", subagent_type: " rapor-yazari ", description: "Rapor" },
      undefined,
      undefined,
      {} as never,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentType).toBe("rapor-yazari");
    expect(calls[0]?.prompt).toBe("raporu yaz");
    expect(calls[0]?.description).toBe("Rapor");
    expect(calls[0]?.callId).toBe("call-1");
    expect(textOf(result)).toBe("özet");
  });

  // Model yalıtımı kapatıp onay adımından kaçıyordu: şema yalnız worktree istemeye izin verir.
  it("modele yalıtımı kapatma seçeneği vermez", () => {
    const tool = agentTool(async () => "", [info()]);
    const isolation = (tool.parameters as { properties: Record<string, unknown> }).properties
      .isolation;
    expect(isolation).toMatchObject({ const: "worktree" });
  });

  it("ajan adı verilmezse gömülü genel ajana düşer", async () => {
    const calls: AgentRunInput[] = [];
    const tool = agentTool(run(calls), [info()]);
    await tool.execute("1", { prompt: "iş" }, undefined, undefined, {} as never);
    expect(calls[0]?.agentType).toBe("general");
  });

  it("boş sonuç yerine açıklama döner", async () => {
    const tool = agentTool(run([], "   "), [info()]);
    expect(
      textOf(await tool.execute("1", { prompt: "x" }, undefined, undefined, {} as never)),
    ).toBe("Ajan sonuç döndürmedi.");
  });

  it("uzun sonucu kırpar", async () => {
    const tool = agentTool(run([], "a".repeat(AGENT_MAX_CHARS + 100)), [info()]);
    const text = textOf(
      await tool.execute("1", { prompt: "x" }, undefined, undefined, {} as never),
    );
    expect(text.length).toBeLessThanOrEqual(AGENT_MAX_CHARS + 8);
    expect(text.endsWith("[…]")).toBe(true);
  });

  it("köprü hatasını olduğu gibi yükseltir", async () => {
    const tool = agentTool(async () => {
      throw new Error("Ajan bulunamadı");
    }, []);
    await expect(
      tool.execute("1", { prompt: "x" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Ajan bulunamadı");
  });
});
