import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  analyzeTurn,
  NUDGE_TYPE,
  nudgedKinds,
  turnMessages,
  turnTouchedFiles,
  turnTouchedPaths,
} from "./turn-guard.js";

const user = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});
const assistant = (
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >,
  stopReason: "stop" | "aborted" | "error" | "toolUse" = "stop",
): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "x",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason,
    timestamp: 2,
  }) as unknown as AgentMessage;
const result = (toolCallId: string, isError = false): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "x",
    content: [{ type: "text", text: "ok" }],
    isError,
    timestamp: 3,
  }) as unknown as AgentMessage;
const nudge = (kind: string): AgentMessage =>
  ({
    role: "custom",
    customType: NUDGE_TYPE,
    content: "…",
    display: false,
    details: { kind },
    timestamp: 4,
  }) as unknown as AgentMessage;

describe("turnMessages", () => {
  it("son kullanıcı mesajından sonrasını verir", () => {
    const a = assistant([{ type: "text", text: "a" }]);
    const b = assistant([{ type: "text", text: "b" }]);
    expect(turnMessages([user("1"), a, user("2"), b])).toEqual([b]);
  });
});

describe("analyzeTurn", () => {
  it("metinsiz ve araçsız bitişte boş yanıt dürtmesi ister", () => {
    const msgs = [
      user("çiz"),
      assistant(
        [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.pdf" } }],
        "toolUse",
      ),
      result("t1"),
      assistant([]),
    ];
    expect(analyzeTurn(msgs, { mode: "kodlama" })).toEqual({ kind: "empty-response" });
  });

  it("aynı dürtme bir turda ikinci kez gönderilmez", () => {
    const msgs = [user("çiz"), assistant([]), nudge("empty-response"), assistant([])];
    expect(analyzeTurn(msgs, { mode: "kodlama" })).toBeUndefined();
    expect(nudgedKinds(turnMessages(msgs))).toEqual(new Set(["empty-response"]));
  });

  it("kesilen ve hatalı turlar dürtülmez", () => {
    expect(analyzeTurn([user("x"), assistant([], "aborted")], { mode: "kodlama" })).toBeUndefined();
    expect(analyzeTurn([user("x"), assistant([], "error")], { mode: "kodlama" })).toBeUndefined();
  });

  it("Asistan: yazılan betik çalıştırılmadıysa çalıştırma dürtmesi ister", () => {
    const msgs = [
      user("çiz"),
      assistant(
        [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "/out/cizim.py", content: "x" },
          },
        ],
        "toolUse",
      ),
      result("w1"),
      assistant([{ type: "text", text: "Betiği yazdım." }]),
    ];
    expect(analyzeTurn(msgs, { mode: "asistan" })).toEqual({
      kind: "unrun-script",
      path: "/out/cizim.py",
    });
    // Kodlama modunda betik yazmak olağan iş; dürtme yok.
    expect(analyzeTurn(msgs, { mode: "kodlama" })).toBeUndefined();
  });

  it("betik terminalde çalıştırıldıysa ya da yazımı başarısızsa dürtme yok", () => {
    const ran = [
      user("çiz"),
      assistant(
        [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "cizim.py", content: "x" },
          },
          { type: "toolCall", id: "b1", name: "bash", arguments: { command: "python3 cizim.py" } },
        ],
        "toolUse",
      ),
      result("w1"),
      result("b1"),
      assistant([{ type: "text", text: "Çizim hazır." }]),
    ];
    expect(analyzeTurn(ran, { mode: "asistan" })).toBeUndefined();
    const failed = [
      user("çiz"),
      assistant(
        [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "cizim.py", content: "x" },
          },
        ],
        "toolUse",
      ),
      result("w1", true),
      assistant([{ type: "text", text: "Yazamadım." }]),
    ];
    expect(analyzeTurn(failed, { mode: "asistan" })).toBeUndefined();
  });

  it("Markdown gibi betik olmayan dosyalar dürtme yaratmaz", () => {
    const msgs = [
      user("rapor"),
      assistant(
        [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "rapor.md", content: "x" },
          },
        ],
        "toolUse",
      ),
      result("w1"),
      assistant([{ type: "text", text: "Rapor hazır." }]),
    ];
    expect(analyzeTurn(msgs, { mode: "asistan" })).toBeUndefined();
  });

  it("turdaki task_list açık adım bıraktıysa kapatma dürtmesi ister", () => {
    const msgs = [
      user("siteyi düzelt"),
      assistant(
        [
          {
            type: "toolCall",
            id: "tl1",
            name: "task_list",
            arguments: {
              steps: [
                { title: "sitemap.ts", status: "done" },
                { title: "robots.ts", status: "active" },
                { title: "not-found.tsx", status: "pending" },
              ],
            },
          },
        ],
        "toolUse",
      ),
      result("tl1"),
      assistant([{ type: "text", text: "Bitti." }]),
    ];
    expect(analyzeTurn(msgs, { mode: "kodlama" })).toEqual({
      kind: "open-steps",
      open: ["robots.ts", "not-found.tsx"],
    });
    // Asistan modunda da geçerli: adım listesi her modda kullanılıyor.
    expect(analyzeTurn(msgs, { mode: "asistan" })).toEqual({
      kind: "open-steps",
      open: ["robots.ts", "not-found.tsx"],
    });
  });

  it("tüm adımlar bittiyse ya da bu turda liste kullanılmadıysa dürtme yok", () => {
    const allDone = [
      user("siteyi düzelt"),
      assistant(
        [
          {
            type: "toolCall",
            id: "tl1",
            name: "task_list",
            arguments: { steps: [{ title: "robots.ts", status: "done" }] },
          },
        ],
        "toolUse",
      ),
      result("tl1"),
      assistant([{ type: "text", text: "Bitti." }]),
    ];
    expect(analyzeTurn(allDone, { mode: "kodlama" })).toBeUndefined();
  });

  it("önceki turdan kalan açık liste yeni turda dürtmez", () => {
    const firstTurn = [
      user("siteyi düzelt"),
      assistant(
        [
          {
            type: "toolCall",
            id: "tl1",
            name: "task_list",
            arguments: { steps: [{ title: "robots.ts", status: "pending" }] },
          },
        ],
        "toolUse",
      ),
      result("tl1"),
      assistant([{ type: "text", text: "Yarıda bıraktım." }]),
      // Kullanıcı yeni bir iş istedi: eski liste dürtme tetiklemez.
      user("başka bir şey"),
      assistant([{ type: "text", text: "Tamam." }]),
    ];
    expect(analyzeTurn(firstTurn, { mode: "kodlama" })).toBeUndefined();
    // Aynı turda açık liste varken dürtme gelir (karşılaştırma).
    expect(analyzeTurn(firstTurn.slice(0, 4), { mode: "kodlama" })).toEqual({
      kind: "open-steps",
      open: ["robots.ts"],
    });
  });

  it("başarısız task_list çağrısı açık adım sayılmaz, aynı dürtme turda ikinci kez gitmez", () => {
    const failed = [
      user("iş"),
      assistant(
        [
          {
            type: "toolCall",
            id: "tl1",
            name: "task_list",
            arguments: { steps: [{ title: "eksik adım" }] },
          },
        ],
        "toolUse",
      ),
      result("tl1", true),
      assistant([{ type: "text", text: "Şema hatası aldım." }]),
    ];
    expect(analyzeTurn(failed, { mode: "kodlama" })).toBeUndefined();
    const nudged = [
      user("iş"),
      assistant(
        [
          {
            type: "toolCall",
            id: "tl1",
            name: "task_list",
            arguments: { steps: [{ title: "açık adım", status: "pending" }] },
          },
        ],
        "toolUse",
      ),
      result("tl1"),
      nudge("open-steps"),
      assistant([{ type: "text", text: "Kapatmıyorum." }]),
    ];
    expect(analyzeTurn(nudged, { mode: "kodlama" })).toBeUndefined();
    expect(nudgedKinds(turnMessages(nudged)).has("open-steps")).toBe(true);
  });
});

