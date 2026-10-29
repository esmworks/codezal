import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BackgroundRunner } from "./background.js";
import { type BashBridge, bashTool } from "./bash-tool.js";

type Params = { command: string; timeout?: number };

/** Sarmalayıcıyı gerçek süreçlerle dener: köprü gerçek `BackgroundRunner`'a bağlanır. */
function harness(
  options: {
    thresholdMs?: number;
    unattended?: boolean;
    ignoreStop?: boolean;
    abortSettleMs?: number;
  } = {},
) {
  const runner = new BackgroundRunner({ onExit: () => {} });
  const detached: string[] = [];
  const bridge: BashBridge = {
    unattended: () => options.unattended ?? false,
    start: (command, opts) =>
      runner.start("s1", opts.cwd, command, {
        backgrounded: false,
        ...(opts.env ? { env: opts.env } : {}),
        onData: opts.onData,
      }),
    detach: (id) => {
      const task = runner.markBackgrounded(id);
      if (task) detached.push(task.id);
      return task;
    },
    timeout: (id) => {
      runner.timeout(id);
    },
    stop: (id) => {
      // Kapanmayan süreci taklit eder (kesintisiz G/Ç'de takılı süreç gibi).
      if (!options.ignoreStop) runner.stop(id);
    },
    wait: (id) => runner.waitFor(id),
  };
  const tool = bashTool(process.cwd(), bridge, "tr", {
    thresholdMs: options.thresholdMs ?? 90_000,
    ...(options.abortSettleMs === undefined ? {} : { abortSettleMs: options.abortSettleMs }),
  });
  return { runner, detached, tool };
}

// Pi'nin bash aracı PI_* ortam değişkenleri için `ctx.sessionManager`e bakar; testte en küçük
// karşılığı verilir (gerçek oturumda Pi bunu sağlar).
const ctx = (cwd: string) =>
  ({
    cwd,
    sessionManager: { getSessionId: () => "t1", getSessionFile: () => undefined },
  }) as unknown as ExtensionContext;

const run = (
  tool: ReturnType<typeof harness>["tool"],
  params: Params,
  signal?: AbortSignal,
  cwd = process.cwd(),
) => tool.execute("t1", params, signal, undefined, ctx(cwd));

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

describe("bash sarmalayıcısı", () => {
  it("açıklaması eşiği ve arka plana almayı söyler", () => {
    const { tool } = harness({ thresholdMs: 60_000 });
    expect(tool.name).toBe("bash");
    expect(tool.description).toContain("60 saniyeyi aşan");
    expect(Object.keys(tool.parameters.properties)).toEqual(["command", "timeout"]);
  });

  it("kısa komut normal sonucu döner, arka plana alınmaz", async () => {
    const { runner, detached, tool } = harness({ thresholdMs: 30_000 });
    const out = textOf(await run(tool, { command: "echo pencerede" }));
    expect(out).toContain("pencerede");
    expect(detached).toHaveLength(0);
    // Ön planda biten komut arka plan işi sayılmaz: listede görünmez, dürtme doğmaz.
    expect(runner.listBackgrounded("s1")).toHaveLength(0);
  }, 30_000);

  it("sıfırdan farklı çıkış kodunu hata olarak bildirir", async () => {
    const { tool } = harness();
    await expect(run(tool, { command: "exit 3" })).rejects.toThrow(/code 3/);
  }, 30_000);

  it("eşiği aşan komutu arka plana alır ve modele bildirir", async () => {
    const { runner, detached, tool } = harness({ thresholdMs: 300 });
    const out = textOf(await run(tool, { command: "sleep 30" }));
    expect(detached).toHaveLength(1);
    // Model "bitince uyandırılacaksın" notunu ve görev kimliğini görür; yoklama yasaktır.
    expect(out).toContain(detached[0]);
    expect(out).toContain("arka plana alındı");
    expect(out).toContain("yoklama");
    const jobs = runner.listBackgrounded("s1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("running");
    runner.stopSession("s1");
  }, 30_000);

  it("doğrulama komutunu arka plana almaz", async () => {
    const { runner, detached, tool } = harness({ thresholdMs: 300 });
    // `npm test` geçen bir metin doğrulama sınıfına girer; komutun kendisi zararsızdır.
    const out = textOf(await run(tool, { command: 'echo "npm test"' }));
    expect(out).toContain("npm test");
    expect(detached).toHaveLength(0);
    expect(runner.list("s1")).toHaveLength(0);
  }, 30_000);

  it("gözetimsiz oturumda arka plana almaz", async () => {
    const { runner, detached, tool } = harness({ thresholdMs: 300, unattended: true });
    const out = textOf(await run(tool, { command: "echo gözetimsiz" }));
    expect(out).toContain("gözetimsiz");
    expect(detached).toHaveLength(0);
    expect(runner.list("s1")).toHaveLength(0);
  }, 30_000);

  it("tur kesilince süreç kapanır ve görev sessiz kalır", async () => {
    const { runner, tool } = harness({ thresholdMs: 30_000 });
    const controller = new AbortController();
    const pending = run(tool, { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/aborted/i);
    const task = runner.list("s1")[0];
    expect(task?.status).toBe("stopped");
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "SIGTERM'i yok sayan komutta Durdur turu makul sürede bitirir",
    async () => {
      const { runner, tool } = harness({ thresholdMs: 30_000 });
      const controller = new AbortController();
      const started = Date.now();
      const pending = run(tool, { command: 'trap "" TERM; sleep 30' }, controller.signal);
      setTimeout(() => controller.abort(), 300);
      await expect(pending).rejects.toThrow(/aborted/i);
      // SIGTERM yok sayılır; 3 sn sonra SIGKILL grubu kapatır.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(runner.list("s1")[0]?.status).toBe("stopped");
    },
    20_000,
  );

  it("kesmeden sonra kapanmayan süreç turu askıda bırakmaz", async () => {
    const { runner, tool } = harness({ thresholdMs: 30_000, ignoreStop: true, abortSettleMs: 200 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(tool, { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    try {
      await expect(pending).rejects.toThrow(/aborted/i);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const task of runner.list("s1")) runner.stop(task.id);
    }
  }, 20_000);

  it("süre sınırı ön planda komutu keser", async () => {
    const { detached, tool } = harness({ thresholdMs: 30_000 });
    await expect(run(tool, { command: "sleep 30", timeout: 0.4 })).rejects.toThrow(/timed out/);
    expect(detached).toHaveLength(0);
  }, 30_000);

  it("süre sınırı arka planda iş son teslimi olur", async () => {
    // Pencere (150 ms) ile son teslim (2 sn) arasında geniş boşluk: yüklü bir koşuda pencere
    // gecikse bile süre dolması önce davranıp arka plana almayı iptal etmesin.
    const { runner, detached, tool } = harness({ thresholdMs: 150 });
    const out = textOf(await run(tool, { command: "sleep 30", timeout: 2 }));
    expect(out).toContain("arka plana alındı");
    const finished = await runner.waitFor(detached[0] ?? "");
    // Kullanıcı durdurmadı: görev "exited" kapanır ve süresi dolduğu bildirilir.
    expect(finished?.status).toBe("exited");
    expect(finished?.timedOut).toBe(true);
  }, 30_000);

  it("geçersiz süre sınırını Pi ile aynı metinle reddeder", async () => {
    const { tool } = harness();
    await expect(run(tool, { command: "echo x", timeout: 0 })).rejects.toThrow(
      /Invalid timeout: must be a finite number of seconds/,
    );
  }, 30_000);
});
