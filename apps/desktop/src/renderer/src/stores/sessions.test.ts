import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(async (_channel: string, _payload?: unknown): Promise<unknown> => undefined),
  /** Renderer'a yayınlanan olaylar: gerçek akışta main her aboneye aynı olayı gönderir. */
  listeners: new Map<string, Array<(payload: never) => void>>(),
}));

// sessions store'u renderer ortamına bağlı yan mağazaları import ediyor; bu test yalnızca
// prompt yolunun hangi kanala gittiğini ölçtüğü için onlar sahtelenir.
vi.mock("../api", () => ({
  invoke,
  on: (channel: string, listener: (payload: never) => void) => {
    const list = listeners.get(channel) ?? [];
    list.push(listener);
    listeners.set(channel, list);
    return () =>
      listeners.set(
        channel,
        list.filter((l) => l !== listener),
      );
  },
}));
vi.mock("./app", () => ({
  useApp: { getState: () => ({ activeSessionId: null }), subscribe: () => () => {} },
}));
vi.mock("./models", () => ({
  useModels: {
    getState: () => ({ setPermission() {}, setModel() {}, setThinking() {} }),
  },
}));

import type { AgentEvent, SubagentRun, SubagentTrace, TranscriptItem } from "@codezal/contracts";
import { useAgents } from "./agents";
import { draftFor, useDrafts } from "./drafts";
import { emptyRuntime } from "./reduce";
import { useSessions } from "./sessions";

/** Yayını abonelere iletir (main'in `broadcast` karşılığı). */
function feed(event: AgentEvent): void {
  for (const listener of listeners.get("agent:event") ?? []) listener(event as never);
}

/** Ajan turu sürerkenki çalışma zamanı. */
function working() {
  const rt = emptyRuntime();
  rt.status = "working";
  return rt;
}

describe("sessions.prompt", () => {
  beforeEach(() => {
    invoke.mockClear();
    useSessions.setState({ list: [], runtime: {}, unread: {} });
  });

  it("ajan çalışırken metni yönlendirme (steer) olarak kuyruğa verir", async () => {
    useSessions.setState({ runtime: { s1: working() } });
    await useSessions.getState().prompt("s1", "şunu da ekle");
    expect(invoke).toHaveBeenCalledWith("sessions:steer", { id: "s1", text: "şunu da ekle" });
  });

  it("ajan boştayken yeni tur başlatır", async () => {
    useSessions.setState({ runtime: { s1: emptyRuntime() } });
    await useSessions.getState().prompt("s1", "merhaba");
    expect(invoke).toHaveBeenCalledWith("sessions:prompt", { id: "s1", text: "merhaba" });
  });

  it("görselli mesaj çalışırken de yönlendirme kanalına gider", async () => {
    useSessions.setState({ runtime: { s1: working() } });
    await useSessions
      .getState()
      .prompt("s1", "şuna bak", [{ mimeType: "image/png", data: "aGk=" }]);
    expect(invoke).toHaveBeenCalledWith("sessions:steer", {
      id: "s1",
      text: "şuna bak",
      images: [{ mimeType: "image/png", data: "aGk=" }],
    });
  });

  it("followUp çalışırken kuyruk kanalına gider, boştayken yeni tur açar", async () => {
    useSessions.setState({ runtime: { s1: working() } });
    await useSessions.getState().followUp("s1", "sonra şuna bak");
    expect(invoke).toHaveBeenCalledWith("sessions:followUp", {
      id: "s1",
      text: "sonra şuna bak",
    });
    invoke.mockClear();
    useSessions.setState({ runtime: { s1: emptyRuntime() } });
    await useSessions.getState().followUp("s1", "merhaba");
    expect(invoke).toHaveBeenCalledWith("sessions:prompt", { id: "s1", text: "merhaba" });
  });

  it("kuyruğu temizler", async () => {
    await useSessions.getState().clearQueue("s1");
    expect(invoke).toHaveBeenCalledWith("sessions:clearQueue", { id: "s1" });
  });

  it("gönderilen metin beklemeden transkripte düşer", async () => {
    useSessions.setState({ runtime: { s1: emptyRuntime() } });
    await useSessions.getState().prompt("s1", "merhaba");
    const rt = useSessions.getState().runtime.s1;
    expect(rt?.transcript[rt.transcript.length - 1]).toMatchObject({
      type: "user",
      text: "merhaba",
    });
  });
});

