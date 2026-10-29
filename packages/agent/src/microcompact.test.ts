import { describe, expect, it } from "vitest";
import { KEEP_RECENT_TOOL_RESULTS, MIN_DROPPABLE_CHARS, microcompact } from "./microcompact.js";

/** Test mesajı: araç sonucu ve (istenirse) görsel bloğu. */
interface TestMessage {
  role: string;
  toolName: string;
  content: ({ type: "text"; text: string } | { type: "image"; data: string })[];
}

/** Uzun metinli araç sonucu mesajı. */
function toolResult(toolName: string, length: number): TestMessage {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: "x".repeat(length) }],
  };
}

const placeholder = (tool: string) => `[${tool} çıktısı düşürüldü]`;

/** Mesajın ilk metin bloğunun içeriği; metin bloğu yoksa boş dize. */
function textOf(message: TestMessage | undefined): string {
  const block = message?.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

/** Bir mesaj listesindeki toplam metin uzunluğu. */
function totalChars(messages: readonly TestMessage[]): number {
  let total = 0;
  for (const m of messages)
    for (const b of m.content) if (b.type === "text") total += b.text.length;
  return total;
}

describe("microcompact", () => {
  it("en yeni sonuçları korur, eskileri düşürür", () => {
    const messages = Array.from({ length: 8 }, (_, i) => toolResult(`t${i}`, 5_000));
    const saved = microcompact(messages, placeholder);

    expect(saved).toBeGreaterThan(0);
    // Son N sonuç dokunulmadan kalır: modelin üzerinde çalıştığı bağlam bunlar.
    for (let i = 8 - KEEP_RECENT_TOOL_RESULTS; i < 8; i++) {
      expect(textOf(messages[i])).toBe("x".repeat(5_000));
    }
    // Baştaki düşürülür.
    expect(textOf(messages[0])).toBe(placeholder("t0"));
  });

  it("kazanç eşiğin altındaysa hiçbir şeyi değiştirmez", () => {
    const messages = [toolResult("a", 500), toolResult("b", 500), toolResult("c", 100)];
    const before = totalChars(messages);
    expect(microcompact(messages, placeholder)).toBe(0);
    expect(totalChars(messages)).toBe(before);
  });

  it("kısa sonuçları düşürmez", () => {
    // Uzun bir sonuç eşiği geçirir; kısa olan yerinde kalır.
    const messages = [toolResult("kisa", MIN_DROPPABLE_CHARS - 1), toolResult("uzun", 20_000)];
    microcompact(messages, placeholder);
    expect(textOf(messages[0])).toHaveLength(MIN_DROPPABLE_CHARS - 1);
  });

  it("araç olmayan mesajlara ve görselli sonuçlara dokunmaz", () => {
    const user: TestMessage = {
      role: "user",
      toolName: "",
      content: [{ type: "text", text: "y".repeat(9_000) }],
    };
    const withImage: TestMessage = {
      role: "toolResult",
      toolName: "read",
      content: [
        { type: "text", text: "z".repeat(9_000) },
        { type: "image", data: "AAAA" },
      ],
    };
    const filler = Array.from({ length: 8 }, (_, i) => toolResult(`t${i}`, 5_000));
    const messages = [user, withImage, ...filler];

    microcompact(messages, placeholder);

    expect(textOf(user)).toBe("y".repeat(9_000));
    expect(textOf(withImage)).toBe("z".repeat(9_000));
  });

  it("hata sonuçlarını düşürmez", () => {
    const failed = { ...toolResult("bash", 9_000), isError: true };
    const filler = Array.from({ length: 8 }, (_, i) => toolResult(`t${i}`, 5_000));
    const messages = [failed, ...filler];

    expect(microcompact(messages, placeholder)).toBeGreaterThan(0);

    expect(textOf(failed)).toBe("x".repeat(9_000));
    // Hatalı sonuç "son N" sayımına girmez: dolgu sonuçlarından eskiler yine düşer.
    expect(textOf(filler[0])).toBe(placeholder("t0"));
  });

  it("birden çok metin bloğunu da düşürür ve kazancı doğru bildirir", () => {
    const multi: TestMessage = {
      role: "toolResult",
      toolName: "bash",
      content: [
        { type: "text", text: "a".repeat(3_000) },
        { type: "text", text: "b".repeat(3_000) },
      ],
    };
    const messages = [multi, ...Array.from({ length: 5 }, (_, i) => toolResult(`t${i}`, 100))];
    const before = totalChars(messages);
    const saved = microcompact(messages, placeholder);

    expect(before - totalChars(messages)).toBe(saved);
    expect(textOf(multi)).toBe(placeholder("bash"));
    expect(multi.content[1]).toEqual({ type: "text", text: placeholder("bash") });
  });
});
