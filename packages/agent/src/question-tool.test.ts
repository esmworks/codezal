import type { QuestionAnswers, QuestionItem, QuestionRequest } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { type QuestionBridge, QuestionGate, questionTool } from "./question-tool.js";

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

function fakeBridge(answers: QuestionAnswers) {
  const state = { seen: [] as QuestionItem[][] };
  const bridge: QuestionBridge = {
    ask: async (questions) => {
      state.seen.push(questions);
      return answers;
    },
  };
  return { bridge, state };
}

interface Params {
  questions: Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

const run = (tool: ReturnType<typeof questionTool>, params: Params) =>
  tool.execute("t1", params, undefined, undefined, {} as never);

describe("QuestionGate", () => {
  it("isteği yayınlar, cevapla çözülür ve bekleyenlerden düşer", async () => {
    let request: QuestionRequest | undefined;
    const gate = new QuestionGate((r) => {
      request = r;
    });
    const questions: QuestionItem[] = [{ question: "Hangisi?", multiple: false, custom: true }];
    const p = gate.request("s1", questions);
    expect(request).toMatchObject({ sessionId: "s1", questions });
    expect(gate.pendingFor("s1")?.requestId).toBe(request?.requestId);
    expect(gate.respond(request?.requestId ?? "", [["A"]])).toBe(true);
    await expect(p).resolves.toEqual([["A"]]);
    expect(gate.pendingFor("s1")).toBeUndefined();
    expect(gate.respond("yok", [])).toBe(false);
  });

  it("iptalde oturumun bekleyenleri boş yanıtla çözülür", async () => {
    const gate = new QuestionGate(() => {});
    const a = gate.request("s1", [
      { question: "a", multiple: false, custom: true },
      { question: "b", multiple: false, custom: true },
    ]);
    const b = gate.request("s2", [{ question: "c", multiple: false, custom: true }]);
    gate.rejectAll("s1");
    await expect(a).resolves.toEqual([[], []]);
    expect(gate.pendingFor("s2")).toBeDefined();
    gate.rejectAll("s2");
    await expect(b).resolves.toEqual([[]]);
  });
});

describe("question aracı", () => {
  it("soruları köprüye verir, yanıtları modele metin olarak döner", async () => {
    const { bridge, state } = fakeBridge([["A"], ["kendi yanıtım"]]);
    const tool = questionTool(bridge);
    const result = await run(tool, {
      questions: [
        { question: "Hangisi?", options: [{ label: "A", description: "ilk" }, { label: "B" }] },
        { question: "Not?", multiple: true },
      ],
    });
    expect(textOf(result)).toContain("Hangisi?");
    expect(textOf(result)).toContain("A");
    expect(textOf(result)).toContain("kendi yanıtım");
    expect(result.details).toEqual({ answers: [["A"], ["kendi yanıtım"]] });
    // Sözleşme varsayılanları doldurulur: custom açık, multiple kapalı.
    expect(state.seen[0]?.[0]).toMatchObject({ multiple: false, custom: true });
    expect(state.seen[0]?.[1]).toMatchObject({ multiple: true, custom: true });
  });

  it("seçenek yoksa custom zorunlu; seçenekli soruda custom false korunur", async () => {
    const { bridge, state } = fakeBridge([["x"]]);
    const tool = questionTool(bridge);
    await run(tool, {
      questions: [
        { question: "Serbest", custom: false },
        { question: "Seçmeli", options: [{ label: "C" }], custom: false },
      ],
    });
    expect(state.seen[0]?.[0]).toMatchObject({ custom: true });
    expect(state.seen[0]?.[0]?.options).toBeUndefined();
    expect(state.seen[0]?.[1]).toMatchObject({ custom: false });
  });

  it("boş yanıtı '(kullanıcı yanıt vermedi)' olarak yazar", async () => {
    const { bridge } = fakeBridge([[]]);
    const tool = questionTool(bridge, "tr");
    const result = await run(tool, { questions: [{ question: "Hangisi?" }] });
    expect(textOf(result)).toContain("(kullanıcı yanıt vermedi)");
  });
});