describe("sessions.respondQuestion", () => {
  beforeEach(() => {
    invoke.mockClear();
    useSessions.setState({ list: [], runtime: {}, unread: {} });
  });

  it("cevabı soru kanalına gönderir ve kartı kapatır", async () => {
    const rt = emptyRuntime();
    rt.question = {
      requestId: "q1",
      sessionId: "s1",
      questions: [{ question: "Hangisi?", multiple: false, custom: true }],
    };
    useSessions.setState({ runtime: { s1: rt } });
    await useSessions.getState().respondQuestion("s1", "q1", [["A"]]);
    expect(invoke).toHaveBeenCalledWith("questions:respond", {
      requestId: "q1",
      answers: [["A"]],
    });
    expect(useSessions.getState().runtime.s1?.question).toBeNull();
    expect(useSessions.getState().runtime.s1?.status).toBe("working");
  });
});

const EPOCH = "ep-test";

/** Canlı akış olayı; zarf alanlarını gerçek akışta `AgentEventBus` ekler. */
const delta = (seq: number, text: string): AgentEvent =>
  ({
    type: "text_delta",
    sessionId: "s1",
    at: 1000 + seq,
    messageId: "m1",
    delta: text,
    seq,
    epoch: EPOCH,
  }) as AgentEvent;

/** `sessions:open` yanıtı; testte yalnızca kullanılan alanlar doldurulur. */
function snapshot(over: {
  lastSeq: number;
  runId?: string | null;
  buffered?: AgentEvent[];
  subagents?: SubagentRun[];
  subagentTraces?: SubagentTrace[];
}) {
  return {
    summary: {
      id: "s1",
      path: "/tmp/s1.jsonl",
      cwd: "/tmp",
      name: "s1",
      mode: "kodlama",
      createdAt: 1,
      modifiedAt: 1,
      messageCount: 0,
      pinned: false,
      archived: false,
      live: true,
      projectId: null,
      auditRunId: null,
      parentSessionId: null,
      sideOf: null,
    },
    transcript: [],
    permission: "ask",
    thinking: "low",
    backgrounds: [],
    lastSeq: over.lastSeq,
    epoch: EPOCH,
    runId: over.runId ?? null,
    buffered: over.buffered ?? [],
    ...(over.subagents ? { subagents: over.subagents } : {}),
    ...(over.subagentTraces ? { subagentTraces: over.subagentTraces } : {}),
  };
}

const openCalls = () => invoke.mock.calls.filter(([channel]) => channel === "sessions:open").length;

const textOf = (id: string) => {
  const item = useSessions.getState().runtime[id]?.transcript[0];
  return item?.type === "assistant" ? item.text : undefined;
};

/**
 * Snapshot ile canlı akışın uzlaştırılması. Bu yolun koptuğu durumda arayüz, model çalışırken
 * donuk kalıyor ve "uzun bekleyişten sonra bir anda çalışma" olarak görünüyordu: aynı olayın iki
 * kopyası sıra boşluğu sanılıp yeniden açma fırtınası doğuruyordu.
 */
