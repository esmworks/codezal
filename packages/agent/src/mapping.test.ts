import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  changedFilesOf,
  EventMapper,
  outputOfResult,
  resolvedTargetOf,
  sandboxedOf,
  scheduleResultOf,
  TOOL_STOP_TYPE,
  toolStopsOf,
  transcriptFromMessages,
} from "./mapping.js";
import { describeTool } from "./tool-info.js";
import { wrapUntrusted } from "./untrusted.js";

const assistant = (over: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "Merhaba" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-x",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...over,
  }) as AssistantMessage;

/** Gizli motor dürtmesi; kaydedilmiş oturumda `custom` mesaj olarak durur. */
const nudge = (kind: string, timestamp = 5, display = false): AgentMessage =>
  ({
    role: "custom",
    customType: "codezal-nudge",
    content: "dürtme",
    display,
    details: { kind },
    timestamp,
  }) as AgentMessage;

describe("describeTool", () => {
  it("araçları tasarımdaki kartlara eşler", () => {
    expect(describeTool("read", { path: "a.ts" })).toMatchObject({ kind: "read", target: "a.ts" });
    expect(describeTool("read", { path: "Bağlam/katalog.pdf", search: "GS-450" })).toMatchObject({
      kind: "search",
      target: "GS-450 · katalog.pdf",
    });
    expect(describeTool("grep", { pattern: "foo" })).toMatchObject({
      kind: "search",
      target: "foo",
    });
    expect(describeTool("write", { path: "b.ts" })).toMatchObject({ kind: "create" });
    expect(describeTool("edit", { path: "c.ts" })).toMatchObject({ kind: "edit" });
    expect(describeTool("bash", { command: "pnpm test" })).toMatchObject({ kind: "terminal" });
    expect(describeTool("bash", { command: "rm old.txt" })).toMatchObject({ kind: "delete" });
    expect(
      describeTool("bash_background", { action: "start", command: "pnpm test" }),
    ).toMatchObject({ kind: "terminal", title: "Arka planda çalıştırıldı", command: "pnpm test" });
    expect(describeTool("bash_background", { action: "output", id: "bg-1" })).toMatchObject({
      kind: "other",
      target: "bg-1",
    });
    expect(
      describeTool("agent", { subagent_type: "explore", prompt: "izin kapısı nerede" }),
    ).toMatchObject({
      kind: "search",
      title: "Keşfedildi",
      target: "izin kapısı nerede",
    });
    expect(
      describeTool("agent", { subagent_type: "rapor-yazari", description: "Raporu yaz" }),
    ).toMatchObject({
      kind: "other",
      title: "Ajana devredildi",
      target: "rapor-yazari · Raporu yaz",
    });
    expect(describeTool("agent", { subagent_type: "rapor-yazari" })).toMatchObject({
      target: "rapor-yazari",
    });
  });

  it("denetim kartlarında hedefi okunur sayıyla etiketler", () => {
    expect(
      describeTool("audit_hunt", { units: ["u1", "u2", "u3", "u4", "u5", "u6"] }),
    ).toMatchObject({ kind: "audit", title: "Denetim: av", target: "6 birim" });
    expect(describeTool("audit_verify", { candidates: ["c1", "c2", "c3"] })).toMatchObject({
      kind: "audit",
      title: "Denetim: doğrulama",
      target: "3 aday",
    });
    expect(describeTool("audit_hunt", { units: ["main/auth"] })).toMatchObject({
      target: "main/auth",
    });
  });
});