describe("turnTouchedFiles", () => {
  it("başarılı edit/write varsa doğru, yalnızca okuma ya da başarısız yazma varsa yanlış", () => {
    const edited = [
      user("x"),
      assistant(
        [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts" } }],
        "toolUse",
      ),
      result("e1"),
      assistant([{ type: "text", text: "ok" }]),
    ];
    expect(turnTouchedFiles(turnMessages(edited))).toBe(true);
    const readOnly = [
      user("x"),
      assistant(
        [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }],
        "toolUse",
      ),
      result("r1"),
      assistant([{ type: "text", text: "ok" }]),
    ];
    expect(turnTouchedFiles(turnMessages(readOnly))).toBe(false);
    const failed = [
      user("x"),
      assistant(
        [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts" } }],
        "toolUse",
      ),
      result("e1", true),
      assistant([{ type: "text", text: "ok" }]),
    ];
    expect(turnTouchedFiles(turnMessages(failed))).toBe(false);
  });
});

describe("turnTouchedPaths", () => {
  it("başarıyla değişen dosyaları depo-göreli döndürür, başarısızı ve kapsam dışını atlar", () => {
    const msgs = [
      user("x"),
      assistant(
        [
          { type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/a.ts" } },
          { type: "toolCall", id: "e2", name: "write", arguments: { path: "/repo/src/b.ts" } },
          { type: "toolCall", id: "e3", name: "edit", arguments: { path: "src/c.ts" } },
          { type: "toolCall", id: "e4", name: "edit", arguments: { path: "../d.ts" } },
        ],
        "toolUse",
      ),
      result("e1"),
      result("e2"),
      result("e3", true),
      result("e4"),
      assistant([{ type: "text", text: "ok" }]),
    ];
    expect(turnTouchedPaths(turnMessages(msgs), "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("aynı dosyayı bir kez döndürür", () => {
    const msgs = [
      user("x"),
      assistant(
        [
          { type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/a.ts" } },
          { type: "toolCall", id: "e2", name: "write", arguments: { path: "src/a.ts" } },
        ],
        "toolUse",
      ),
      result("e1"),
      result("e2"),
      assistant([{ type: "text", text: "ok" }]),
    ];
    expect(turnTouchedPaths(turnMessages(msgs), "/repo")).toEqual(["src/a.ts"]);
  });
});