describe("sessions.open uzlaştırma", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessions.setState({ list: [], runtime: {}, unread: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aynı olay tampondan ve canlı kuyruktan birlikte gelse yeniden açma tetiklemez", async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    invoke.mockImplementation(async (channel) => {
      if (channel !== "sessions:open") return undefined;
      return new Promise((resolve) => {
        resolveOpen = resolve;
      });
    });
    const opening = useSessions.getState().open("s1");
    // Açılış uçarken yayınlanan olay kuyruğa girer; aynı olay main tamponunda da durur.
    useSessions.getState().applyEvent(delta(11, "a"));
    resolveOpen?.(
      snapshot({ lastSeq: 10, runId: "r1", buffered: [delta(11, "a"), delta(12, "b")] }),
    );
    await opening;

    expect(openCalls()).toBe(1);
    expect(textOf("s1")).toBe("ab");
    // Sonraki olay sırayı sürdürür: kapanmış tur için yeniden açma istenmez.
    useSessions.getState().applyEvent(delta(13, "c"));
    expect(openCalls()).toBe(1);
    expect(textOf("s1")).toBe("abc");
  });

  it("açılışta biten alt ajan koşuları runtime'a, izleri Ajanlar deposuna gelir", async () => {
    useAgents.getState().reset();
    const run: SubagentRun = { id: "sub-1", label: "Yazıcı", kind: "agent", status: "done" };
    const item: TranscriptItem = {
      type: "tool",
      id: "w1",
      toolName: "write",
      kind: "create",
      status: "done",
      title: "Oluşturuldu",
      startedAt: 1,
    };
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open"
        ? snapshot({
            lastSeq: 0,
            subagents: [run],
            subagentTraces: [{ runId: "sub-1", items: [item] }],
          })
        : undefined,
    );
    await useSessions.getState().open("s1");
    expect(useSessions.getState().runtime.s1?.subagents).toEqual([run]);
    expect(useAgents.getState().trace["sub-1"]).toEqual({ sessionId: "s1", items: [item] });
  });

  it("uygulanmış sıra tekrar teslim edilirse yoksayılır, yeniden açılmaz", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 10, runId: "r1" }) : undefined,
    );
    await useSessions.getState().open("s1");
    useSessions.getState().applyEvent(delta(11, "a"));
    useSessions.getState().applyEvent(delta(11, "a"));

    expect(openCalls()).toBe(1);
    expect(textOf("s1")).toBe("a");
  });

  it("sıra atlanınca bir kez yeniden açar; art arda kopuklukta fırtına çıkmaz", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 10, runId: "r1" }) : undefined,
    );
    await useSessions.getState().open("s1");
    expect(openCalls()).toBe(1);

    useSessions.getState().applyEvent(delta(20, "x"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openCalls()).toBe(2);

    // Fren penceresindeki ikinci kopukluk yeni açma başlatmaz; artçı istek olarak bekler.
    useSessions.getState().applyEvent(delta(30, "y"));
    expect(openCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(openCalls()).toBe(3);
  });

  it("tur sürerken açılan oturumda akış olayları düşmez", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 5, runId: "r1" }) : undefined,
    );
    await useSessions.getState().open("s1");
    useSessions.getState().applyEvent(delta(6, "merhaba"));

    expect(useSessions.getState().runtime.s1?.activeRunId).toBe("r1");
    expect(textOf("s1")).toBe("merhaba");
  });

  // Sayfa yenilendikten sonra gelen geç olay yarım runtime kuruyordu; `open` onu "zaten açık"
  // sanıp snapshot'ı atlıyor, bekleyen izin kartı hiç görünmüyordu (e2e ajan akışı).
  it("açılmamış oturumun olayı runtime kurmaz; açılış bekleyen izni snapshot'tan getirir", async () => {
    useSessions.getState().applyEvent({
      type: "status",
      sessionId: "s1",
      at: 1003,
      status: "working",
      seq: 3,
      epoch: EPOCH,
    } as AgentEvent);
    expect(useSessions.getState().runtime.s1).toBeUndefined();

    const request = {
      requestId: "perm-1",
      sessionId: "s1",
      toolName: "write",
      kind: "create",
      dangerous: false,
      agent: "kare.js düzelt",
    };
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open"
        ? { ...snapshot({ lastSeq: 5, runId: "r1" }), permissions: [request] }
        : undefined,
    );
    await useSessions.getState().open("s1");
    const rt = useSessions.getState().runtime.s1;
    expect(rt?.permissions.map((p) => p.requestId)).toEqual(["perm-1"]);
    expect(rt?.status).toBe("waiting");
  });

  it("tur yokken gelen gecikmiş akış olayı yoksayılır", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 5 }) : undefined,
    );
    await useSessions.getState().open("s1");
    useSessions.getState().applyEvent(delta(6, "eski tur artığı"));

    expect(useSessions.getState().runtime.s1?.transcript).toEqual([]);
  });
});