describe("EventMapper", () => {
  it("auto_retry_start → bekliyor + retry; auto_retry_end eşlenmez", () => {
    const m = new EventMapper("s1");
    const out = m.map({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "429 rate limit",
    });
    expect(out).toEqual([
      expect.objectContaining({ type: "status", status: "waiting" }),
      expect.objectContaining({
        type: "retry",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        message: "429 rate limit",
      }),
    ]);
    expect(m.map({ type: "auto_retry_end", success: true, attempt: 1 })).toEqual([]);
  });

  it("Durdur'dan sonra gelen hata yanıtı bant olmaz, tur durdurulmuş kapanır", () => {
    const failed = assistant({
      content: [],
      stopReason: "error",
      errorMessage: "This operation was aborted",
    });
    const run = (m: EventMapper, stop: boolean) => {
      m.map({ type: "agent_start" });
      if (stop) m.noteStop();
      return [
        ...m.map({ type: "message_end", message: failed }),
        ...m.map({ type: "agent_end", messages: [failed], willRetry: false }),
      ];
    };
    const m = new EventMapper("s1");
    const stopped = run(m, true);
    expect(stopped.some((e) => e.type === "error")).toBe(false);
    expect(stopped).toContainEqual(
      expect.objectContaining({ type: "message_end", stopReason: "aborted" }),
    );
    expect(stopped).toContainEqual(expect.objectContaining({ type: "run_end", aborted: true }));
    // Bayrak tur kapanınca söner: sonraki turdaki gerçek hata yine bant olur.
    expect(run(m, false)).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("Durdur'un kestiği araç çağrısı tool_end'de durdurulmuş işaretlenir", () => {
    const end = (m: EventMapper) =>
      m.map({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "Command aborted" }], details: {} },
        isError: true,
      });
    const m = new EventMapper("s1");
    m.map({ type: "agent_start" });
    expect(end(m)[0]).not.toHaveProperty("stopped");
    m.noteStop();
    expect(end(m)[0]).toMatchObject({ type: "tool_end", isError: true, stopped: true });
  });

  it("queue_update → queue: bekleyen yönlendirme ve takip mesajları", () => {
    const m = new EventMapper("s1");
    const out = m.map({
      type: "queue_update",
      steering: ["şunu da ekle"],
      followUp: ["sonra şuna bak"],
    });
    expect(out).toEqual([
      expect.objectContaining({
        type: "queue",
        sessionId: "s1",
        steering: ["şunu da ekle"],
        followUp: ["sonra şuna bak"],
      }),
    ]);
  });

  it("bir çalıştırmayı run_start → text_delta → message_end/usage → run_end olarak eşler", () => {
    const m = new EventMapper("s1");
    const msg = assistant();
    const events: AgentSessionEvent[] = [
      { type: "agent_start" },
      { type: "message_start", message: msg },
      {
        type: "message_update",
        message: msg,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Mer", partial: msg },
      },
      { type: "message_end", message: msg },
      { type: "agent_end", messages: [msg], willRetry: false },
    ];
    const out = events.flatMap((e) => m.map(e));
    expect(out.map((e) => e.type)).toEqual([
      "run_start",
      "status",
      "text_delta",
      "message_end",
      "usage",
      "run_end",
      "status",
    ]);
    const end = out.find((e) => e.type === "message_end");
    expect(end).toMatchObject({ text: "Merhaba", model: "claude-x" });
    const usage = out.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ usage: { input: 10, output: 5 } });
  });

  it("açık turun kimliğini verir; tur kapanınca boşalır", () => {
    const m = new EventMapper("s1");
    const msg = assistant();
    expect(m.runId).toBeUndefined();
    // Snapshot'a taşınan kimlik, `run_start` ile yayınlanan kimlikle aynı olmalı.
    const start = m.map({ type: "agent_start" });
    expect(start[0]).toMatchObject({ type: "run_start" });
    const runId = m.runId;
    expect(runId).toBe(start[0]?.type === "run_start" ? start[0].runId : undefined);
    m.map({ type: "agent_end", messages: [msg], willRetry: false });
    expect(m.runId).toBeUndefined();
  });

  it("thinking_end olayı aynı mesaj kimliğiyle eşlenir", () => {
    const m = new EventMapper("s1");
    const msg = assistant();
    m.map({ type: "message_start", message: msg } as AgentSessionEvent);
    const [delta] = m.map({
      type: "message_update",
      message: msg,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "…", partial: msg },
    } as AgentSessionEvent);
    const [end] = m.map({
      type: "message_update",
      message: msg,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "…",
        partial: msg,
      },
    } as AgentSessionEvent);
    expect(end).toMatchObject({ type: "thinking_end" });
    expect(end && "messageId" in end && end.messageId).toBe(
      delta && "messageId" in delta ? delta.messageId : undefined,
    );
  });

  it("araç yürütmesini tool_start/tool_end olarak eşler, edit için diff taşır", () => {
    const m = new EventMapper("s1");
    const start = m.map({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "a.ts" },
    });
    expect(start[0]).toMatchObject({ type: "tool_start", kind: "edit", target: "a.ts" });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "edit",
      result: { content: [{ type: "text", text: "ok" }], details: { diff: "-a\n+b" } },
      isError: false,
    });
    expect(end[0]).toMatchObject({ type: "tool_end", output: "-a\n+b", isError: false });
  });

  it("write için sonuçta diff yoksa içerikten +N diff üretir", () => {
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "w1",
      toolName: "write",
      args: { path: "rapor.md", content: "# Başlık\n\nmetin\n" },
    });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "w1",
      toolName: "write",
      result: { content: [{ type: "text", text: "Successfully wrote to rapor.md" }] },
      isError: false,
    });
    expect(end[0]).toMatchObject({ type: "tool_end", output: "+1 # Başlık\n+2 \n+3 metin" });
  });

  it("arama yolunu tool_end'e taşır: yerleşik arama ve DuckDuckGo", () => {
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "s1",
      toolName: "web_search",
      args: { query: "ZCode" },
    });
    const native = m.map({
      type: "tool_execution_end",
      toolCallId: "s1",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "Özet: …" }],
        details: { query: "ZCode", endpoint: "native", sources: [] },
      },
      isError: false,
    });
    expect(native[0]).toMatchObject({ type: "tool_end", searchBackend: "native" });

    const m2 = new EventMapper("s1");
    m2.map({
      type: "tool_execution_start",
      toolCallId: "s2",
      toolName: "web_search",
      args: { query: "ZCode" },
    });
    const lite = m2.map({
      type: "tool_execution_end",
      toolCallId: "s2",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "1. sonuç" }],
        details: { query: "ZCode", endpoint: "lite", results: [] },
      },
      isError: false,
    });
    expect(lite[0]).toMatchObject({ type: "tool_end", searchBackend: "lite" });
  });

  it("açık arama sağlayıcısını (SearXNG, Brave) tool_end'e taşır", () => {
    for (const endpoint of ["searxng", "brave"] as const) {
      const m = new EventMapper("s1");
      m.map({
        type: "tool_execution_start",
        toolCallId: endpoint,
        toolName: "web_search",
        args: { query: "ZCode" },
      });
      const end = m.map({
        type: "tool_execution_end",
        toolCallId: endpoint,
        toolName: "web_search",
        result: {
          content: [{ type: "text", text: "1. sonuç" }],
          details: { query: "ZCode", endpoint, results: [] },
        },
        isError: false,
      });
      expect(end[0]).toMatchObject({ type: "tool_end", searchBackend: endpoint });
    }
  });

  it("pdf_create biterken kart hedefi aracın çözdüğü mutlak yola döner", () => {
    const m = new EventMapper("s1");
    const start = m.map({
      type: "tool_execution_start",
      toolCallId: "p1",
      toolName: "pdf_create",
      args: { path: "rapor", html: "<h1>x</h1>" },
    });
    expect(start[0]).toMatchObject({ type: "tool_start", target: "rapor" });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "p1",
      toolName: "pdf_create",
      result: {
        content: [{ type: "text", text: "PDF oluşturuldu" }],
        details: { path: "/belgeler/Çıktılar/rapor.pdf", bytes: 10, pages: 1 },
      },
      isError: false,
    });
    expect(end[0]).toMatchObject({ type: "tool_end", target: "/belgeler/Çıktılar/rapor.pdf" });
  });

  it("çözülmüş hedef yalnız başarılı dosya üreten araçta ve mutlak yolda taşınır", () => {
    const pdf = { details: { path: "/a/rapor.pdf" } };
    expect(resolvedTargetOf("pdf_create", pdf, false)).toBe("/a/rapor.pdf");
    expect(resolvedTargetOf("docx_create", { details: { path: "/a/rapor.docx" } }, false)).toBe(
      "/a/rapor.docx",
    );
    expect(resolvedTargetOf("xlsx_create", { details: { path: "/a/tablo.xlsx" } }, false)).toBe(
      "/a/tablo.xlsx",
    );
    expect(resolvedTargetOf("pdf_create", pdf, true)).toBeUndefined();
    expect(resolvedTargetOf("write", pdf, false)).toBeUndefined();
    expect(resolvedTargetOf("read", pdf, false)).toBeUndefined();
    expect(
      resolvedTargetOf("pdf_create", { details: { path: "rapor.pdf" } }, false),
    ).toBeUndefined();
    expect(resolvedTargetOf("pdf_create", { content: [] }, false)).toBeUndefined();
  });

  it("arama dışı araçta ve tanınmayan uç noktada etiket taşımaz", () => {
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "r1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    const read = m.map({
      type: "tool_execution_end",
      toolCallId: "r1",
      toolName: "read",
      result: { content: [{ type: "text", text: "x" }], details: { endpoint: "native" } },
      isError: false,
    });
    expect(read[0]).not.toHaveProperty("searchBackend");

    const m2 = new EventMapper("s1");
    m2.map({
      type: "tool_execution_start",
      toolCallId: "s3",
      toolName: "web_search",
      args: { query: "x" },
    });
    const unknown = m2.map({
      type: "tool_execution_end",
      toolCallId: "s3",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "x" }],
        details: { query: "x", endpoint: "searx" },
      },
      isError: false,
    });
    expect(unknown[0]).not.toHaveProperty("searchBackend");
  });

  it("korumalı alanda koşan bash bitişi sandboxed taşır (hata da olsa)", () => {
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "touch /x" },
    });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "b1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "Operation not permitted" }],
        details: { sandboxed: true },
      },
      isError: true,
    });
    expect(end[0]).toMatchObject({ type: "tool_end", sandboxed: true });
    // Başka araçta ve işaretsiz bash'te alan yazılmaz.
    expect(sandboxedOf("read", { details: { sandboxed: true } })).toBe(false);
    expect(sandboxedOf("bash", { details: {} })).toBe(false);
  });

  it("write hata verirse içerik değil hata metni taşınır", () => {
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "w2",
      toolName: "write",
      args: { path: "x", content: "a" },
    });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "w2",
      toolName: "write",
      result: { content: [{ type: "text", text: "EACCES" }] },
      isError: true,
    });
    expect(end[0]).toMatchObject({ output: "EACCES" });
  });

  it("kullanıcı mesajının oturuma girişini user_message olarak eşler", () => {
    const m = new EventMapper("s1");
    const out = m.map({
      type: "message_end",
      message: { role: "user", content: "merhaba", timestamp: 1 },
    } as AgentSessionEvent);
    expect(out).toEqual([expect.objectContaining({ type: "user_message", sessionId: "s1" })]);
  });

  it("gizli dürtmenin teslimini boundary olarak eşler", () => {
    const m = new EventMapper("s1");
    const out = m.map({ type: "message_end", message: nudge("background") } as AgentSessionEvent);
    expect(out).toEqual([
      expect.objectContaining({ type: "boundary", sessionId: "s1", kind: "background" }),
    ]);
    // Tanınmayan ya da görünür özel mesaj sınır üretmez.
    expect(
      m.map({ type: "message_end", message: nudge("bilinmeyen") } as AgentSessionEvent),
    ).toEqual([]);
    expect(
      m.map({ type: "message_end", message: nudge("background", 6, true) } as AgentSessionEvent),
    ).toEqual([]);
  });

  it("iptal edilen çalıştırmayı run_end.aborted=true yapar", () => {
    const m = new EventMapper("s1");
    const msg = assistant({ stopReason: "aborted" });
    m.map({ type: "agent_start" });
    m.map({ type: "message_end", message: msg });
    const out = m.map({ type: "agent_end", messages: [msg], willRetry: false });
    expect(out[0]).toMatchObject({ type: "run_end", aborted: true });
  });
});

