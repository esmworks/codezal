import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { analyzeGoalEnd, buildGoalDirective, GOAL_DONE_TOKEN } from "./goal.js";

const assistant = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "x",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "stop",
    timestamp: 2,
  }) as unknown as AgentMessage;
const user = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

describe("buildGoalDirective", () => {
  it("sayaç +1 gösterilir, protokol ve sentinel istenir", () => {
    const d = buildGoalDirective({ text: "Testler geçsin", iter: 2, maxIter: 30 });
    expect(d).toContain("## ACTIVE GOAL\n");
    expect(d).toContain("Iteration: 3/30");
    expect(d).toContain("Testler geçsin");
    expect(d).toContain(GOAL_DONE_TOKEN);
    expect(d).toContain("[GOAL_BLOCKED]");
  });

  it("duraklatılmış hedef protokolü ayrıdır ve sentinel koymayı yasaklar", () => {
    const d = buildGoalDirective({ text: "x", iter: 0, maxIter: 30, paused: true });
    expect(d).toContain("## ACTIVE GOAL (PAUSED)");
    expect(d).toContain("Iteration: 0/30");
    expect(d).toContain("PAUSED by the user");
  });
});

describe("analyzeGoalEnd", () => {
  it("kendi satırındaki [GOAL_DONE] done döner", () => {
    expect(analyzeGoalEnd([user("g"), assistant("Bitti.\n[GOAL_DONE]")])).toBe("done");
    expect(analyzeGoalEnd([assistant("  [GOAL_DONE]  ")])).toBe("done");
  });

  it("kendi satırında metinle devam eden [GOAL_BLOCKED] blocked sayılır (legacy davranışı)", () => {
    expect(analyzeGoalEnd([assistant("[GOAL_BLOCKED] anahtar gerekli")])).toBe("blocked");
    expect(analyzeGoalEnd([assistant("Not:\n[GOAL_BLOCKED] — kullanıcı girdisi bekliyorum")])).toBe(
      "blocked",
    );
  });

  it("metin ortasında anılan token sentinel sayılmaz", () => {
    expect(
      analyzeGoalEnd([assistant("Protokolü bilirsin: mesajı [GOAL_DONE] ile bitir.")]),
    ).toBeUndefined();
    expect(
      analyzeGoalEnd([assistant("Rehber: [GOAL_BLOCKED] yazmayı öğren; sonra örnek ver.")]),
    ).toBeUndefined();
  });

  it("sentinel yoksa ya da mesaj yoksa undefined döner", () => {
    expect(analyzeGoalEnd([user("selam"), assistant("Yapıyorum.")])).toBeUndefined();
    expect(analyzeGoalEnd([])).toBeUndefined();
    expect(analyzeGoalEnd([user("sadece kullanıcı")])).toBeUndefined();
  });

  it("son asistan mesajına bakar; aradaki eskiler sayılmaz", () => {
    expect(
      analyzeGoalEnd([
        assistant("[GOAL_DONE]"),
        user("devam"),
        assistant("Devam ediyorum, 2. adım."),
      ]),
    ).toBeUndefined();
  });
});