/**
 * Delta yığınının sıra muhasebesi: parçalar kare başına birleştirilip tek olay olarak uygulanır.
 * Birleşik olay son sırayı taşıdığı için imleç denetimi aralığın tamamına bakmazsa her yığın
 * "sıra atlandı" sanılır; akış ekranda hiç görünmez ve içerik ancak tur bitince snapshot'tan
 * gelirdi ("bekliyor, sonra bir anda cevap veriyor").
 */
describe("delta yığını", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessions.setState({ list: [], runtime: {}, unread: {} });
    // Kare zamanlayıcısı yok sayılır: yığın, araya giren ilk delta-dışı olayla boşaltılır.
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  });

  const status = (seq: number): AgentEvent =>
    ({
      type: "status",
      sessionId: "s1",
      at: 1000 + seq,
      status: "working",
      seq,
      epoch: EPOCH,
    }) as AgentEvent;

  it("birleştirilen parçalar boşluk sayılmadan uygulanır", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 3, runId: "r1" }) : undefined,
    );
    await useSessions.getState().open("s1");
    feed(delta(4, "a"));
    feed(delta(5, "b"));
    feed(delta(6, "c"));
    feed(status(7));

    expect(openCalls()).toBe(1);
    expect(textOf("s1")).toBe("abc");
    // İmleç yığının sonuna taşınmış olmalı: sonraki olay boşluk sayılıp düşmez.
    feed(delta(8, "d"));
    feed(status(9));
    expect(openCalls()).toBe(1);
    expect(textOf("s1")).toBe("abcd");
  });
});

/**
 * Kalıcı silme ve bellek sınırı: arşivden kalıcı silinen oturumun transkripti ve okunmamış işareti
 * bellekte kalıyordu; açılıp bırakılan her sohbet de uygulama kapanana dek tutuluyordu.
 */
describe("oturum belleği", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessions.setState({ list: [], runtime: {}, unread: {} });
  });

  it("arşivden kalıcı silme runtime ve okunmamış kaydını da bırakır", async () => {
    const base = { ...snapshot({ lastSeq: 0 }).summary, mode: "kodlama" as const };
    useSessions.setState({
      list: [
        { ...base, id: "s1", archived: false },
        { ...base, id: "s2", archived: true },
      ],
      runtime: { s1: emptyRuntime(), s2: emptyRuntime() },
      unread: { s1: true, s2: true },
    });
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:purgeArchived" ? 1 : undefined,
    );
    await useSessions.getState().purgeArchived();
    const state = useSessions.getState();
    expect(state.list.map((x) => x.id)).toEqual(["s1"]);
    expect(Object.keys(state.runtime)).toEqual(["s1"]);
    expect(state.unread).toEqual({ s1: true });
  });

  it("son 20 açılanın dışındaki boştaki oturumlar düşer, yeniden açılınca snapshot'tan gelir", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 0 }) : undefined,
    );
    for (let i = 0; i < 22; i += 1) await useSessions.getState().open(`lru${i}`);
    const runtime = () => useSessions.getState().runtime;
    expect(runtime().lru0).toBeUndefined();
    expect(runtime().lru1).toBeUndefined();
    expect(runtime().lru2).toBeDefined();
    expect(runtime().lru21).toBeDefined();

    // Düşen oturum açılınca `sessions:open` yeniden çağrılır ve runtime kurulur.
    const before = openCalls();
    await useSessions.getState().open("lru0");
    expect(openCalls()).toBe(before + 1);
    expect(runtime().lru0).toBeDefined();
    // Yerine en eski kalan düşer.
    expect(runtime().lru2).toBeUndefined();
  });

  it("çalışan oturum sınırın dışında kalsa da düşmez", async () => {
    invoke.mockImplementation(async (channel) =>
      channel === "sessions:open" ? snapshot({ lastSeq: 0 }) : undefined,
    );
    useSessions.setState({ runtime: { busy: working() } });
    for (let i = 0; i < 21; i += 1) await useSessions.getState().open(`w${i}`);
    expect(useSessions.getState().runtime.busy).toBeDefined();
    expect(useSessions.getState().runtime.w0).toBeUndefined();
  });
});