/**
 * Canlı sayaç: model aracın girdisini üretirken (yazma/düzenleme) kart erken doğar ve `+N −N`
 * akış boyunca artar — ZCode da akış sırasında sayacı böyle tazeler (saniyede bir).
 */
describe("EventMapper canlı sayaç önizlemesi", () => {
  /** Akış sırasındaki araç çağrısı bloğu: kimlik sağlayıcıdan gelir, girdi henüz tamam değildir. */
  const call = (name: string, args: JsonObject) => ({
    type: "toolCall" as const,
    id: "call-1",
    name,
    arguments: args,
  });
  const stream = (
    block: ReturnType<typeof call>,
    type: "toolcall_start" | "toolcall_delta" | "toolcall_end",
  ): AgentSessionEvent => {
    const partial = assistant({ content: [block], stopReason: "toolUse" });
    return {
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type, contentIndex: 0, delta: "", toolCall: block, partial },
    } as AgentSessionEvent;
  };

  it("yazma sürerken satırı ve canlı sayacı yayınlar", () => {
    const m = new EventMapper("s1", "tr");
    const out = m.map(
      stream(call("write", { path: "a.ts", content: "bir\niki" }), "toolcall_delta"),
    );
    expect(out).toEqual([
      expect.objectContaining({
        type: "tool_preview",
        toolCallId: "call-1",
        kind: "create",
        target: "a.ts",
        added: 2,
        removed: 0,
      }),
    ]);
  });

  it("düzenlemede silinen satırları da sayar", () => {
    const m = new EventMapper("s1");
    const out = m.map(
      stream(
        call("edit", { path: "a.ts", edits: [{ oldText: "a\nb", newText: "a" }] }),
        "toolcall_start",
      ),
    );
    expect(out[0]).toMatchObject({ type: "tool_preview", kind: "edit", added: 0, removed: 1 });
  });

  it("saniye dolmadan gelen akış parçaları sayaç yayınlamaz", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const m = new EventMapper("s1");
      expect(
        m.map(stream(call("write", { path: "a.ts", content: "bir" }), "toolcall_delta")),
      ).toHaveLength(1);
      vi.setSystemTime(1_000_400);
      expect(
        m.map(stream(call("write", { path: "a.ts", content: "bir\niki" }), "toolcall_delta")),
      ).toEqual([]);
      vi.setSystemTime(1_001_200);
      expect(
        m.map(stream(call("write", { path: "a.ts", content: "bir\niki\nüç" }), "toolcall_delta")),
      ).toEqual([expect.objectContaining({ type: "tool_preview", added: 3 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("girdi tamamlanınca son ölçü sınır beklemeden yayınlanır", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      const m = new EventMapper("s1");
      m.map(stream(call("write", { path: "a.ts", content: "bir" }), "toolcall_delta"));
      vi.setSystemTime(2_000_100);
      const end = m.map(
        stream(call("write", { path: "a.ts", content: "bir\niki" }), "toolcall_end"),
      );
      expect(end).toEqual([expect.objectContaining({ type: "tool_preview", added: 2 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sayaç gösterilmeyen araçlarda önizleme yok", () => {
    const m = new EventMapper("s1");
    expect(m.map(stream(call("read", { path: "a.ts" }), "toolcall_delta"))).toEqual([]);
    expect(m.map(stream(call("bash", { command: "ls" }), "toolcall_delta"))).toEqual([]);
  });

  it("içerik henüz akmadıysa satır açılmaz", () => {
    const m = new EventMapper("s1");
    expect(m.map(stream(call("write", { path: "a.ts" }), "toolcall_start"))).toEqual([]);
  });
});

describe("transcriptFromMessages", () => {
  it("oturum kaydındaki durdurma işaretiyle hata yerine engellendi/reddedildi döner", () => {
    const blocked = (id: string): AgentMessage => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [{ type: "text", text: "engellendi" }],
      isError: true,
      timestamp: 3,
    });
    const messages: AgentMessage[] = [
      { role: "user", content: "çalıştır", timestamp: 1 },
      assistant({
        content: [
          { type: "toolCall", id: "p1", name: "bash", arguments: { command: "make" } },
          { type: "toolCall", id: "h1", name: "bash", arguments: { command: "rm -rf x" } },
          { type: "toolCall", id: "s1", name: "bash", arguments: { command: "sleep 9" } },
          { type: "toolCall", id: "e1", name: "bash", arguments: { command: "false" } },
        ],
      }),
      blocked("p1"),
      blocked("h1"),
      blocked("s1"),
      blocked("e1"),
    ];
    const stops = toolStopsOf([
      { type: "custom", customType: TOOL_STOP_TYPE, data: { toolCallId: "p1", reason: "blocked" } },
      { type: "custom", customType: TOOL_STOP_TYPE, data: { toolCallId: "h1", reason: "denied" } },
      { type: "custom", customType: TOOL_STOP_TYPE, data: { toolCallId: "s1", reason: "stopped" } },
      // Tanınmayan neden ve başka tür kayıt yok sayılır.
      { type: "custom", customType: TOOL_STOP_TYPE, data: { toolCallId: "e1", reason: "x" } },
      { type: "custom", customType: "başka", data: { toolCallId: "e1", reason: "blocked" } },
    ]);
    const statuses = transcriptFromMessages(messages, "tr", stops).flatMap((i) =>
      i.type === "tool" ? [i.status] : [],
    );
    expect(statuses).toEqual(["blocked", "denied", "stopped", "error"]);
  });

  it("kullanıcı, asistan ve araç sonuçlarını birleştirir", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "README'yi oku", timestamp: 1 },
      assistant({
        content: [
          { type: "text", text: "Okuyorum." },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "# Başlık" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const t = transcriptFromMessages(messages);
    expect(t.map((i) => i.type)).toEqual(["user", "assistant", "tool"]);
    expect(t[2]).toMatchObject({ status: "done", output: "# Başlık", target: "README.md" });
  });

  it("kaydedilmiş write sonucunu içerikten diff'e çevirir", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "yaz", timestamp: 1 },
      assistant({
        content: [
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "a.md", content: "x\ny" },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "w1",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote to a.md" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const t = transcriptFromMessages(messages);
    expect(t[2]).toMatchObject({ kind: "create", output: "+1 x\n+2 y" });
  });

  it("kaydedilmiş arama sonucundan arama yolunu geri okur", () => {
    const t = transcriptFromMessages([
      assistant({
        content: [
          { type: "toolCall", id: "s1", name: "web_search", arguments: { query: "ZCode" } },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "s1",
        toolName: "web_search",
        content: [{ type: "text", text: "1. sonuç" }],
        details: { query: "ZCode", endpoint: "html", results: [] },
        isError: false,
        timestamp: 3,
      },
    ]);
    expect(t[1]).toMatchObject({ searchBackend: "html" });
  });

  it("schedule_task sonucundan görev kartının verisini canlı ve kayıttan okur", () => {
    const task = {
      id: "g1",
      title: "Sabah özeti",
      prompt: "Uzun talimat",
      projectId: null,
      schedule: { kind: "daily", time: "09:00" },
      paused: false,
      model: null,
      permission: "plan",
      allowWeb: true,
      lastRunAt: null,
      lastResult: null,
      lastSessionId: null,
      nextRunAt: 5,
    };
    const m = new EventMapper("s1");
    m.map({
      type: "tool_execution_start",
      toolCallId: "z1",
      toolName: "schedule_task",
      args: { action: "create", title: "Sabah özeti" },
    });
    const end = m.map({
      type: "tool_execution_end",
      toolCallId: "z1",
      toolName: "schedule_task",
      result: {
        content: [{ type: "text", text: "Görev kaydedildi." }],
        details: { action: "create", task },
      },
      isError: false,
    });
    const expected = {
      action: "create",
      tasks: [
        {
          id: "g1",
          title: "Sabah özeti",
          projectId: null,
          schedule: { kind: "daily", time: "09:00" },
          paused: false,
          permission: "plan",
          allowWeb: true,
        },
      ],
    };
    // Talimat metni karta taşınmaz.
    expect(end[0]).toMatchObject({ type: "tool_end", schedule: expected });
    expect(JSON.stringify(end[0])).not.toContain("Uzun talimat");

    const t = transcriptFromMessages([
      assistant({
        content: [{ type: "toolCall", id: "z2", name: "schedule_task", arguments: {} }],
      }),
      {
        role: "toolResult",
        toolCallId: "z2",
        toolName: "schedule_task",
        content: [{ type: "text", text: "silindi" }],
        details: { action: "delete", task },
        isError: false,
        timestamp: 3,
      },
    ]);
    expect(t[1]).toMatchObject({ schedule: { action: "delete", tasks: [{ id: "g1" }] } });
  });

  it("schedule_task: hatalı, ayrıntısız ve eski kayıtlar", () => {
    const task = { id: "g1", title: "A", schedule: { kind: "manual", time: "09:00" } };
    expect(scheduleResultOf("schedule_task", { details: {} }, false)).toBeUndefined();
    expect(scheduleResultOf("schedule_task", { details: { task } }, true)).toBeUndefined();
    expect(scheduleResultOf("web_search", { details: { task } }, false)).toBeUndefined();
    expect(scheduleResultOf("schedule_task", { details: { task: { id: 1 } } }, false)).toBe(
      undefined,
    );
    // Eylemi yazmayan eski kayıt: tek görev "create", dizi "list"; şema varsayılanları dolar.
    expect(scheduleResultOf("schedule_task", { details: { task } }, false)).toEqual({
      action: "create",
      tasks: [{ ...task, projectId: null, paused: false, permission: "full", allowWeb: false }],
    });
    expect(scheduleResultOf("schedule_task", { details: { tasks: [task] } }, false)?.action).toBe(
      "list",
    );
  });

  it("kaydedilmiş pdf_create sonucundan çözülmüş yolu geri okur", () => {
    const t = transcriptFromMessages([
      assistant({
        content: [
          {
            type: "toolCall",
            id: "p1",
            name: "pdf_create",
            arguments: { path: "rapor.pdf", html: "<h1>x</h1>" },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "p1",
        toolName: "pdf_create",
        content: [{ type: "text", text: "PDF oluşturuldu" }],
        details: { path: "/belgeler/Çıktılar/rapor.pdf", bytes: 10, pages: 1 },
        isError: false,
        timestamp: 3,
      },
    ]);
    expect(t[1]).toMatchObject({ kind: "create", target: "/belgeler/Çıktılar/rapor.pdf" });
  });

  it("asistan süresini turun kullanıcı mesajından itibaren hesaplar", () => {
    const t = transcriptFromMessages([
      { role: "user", content: "x", timestamp: 1000 },
      assistant({ content: [{ type: "text", text: "a" }], timestamp: 4500 }),
      { role: "user", content: "y", timestamp: 9000 },
      assistant({ content: [{ type: "text", text: "b" }], timestamp: 9200 }),
    ]);
    expect(t[1]).toMatchObject({ durationMs: 3500 });
    expect(t[3]).toMatchObject({ durationMs: 200 });
  });

  it("gizli dürtmeyi çizilmeyen sınır öğesine çevirir", () => {
    const t = transcriptFromMessages([
      { role: "user", content: "iş", timestamp: 1 },
      assistant({ content: [{ type: "text", text: "rapor" }], timestamp: 2 }),
      nudge("background", 3),
      assistant({ content: [{ type: "text", text: "bildirim" }], timestamp: 4 }),
    ]);
    expect(t.map((i) => i.type)).toEqual(["user", "assistant", "boundary", "assistant"]);
    expect(t[2]).toMatchObject({ kind: "background", at: 3 });
  });

  it("normal bitişte stopReason taşımaz, hata ve kesmede taşır", () => {
    const t = transcriptFromMessages([
      assistant({ content: [{ type: "text", text: "a" }] }),
      assistant({ content: [{ type: "text", text: "b" }], stopReason: "error" }),
      assistant({ content: [{ type: "text", text: "c" }], stopReason: "aborted" }),
    ]);
    expect(t[0]).not.toHaveProperty("stopReason");
    expect(t[1]).toMatchObject({ stopReason: "error" });
    expect(t[2]).toMatchObject({ stopReason: "aborted" });
  });
});

describe("transcriptFromMessages görseller", () => {
  it("kullanıcı mesajındaki görsel bloklarını eke çevirir", () => {
    const items = transcriptFromMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Bu ne?" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
        timestamp: 1,
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        type: "user",
        text: "Bu ne?",
        images: [{ mimeType: "image/png", data: "AAAA" }],
      }),
    ]);
  });
});

describe("EventMapper tur sonu dürtmesi", () => {
  it("willRetry ile biten agent_end diziyi kapatmaz, ardından gelen agent_start yeni run açmaz", () => {
    const m = new EventMapper("s1");
    const start = m.map({ type: "agent_start" } as AgentSessionEvent);
    expect(start.map((e) => e.type)).toEqual(["run_start", "status"]);
    const retry = m.map({ type: "agent_end", messages: [], willRetry: true } as AgentSessionEvent);
    expect(retry).toEqual([]);
    // Dizi açık kaldığı için yeni run açılmaz; yalnızca durum "working"e ayarlanır.
    const resumed = m.map({ type: "agent_start" } as AgentSessionEvent);
    expect(resumed).toEqual([expect.objectContaining({ type: "status", status: "working" })]);
    const end = m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(end.map((e) => e.type)).toEqual(["run_end", "status"]);
  });

  it("yeniden deneme sonrası gelen agent_start yeni run açmaz ama durumu çalışıyor yapar", () => {
    const m = new EventMapper("s1");
    m.map({ type: "agent_start" } as AgentSessionEvent);
    // Geçici hatada Pi yeniden denemeye geçer: durum "bekliyor"a düşer.
    const retrying = m.map({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "429 rate limit",
    } as AgentSessionEvent);
    expect(retrying.map((e) => e.type)).toEqual(["status", "retry"]);
    // Deneme başarılı, tur kaldığı yerden sürer: yeni run yok, durum "working"e döner.
    const resumed = m.map({ type: "agent_start" } as AgentSessionEvent);
    expect(resumed).toEqual([expect.objectContaining({ type: "status", status: "working" })]);
    const end = m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(end.map((e) => e.type)).toEqual(["run_end", "status"]);
  });

  it("kuyrukta devam mesajı varken agent_end diziyi kapatmaz, sürdürmenin bitişi kapatır", () => {
    let queued = true;
    const m = new EventMapper("s1", "tr", () => queued);
    const start = m.map({ type: "agent_start" } as AgentSessionEvent);
    expect(start.map((e) => e.type)).toEqual(["run_start", "status"]);
    // Dürtme kuyruğa girmiş: tur sürüyor, dizi açık kalır (durum "working" kalır).
    expect(
      m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent),
    ).toEqual([]);
    // Sürdürme turu dizinin içinde akar; yeni run_start açılmaz, durum "working"de kalır.
    expect(m.map({ type: "agent_start" } as AgentSessionEvent)).toEqual([
      expect.objectContaining({ type: "status", status: "working" }),
    ]);
    queued = false;
    const end = m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(end.map((e) => e.type)).toEqual(["run_end", "status"]);
  });

  it("kuyruk düşse de agent_settled açık kalan diziyi kapatır", () => {
    const m = new EventMapper("s1", "tr", () => true);
    m.map({ type: "agent_start" } as AgentSessionEvent);
    expect(
      m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent),
    ).toEqual([]);
    const settled = m.map({ type: "agent_settled" } as AgentSessionEvent);
    expect(settled.map((e) => e.type)).toEqual(["run_end", "status"]);
    // Dizi bir kez kapanır; oturum sonu ikinci kapanış yaymaz.
    expect(m.map({ type: "agent_settled" } as AgentSessionEvent)).toEqual([]);
  });

  it("tur normal bitince agent_settled yinelenen kapanış yaymaz", () => {
    const m = new EventMapper("s1");
    m.map({ type: "agent_start" } as AgentSessionEvent);
    const end = m.map({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
    expect(end.map((e) => e.type)).toEqual(["run_end", "status"]);
    expect(m.map({ type: "agent_settled" } as AgentSessionEvent)).toEqual([]);
  });
});

describe("changedFilesOf", () => {
  it("details.changedFiles içindeki geçerli öğeleri döndürür, bozukları atlar", () => {
    const result = {
      details: {
        changedFiles: [
          { path: "/p/a.ts", kind: "edit" },
          { path: "/p/b.ts", kind: "rename" },
          { path: 3, kind: "edit" },
          null,
          { path: "/p/c.ts", kind: "create" },
        ],
      },
    };
    expect(changedFilesOf(result)).toEqual([
      { path: "/p/a.ts", kind: "edit" },
      { path: "/p/c.ts", kind: "create" },
    ]);
    expect(changedFilesOf({ details: { changedFiles: [] } })).toBeUndefined();
    expect(changedFilesOf({ details: {} })).toBeUndefined();
    expect(changedFilesOf(undefined)).toBeUndefined();
  });
});

describe("araç kartı çıktısı", () => {
  it("güvenilmez veri zarfı kartta açılır, içerik kalır", () => {
    const result = {
      content: [
        { type: "text", text: wrapUntrusted("Gmail/search", "Konu: fatura", "tr", "service") },
      ],
    };
    expect(outputOfResult(result)).toBe("Konu: fatura");
  });
});
