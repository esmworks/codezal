import type { AgentEvent } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { emptyRuntime, reduceEvent } from "./reduce";

/** Test olaylarının ortak gövdesi: zarf alanları bus'ta eklenir, test bunu doğrudan taşır. */
const base = { sessionId: "s1", at: 1000, seq: 1, epoch: "test" };
function run(events: AgentEvent[]) {
  return events.reduce((rt, ev) => reduceEvent(rt, ev), emptyRuntime());
}

describe("reduceEvent", () => {
  it("message_end bitiş nedenini transcript öğesine yazar", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "message_end", messageId: "m1", text: "yanıt", stopReason: "error" },
    ]);
    expect(rt.transcript[0]).toMatchObject({
      type: "assistant",
      id: "m1",
      text: "yanıt",
      stopReason: "error",
    });
  });

  it("boundary olayı çizilmeyen sınır öğesi ekler", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "message_end", messageId: "m1", text: "rapor" },
      { ...base, type: "boundary", kind: "background" },
    ]);
    expect(rt.transcript.map((i) => i.type)).toEqual(["assistant", "boundary"]);
    expect(rt.transcript[1]).toMatchObject({ type: "boundary", kind: "background", at: 1000 });
  });

  it("komut işareti olayı sohbete ayraç satırı ekler, aynı işaret iki kez düşmez", () => {
    const marker = {
      type: "marker" as const,
      id: "mk-1",
      kind: "model" as const,
      from: "acme/a",
      to: "acme/b",
      at: 1200,
    };
    const rt = run([{ ...base, type: "marker", marker }]);
    expect(rt.transcript).toEqual([marker]);
    // Yeniden yayın (ör. oturum tazelendikten sonra gecikmiş olay) satırı çiftlemez.
    const again = reduceEvent(rt, { ...base, type: "marker", marker });
    expect(again.transcript).toHaveLength(1);
  });

  it("plan onayı bekletir, mod olayı çipi günceller, tur sonu kartı siler", () => {
    const review = {
      requestId: "p1",
      sessionId: "s1",
      plan: "# Plan",
      path: "/plans/s1.md",
      returnTo: "auto-edit" as const,
    };
    const waiting = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "permission_mode", mode: "plan" },
      { ...base, type: "plan_review", review },
    ]);
    expect(waiting.permission).toBe("plan");
    expect(waiting.planReview).toEqual(review);
    expect(waiting.status).toBe("waiting");
    // Onay sonrası mod olayı gelir; kart tur sonunda düşer.
    const approved = reduceEvent(waiting, { ...base, type: "permission_mode", mode: "auto-edit" });
    expect(approved.permission).toBe("auto-edit");
    const ended = reduceEvent(approved, { ...base, type: "run_end", runId: "r1", aborted: false });
    expect(ended.planReview).toBeNull();
  });

  it("soru kartı bekler, tur sonu temizler", () => {
    const request = {
      requestId: "q1",
      sessionId: "s1",
      questions: [
        {
          question: "Hangisi?",
          options: [{ label: "A" }, { label: "B" }],
          multiple: false,
          custom: true,
        },
      ],
    };
    const waiting = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "question_request", request },
    ]);
    expect(waiting.question).toEqual(request);
    expect(waiting.status).toBe("waiting");
    const ended = reduceEvent(waiting, { ...base, type: "run_end", runId: "r1", aborted: false });
    expect(ended.question).toBeNull();
  });

  it("checks olayı son kontrol sonucunu tutar, yeni tur onu siler", () => {
    const failed = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "checks", ok: false, commands: ["pnpm lint"], failed: "pnpm lint" },
    ]);
    expect(failed.checks).toEqual({ ok: false, commands: ["pnpm lint"], failed: "pnpm lint" });
    const next = reduceEvent(failed, { ...base, type: "run_start", runId: "r2" });
    expect(next.checks).toBeNull();
  });

  it("review olayı koşu durumunu tutar, yeni tur siler", () => {
    const finding = {
      id: "f1",
      at: 1000,
      class: "bug" as const,
      title: "t",
      description: "d",
      file: "src/a.ts",
      verdict: "confirmed" as const,
      verdictReason: "r",
      evidence: "e",
      outcome: "pending" as const,
    };
    const started = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "review", phase: "started", turn: 1, files: ["src/a.ts"] },
    ]);
    expect(started.review).toEqual({ phase: "started", turn: 1, files: ["src/a.ts"] });
    const done = reduceEvent(started, {
      ...base,
      type: "review",
      phase: "done",
      turn: 1,
      files: ["src/a.ts"],
      counts: { confirmed: 1, rejected: 0, inconclusive: 0 },
      findings: [finding],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    expect(done.review?.findings).toHaveLength(1);
    expect(done.review?.counts?.confirmed).toBe(1);
    expect(done.review?.turn).toBe(1);
    // Hata notu "bulgu yok"tan ayrı taşınır.
    const failed = reduceEvent(done, {
      ...base,
      type: "review",
      phase: "done",
      turn: 1,
      files: ["src/a.ts"],
      error: "İnceleme tamamlanamadı",
    });
    expect(failed.review?.error).toBe("İnceleme tamamlanamadı");
    const next = reduceEvent(done, { ...base, type: "run_start", runId: "r2" });
    expect(next.review).toBeNull();
  });

  it("message_end yanıtı üreten modeli oturum modeli yapar", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "text_delta", messageId: "m1", delta: "Merhaba" },
      {
        ...base,
        type: "message_end",
        messageId: "m1",
        text: "Merhaba",
        model: "deepseek-chat",
        provider: "deepseek",
      },
    ]);
    expect(rt.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
    // Model bilgisi gelmeyen yanıt bilineni silmez.
    const next = reduceEvent(rt, { ...base, type: "message_end", messageId: "m2", text: "x" });
    expect(next.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
  });

  it("queue olayı bekleyenleri tutar, tur bitince boşalır", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "queue", steering: ["şunu da ekle"], followUp: ["sonra şuna bak"] },
    ]);
    expect(rt.queue).toEqual({ steering: ["şunu da ekle"], followUp: ["sonra şuna bak"] });
    const ended = reduceEvent(rt, { ...base, type: "run_end", runId: "r1", aborted: false });
    expect(ended.queue).toEqual({ steering: [], followUp: [] });
  });

  it("retry hata bandını kaldırır ve durumu bekliyor yapar", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "error", message: "429 rate limit" },
      { ...base, type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1000, message: "429" },
    ]);
    expect(rt.lastError).toBeNull();
    expect(rt.status).toBe("waiting");
  });

  it("akan metni tek asistan öğesinde biriktirir ve message_end ile kapatır", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "text_delta", messageId: "m1", delta: "Merha" },
      { ...base, type: "text_delta", messageId: "m1", delta: "ba" },
      { ...base, type: "thinking_delta", messageId: "m1", delta: "düşünüyorum" },
      {
        ...base,
        at: 4500,
        type: "message_end",
        messageId: "m1",
        text: "Merhaba",
        model: "kimi-k3",
        provider: "x",
      },
    ]);
    expect(rt.status).toBe("working");
    expect(rt.transcript).toHaveLength(1);
    const a = rt.transcript[0];
    expect(a?.type === "assistant" && a.text).toBe("Merhaba");
    expect(a?.type === "assistant" && a.streaming).toBe(false);
    expect(a?.type === "assistant" && a.durationMs).toBe(3500);
    expect(a?.type === "assistant" && a.thinking).toBe("düşünüyorum");
  });

  it("ikinci düşünme parçası düşünme metnine eklenir", () => {
    // Gemini ve Anthropic bir mesaj içinde düşünme → metin → düşünme sırası üretebiliyor.
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "thinking_delta", messageId: "m1", delta: "ilk" },
      { ...base, type: "thinking_end", messageId: "m1" },
      { ...base, type: "text_delta", messageId: "m1", delta: "ara metin" },
      { ...base, type: "thinking_delta", messageId: "m1", delta: "ikinci" },
    ]);
    const a = rt.transcript[0];
    expect(a?.type === "assistant" && a.thinking).toBe("ilkikinci");
  });

  it("araç kartını başlatır, günceller ve bitirir", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "t1",
        toolName: "edit",
        kind: "edit",
        title: "Düzenlendi",
        target: "a.ts",
      },
      { ...base, type: "tool_update", toolCallId: "t1", output: "+1\n" },
      { ...base, type: "tool_end", toolCallId: "t1", isError: false, output: "+1\n-2\n" },
    ]);
    const t = rt.transcript[0];
    expect(t?.type).toBe("tool");
    if (t?.type === "tool") {
      expect(t.status).toBe("done");
      expect(t.output).toBe("+1\n-2\n");
      expect(t.target).toBe("a.ts");
    }
  });

  it("arama kartına hangi yolla arandığını yazar", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "s1",
        toolName: "web_search",
        kind: "search",
        title: "Web'de arandı",
        target: "ZCode",
      },
      {
        ...base,
        type: "tool_end",
        toolCallId: "s1",
        isError: false,
        output: "1. sonuç",
        searchBackend: "native",
      },
    ]);
    const t = rt.transcript[0];
    expect(t?.type === "tool" && t.searchBackend).toBe("native");
  });

  it("araç yolu kendisi çözdüyse kart hedefi tool_end'deki yola döner", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "p1",
        toolName: "pdf_create",
        kind: "create",
        title: "PDF oluşturuldu",
        target: "rapor.pdf",
      },
      {
        ...base,
        type: "tool_end",
        toolCallId: "p1",
        isError: false,
        target: "/belgeler/Çıktılar/rapor.pdf",
      },
    ]);
    const t = rt.transcript[0];
    expect(t?.type === "tool" && t.target).toBe("/belgeler/Çıktılar/rapor.pdf");
  });

  it("plan modunda engellenen çağrıyı hata değil engellendi olarak işaretler", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "t1",
        toolName: "bash",
        kind: "terminal",
        title: "Çalıştırıldı",
        command: "pnpm test",
      },
      {
        ...base,
        type: "tool_end",
        toolCallId: "t1",
        isError: true,
        blocked: true,
        output: "Plan modunda dosya değişikliği ve komut çalıştırma kapalı.\n",
      },
    ]);
    const t = rt.transcript[0];
    expect(t?.type === "tool" && t.status).toBe("blocked");
  });

  it("Durdur'un kestiği çağrıyı hata değil durduruldu olarak işaretler", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "t1",
        toolName: "bash",
        kind: "terminal",
        title: "Çalıştırıldı",
        command: "sleep 30",
      },
      { ...base, type: "tool_end", toolCallId: "t1", isError: true, stopped: true },
    ]);
    const t = rt.transcript[0];
    expect(t?.type === "tool" && t.status).toBe("stopped");
  });

  it("izin isteğini bekleyen olarak tutar, run_end temizler", () => {
    const req = {
      requestId: "p1",
      sessionId: "s1",
      toolName: "bash",
      kind: "terminal" as const,
      command: "rm -rf x",
      dangerous: true,
    };
    let rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "permission_request", request: req },
    ]);
    expect(rt.status).toBe("waiting");
    expect(rt.permissions.map((r) => r.requestId)).toEqual(["p1"]);
    rt = reduceEvent(rt, { ...base, at: 9000, type: "run_end", runId: "r1", aborted: false });
    expect(rt.status).toBe("idle");
    expect(rt.permissions).toEqual([]);
    expect(rt.lastDurationMs).toBe(8000);
  });

  it("paralel izin kartları birbirini ezmez, yalnız sonuçlanınca kalkar", () => {
    const req = (requestId: string, runId?: string) => ({
      requestId,
      sessionId: "s1",
      toolName: "bash",
      kind: "terminal" as const,
      command: "pnpm test",
      dangerous: false,
      ...(runId ? { run: { id: runId, title: `iş ${runId}` } } : {}),
    });
    let rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "permission_request", request: req("own-a") },
      { ...base, type: "permission_request", request: req("own-b") },
      { ...base, type: "permission_request", request: req("a1", "run-a") },
      { ...base, type: "permission_request", request: req("b1", "run-b") },
    ]);
    const ids = () => rt.permissions.map((r) => r.requestId);
    expect(ids()).toEqual(["own-a", "own-b", "a1", "b1"]);
    // Başka bir aracın "working" durumu bekleyen kartları silmez.
    rt = reduceEvent(rt, { ...base, type: "status", status: "working" });
    expect(ids()).toEqual(["own-a", "own-b", "a1", "b1"]);
    rt = reduceEvent(rt, { ...base, type: "permission_resolved", requestId: "own-a" });
    expect(ids()).toEqual(["own-b", "a1", "b1"]);
    // Tur biter: kendi istekleri kalkar, ayrık koşularınki sürer.
    rt = reduceEvent(rt, { ...base, type: "run_end", runId: "r1", aborted: false });
    expect(ids()).toEqual(["a1", "b1"]);
    rt = reduceEvent(rt, {
      ...base,
      type: "worker_ended",
      workerId: "run-b",
      title: "iş run-b",
      info: { status: "cancelled", result: "", files: [], durationMs: 1 },
    });
    expect(ids()).toEqual(["a1"]);
  });

  it("arka plan görevini ekler, bitirir ve yeni turda temizler", () => {
    let rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "background_start", jobId: "bg-1", command: "pnpm test" },
    ]);
    expect(rt.backgrounds).toEqual([
      { id: "bg-1", command: "pnpm test", status: "running", startedAt: 1000 },
    ]);
    rt = reduceEvent(rt, {
      ...base,
      at: 5000,
      type: "background_end",
      jobId: "bg-1",
      status: "exited",
      code: 0,
    });
    expect(rt.backgrounds).toEqual([
      {
        id: "bg-1",
        command: "pnpm test",
        status: "exited",
        startedAt: 1000,
        endedAt: 5000,
        code: 0,
      },
    ]);
    // Yeni tur temiz sayfa açar: bitmişler düşer, sürenler kalır.
    const next = reduceEvent(rt, { ...base, at: 6000, type: "run_start", runId: "r2" });
    expect(next.backgrounds).toEqual([]);
  });

  it("başlangıcını görmeden gelen arka plan bitişini yoksayar", () => {
    const rt = run([{ ...base, type: "background_end", jobId: "bg-9", status: "stopped" }]);
    expect(rt.backgrounds).toEqual([]);
  });

  it("alt ajan listesini yazar, boş liste temizler, yeni tur korur", () => {
    let rt = run([
      {
        ...base,
        type: "subagents",
        runs: [{ id: "j1", label: "kodu incele", kind: "review", status: "running" }],
      },
    ]);
    expect(rt.subagents).toEqual([
      { id: "j1", label: "kodu incele", kind: "review", status: "running" },
    ]);
    // Alt ajan koşuları turdan bağımsız sürer: yeni tur listeyi temizlemez.
    rt = reduceEvent(rt, { ...base, at: 6000, type: "run_start", runId: "r1" });
    expect(rt.subagents).toHaveLength(1);
    rt = reduceEvent(rt, { ...base, at: 7000, type: "subagents", runs: [] });
    expect(rt.subagents).toEqual([]);
  });

  it("alt ajan izi transcript'e girmez: yalnız koşu başlığı runtime'da tutulur", () => {
    const rt = run([
      {
        ...base,
        type: "subagents",
        runs: [
          {
            id: "sub-1",
            label: "izin kapısı",
            kind: "explore",
            status: "running",
            startedAt: 1000,
            parentToolCallId: "call-1",
          },
        ],
      },
      {
        ...base,
        type: "subagent_trace",
        runId: "sub-1",
        item: {
          type: "tool",
          id: "t1",
          toolName: "grep",
          kind: "search",
          status: "running",
          title: "Arandı",
          startedAt: 1000,
        },
      },
    ]);
    // İz ayrı depoda (`stores/agents.ts`) tutulur; transcript ve subagents'a sızmamalı.
    expect(rt.transcript).toEqual([]);
    expect(rt.subagents[0]?.parentToolCallId).toBe("call-1");
    expect(rt.subagents[0]?.kind).toBe("explore");
  });

  it("kullanımı toplar ve hatayı saklar", () => {
    const rt = run([
      {
        ...base,
        type: "usage",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
      {
        ...base,
        type: "usage",
        usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0, cost: 0.02 },
      },
      { ...base, type: "error", message: "boom" },
      { ...base, type: "context", tokens: 4000, contextWindow: 200_000, percent: 2 },
    ]);
    expect(rt.usage).toEqual({ input: 11, output: 6, cacheRead: 2, cacheWrite: 0, cost: 0.03 });
    expect(rt.lastError).toBe("boom");
    expect(rt.context).toEqual({ tokens: 4000, contextWindow: 200_000, percent: 2 });
  });

  it("tur kapandıktan sonra gelen gecikmiş akış olaylarını yoksayar (stale run)", () => {
    // Yeniden deneme artıkları: eski turun text_delta'sı run_end'den sonra ulaşırsa transcript
    // bozulmamalı; aksi hâlde yarım/yinelenen mesaj kartı görünür.
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "run_end", runId: "r1", aborted: true },
      { ...base, type: "text_delta", messageId: "m-ghost", delta: "eski tur" },
      { ...base, type: "message_end", messageId: "m-ghost", text: "eski tur yanıtı" },
      {
        ...base,
        type: "tool_start",
        toolCallId: "t-ghost",
        toolName: "bash",
        kind: "terminal",
        title: "ls",
      },
    ]);
    expect(rt.transcript).toEqual([]);
    expect(rt.activeRunId).toBeNull();
  });

  it("yeni tur açıldığında akış olayları yeniden uygulanır", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      { ...base, type: "run_end", runId: "r1", aborted: false },
      { ...base, type: "run_start", runId: "r2" },
      { ...base, type: "message_end", messageId: "m2", text: "yeni tur yanıtı" },
    ]);
    expect(rt.activeRunId).toBe("r2");
    expect(rt.transcript).toHaveLength(1);
    expect(rt.transcript[0]).toMatchObject({
      type: "assistant",
      id: "m2",
      text: "yeni tur yanıtı",
    });
  });
  /**
   * Canlı sayaç: yazma/düzenleme sürerken satır motordan gelen `tool_preview` ile erken doğar ve
   * sayaç akış boyunca tazelenir; çağrı başlayınca aynı satır devralınır, bittiğinde sayı diff'e döner.
   */
  it("tool_preview satırı açar ve sayacı yerinde tazeler", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_preview",
        toolCallId: "c1",
        toolName: "write",
        kind: "create",
        title: "Oluşturuluyor",
        target: "a.ts",
        added: 4,
        removed: 0,
      },
      {
        ...base,
        type: "tool_preview",
        toolCallId: "c1",
        toolName: "write",
        kind: "create",
        title: "Oluşturuluyor",
        target: "a.ts",
        added: 12,
        removed: 0,
      },
    ]);
    expect(rt.transcript).toHaveLength(1);
    expect(rt.transcript[0]).toMatchObject({
      type: "tool",
      id: "c1",
      status: "running",
      kind: "create",
      target: "a.ts",
      added: 12,
      removed: 0,
      preview: true,
    });
  });

  it("tool_start akıştan doğan satırı devralır, sayaç sıfırlanmaz", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_preview",
        toolCallId: "c1",
        toolName: "write",
        kind: "create",
        title: "Oluşturuluyor",
        target: "a.ts",
        added: 12,
        removed: 0,
      },
      {
        ...base,
        at: 1400,
        type: "tool_start",
        toolCallId: "c1",
        toolName: "write",
        kind: "create",
        title: "Oluşturuldu",
        target: "a.ts",
      },
    ]);
    expect(rt.transcript).toHaveLength(1);
    expect(rt.transcript[0]).toMatchObject({
      type: "tool",
      id: "c1",
      title: "Oluşturuldu",
      startedAt: 1000,
      added: 12,
      removed: 0,
    });
    expect(rt.transcript[0] && "preview" in rt.transcript[0]).toBe(false);
  });

  it("çağrı bitince canlı ölçü düşer, sayı diff çıktısından okunur", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_preview",
        toolCallId: "c1",
        toolName: "edit",
        kind: "edit",
        title: "Düzenleniyor",
        target: "a.ts",
        added: 9,
        removed: 3,
      },
      {
        ...base,
        type: "tool_start",
        toolCallId: "c1",
        toolName: "edit",
        kind: "edit",
        title: "Düzenlendi",
        target: "a.ts",
      },
      {
        ...base,
        type: "tool_end",
        toolCallId: "c1",
        isError: false,
        output: "+1 bir\n-2 iki\n+3 üç",
      },
    ]);
    expect(rt.transcript[0]).toMatchObject({ status: "done", output: "+1 bir\n-2 iki\n+3 üç" });
    expect(rt.transcript[0] && "added" in rt.transcript[0]).toBe(false);
    expect(rt.transcript[0] && "removed" in rt.transcript[0]).toBe(false);
  });

  it("üretim kesilirse çalışmamış önizleme satırı düşer", () => {
    const rt = run([
      { ...base, type: "run_start", runId: "r1" },
      {
        ...base,
        type: "tool_preview",
        toolCallId: "c1",
        toolName: "write",
        kind: "create",
        title: "Oluşturuluyor",
        target: "a.ts",
        added: 4,
        removed: 0,
      },
      { ...base, type: "run_end", runId: "r1", aborted: true },
    ]);
    expect(rt.transcript).toEqual([]);
  });
});