describe("yan sohbet", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessions.setState({ list: [], runtime: {}, unread: {}, side: {} });
    useDrafts.setState({ drafts: {} });
  });

  const side = {
    ...snapshot({ lastSeq: 0 }),
    summary: { ...snapshot({ lastSeq: 0 }).summary, id: "side1", sideOf: "s1" },
    transcript: [{ type: "user", id: "u1", text: "ortak geçmiş", at: 1 }],
  };

  it("açılan yan sohbet listeye girmez, ortak geçmiş uzunluğu kaydedilir, alıntı taslağa yazılır", async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "sessions:side") return side.summary;
      if (channel === "sessions:open") return side;
      if (channel === "sessions:list") return [snapshot({ lastSeq: 0 }).summary, side.summary];
      return undefined;
    });
    const entry = await useSessions.getState().openSide("s1", "seçili metin");
    expect(entry).toEqual({ id: "side1", base: 1, open: true });
    expect(draftFor("side1")?.quotes).toEqual(["seçili metin"]);
    expect(useSessions.getState().list).toEqual([]);
    await useSessions.getState().loadList();
    expect(useSessions.getState().list.map((x) => x.id)).toEqual(["s1"]);
    // İkinci açış yeni dal kurmaz.
    await useSessions.getState().openSide("s1");
    expect(invoke.mock.calls.filter(([c]) => c === "sessions:side")).toHaveLength(1);
  });

  it("✕ yalnız paneli kapatır; yeniden açınca aynı yan sohbet döner, alıntı taslağa eklenir", async () => {
    useSessions.setState({
      side: { s1: { id: "side1", base: 1, open: true } },
      runtime: { s1: emptyRuntime(), side1: emptyRuntime() },
    });
    useSessions.getState().closeSide("s1");
    expect(useSessions.getState().side.s1).toEqual({ id: "side1", base: 1, open: false });
    expect(useSessions.getState().runtime.side1).toBeDefined();
    expect(invoke.mock.calls.filter(([c]) => c === "sessions:delete")).toHaveLength(0);
    const entry = await useSessions.getState().openSide("s1", "ikinci alıntı");
    expect(entry).toEqual({ id: "side1", base: 1, open: true });
    expect(draftFor("side1")?.quotes).toContain("ikinci alıntı");
    expect(invoke.mock.calls.filter(([c]) => c === "sessions:side")).toHaveLength(0);
  });

  it("ana oturum silinince yan sohbet kaydı ve runtime'ı da düşer", async () => {
    useSessions.setState({
      side: { s1: { id: "side1", base: 0, open: true } },
      runtime: { s1: emptyRuntime(), side1: emptyRuntime() },
    });
    await useSessions.getState().remove("s1");
    const state = useSessions.getState();
    expect(state.side).toEqual({});
    expect(Object.keys(state.runtime)).toEqual([]);
  });
});
