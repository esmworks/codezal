import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_TOOL,
  BackgroundRunner,
  type BackgroundTask,
  backgroundTool,
  describeTask,
  isVerificationCommand,
  MAX_FINISHED_TASKS,
  MAX_OUTPUT_CHARS,
  toBackgroundJob,
  truncationNote,
} from "./background.js";

/** Test görevi: alanlar tek yerde dursun (yeni alan eklenince bütün testler güncellenmesin). */
function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "bg-1",
    sessionId: "s1",
    command: "pnpm test",
    cwd: "/tmp",
    startedAt: 0,
    status: "running",
    output: "",
    outputChars: 0,
    backgrounded: true,
    ...over,
  };
}

/** Görev bitene kadar bekler; `onExit` çağrısı testin senkron noktası. */
function runner(): { runner: BackgroundRunner; done: Promise<BackgroundTask> } {
  let resolve: (t: BackgroundTask) => void = () => {};
  const done = new Promise<BackgroundTask>((r) => {
    resolve = r;
  });
  return { runner: new BackgroundRunner({ onExit: (t) => resolve(t) }), done };
}

function textOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

describe("BackgroundRunner", () => {
  it("komutu çalıştırır, çıktıyı toplar ve bitince haber verir", async () => {
    const { runner: r, done } = runner();
    const task = r.start("s1", process.cwd(), "echo merhaba");
    expect(task.status).toBe("running");
    expect(r.list("s1")).toHaveLength(1);
    const finished = await done;
    expect(finished.status).toBe("exited");
    expect(finished.code).toBe(0);
    expect(finished.output).toContain("merhaba");
    // Bitiş anı arayüzdeki süreyi yazar; başlangıçtan önce olamaz.
    expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt);
  }, 20_000);

  it("çıkış kodunu taşır", async () => {
    const { runner: r, done } = runner();
    r.start("s1", process.cwd(), "exit 3");
    expect((await done).code).toBe(3);
  }, 20_000);

  it("durdurulan görev stopped kalır", async () => {
    const { runner: r, done } = runner();
    const task = r.start("s1", process.cwd(), "sleep 30");
    expect(r.stop(task.id)).toBe(true);
    const finished = await done;
    expect(finished.status).toBe("stopped");
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "SIGTERM'i yok sayan görev SIGKILL'e yükseltilerek kapanır",
    async () => {
      const { runner: r, done } = runner();
      const task = r.start("s1", process.cwd(), 'trap "" TERM; sleep 30');
      // Kabuğun `trap`i kurması için kısa pay; aksi hâlde SIGTERM kabuğu hemen öldürür.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = Date.now();
      expect(r.stop(task.id)).toBe(true);
      const finished = await done;
      expect(finished.status).toBe("stopped");
      expect(Date.now() - started).toBeLessThan(8_000);
    },
    20_000,
  );

  it("oturum kapanınca o oturumun görevleri durur", async () => {
    const { runner: r, done } = runner();
    r.start("s1", process.cwd(), "sleep 30");
    r.stopSession("s1");
    expect((await done).status).toBe("stopped");
  }, 20_000);

  it("çıktı kuyruğu sınırlıdır", async () => {
    const { runner: r, done } = runner();
    r.start("s1", process.cwd(), `printf 'x%.0s' $(seq 1 ${MAX_OUTPUT_CHARS + 5000})`);
    const finished = await done;
    expect(finished.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    // Kırpma sessiz kalmaz: sayacı özgün uzunluğu taşır (bildirim dipnotu bundan yazılır).
    expect(finished.outputChars).toBeGreaterThan(MAX_OUTPUT_CHARS);
  }, 30_000);

  it("ön plan penceresindeki görev bitene kadar beklenir", async () => {
    const { runner: r } = runner();
    const t = r.start("s1", process.cwd(), "echo pencerede", { backgrounded: false });
    expect(t.backgrounded).toBe(false);
    const finished = await r.waitFor(t.id);
    expect(finished?.code).toBe(0);
    expect(finished?.output).toContain("pencere");
  }, 20_000);

  it("ön plan görevi arka plan listesinde görünmez", async () => {
    const { runner: r } = runner();
    const t = r.start("s1", process.cwd(), "echo kısa", { backgrounded: false });
    expect(r.listBackgrounded("s1")).toHaveLength(0);
    await r.waitFor(t.id);
    expect(r.list("s1")).toHaveLength(1);
  }, 20_000);

  it("bitmiş görev sonradan arka plana alınmaz", async () => {
    const { runner: r, done } = runner();
    const t = r.start("s1", process.cwd(), "echo bitti", { backgrounded: false });
    await done;
    expect(r.markBackgrounded(t.id)).toBeUndefined();
  }, 20_000);

  it("pencerede süren görev arka plana alınır", async () => {
    const { runner: r, done } = runner();
    const t = r.start("s1", process.cwd(), "sleep 30", { backgrounded: false });
    expect(r.listBackgrounded("s1")).toHaveLength(0);
    expect(r.markBackgrounded(t.id)?.id).toBe(t.id);
    expect(r.listBackgrounded("s1")).toHaveLength(1);
    r.stop(t.id);
    await done;
  }, 20_000);

  it("süresi dolan görev durdurulmuş sayılmaz", async () => {
    const { runner: r, done } = runner();
    const t = r.start("s1", process.cwd(), "sleep 30");
    expect(r.timeout(t.id)).toBe(true);
    const finished = await done;
    // "stopped" kullanıcı kararıdır ve sessiz kalır; süresi dolan görevi model öğrenmeli.
    expect(finished.status).toBe("exited");
    expect(finished.timedOut).toBe(true);
  }, 20_000);

  it("girdi okumayan komutta stdin kapalıdır", async () => {
    // Açık kalan stdin boru yüzünden `cat` girdi bekleyip asılı kalıyordu: `bash` üzerinden
    // gelen her komut bu yoldan geçtiği için takılan komut pencereyi aşıp arka plana düşerdi.
    const { runner: r, done } = runner();
    r.start("s1", process.cwd(), "cat");
    const finished = await done;
    expect(finished.code).toBe(0);
  }, 20_000);

  it("boruyu tutan torun süreç görevi asılı bırakmaz", async () => {
    // `close` beklenirse kabuk çıksa da arka plandaki `sleep` stdout'u tuttuğu için görev
    // "çalışıyor" kalırdı; dinginlik penceresi görevi kapatır, görevin kuyruğu korunur.
    const { runner: r } = runner();
    const t = r.start("s1", process.cwd(), "sleep 20 & echo bitti");
    const started = Date.now();
    const finished = await r.waitFor(t.id);
    expect(finished?.code).toBe(0);
    expect(finished?.output).toContain("bitti");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("kırpma yeni biten görevin kaydını düşürmez", async () => {
    // Uzun süren görev **ilk** başlatılır ama son biter: eski kırpma ekleme sırasına göre
    // baştan düştüğü için sıra kendi kaydına geliyordu ve `wait` `undefined` dönüyordu —
    // başarılı komut modele `-1` çıkış koduyla giderdi.
    const dir = mkdtempSync(join(tmpdir(), "codezal-bg-"));
    const flag = join(dir, "bitti");
    const { runner: r } = runner();
    try {
      // Uzun görev bir bayrak dosyasını bekler: kırpma sınırı dolduktan **sonra** bitmesi
      // böylece garanti (yüklü makinede `sleep`e güvenilseydi test zamanlamaya bağlı kalırdı).
      const long = r.start("s1", dir, `until [ -f "${flag}" ]; do sleep 0.02; done; echo uzun`);
      for (let i = 0; i < MAX_FINISHED_TASKS + 1; i++)
        await r.waitFor(r.start("s1", dir, "true").id);
      writeFileSync(flag, "");
      const finished = await r.waitFor(long.id);
      expect(finished?.code).toBe(0);
      expect(finished?.output).toContain("uzun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("toBackgroundJob", () => {
  it("sözleşme karşılığını üretir", () => {
    const full = task({ command: "pnpm build" });
    expect(toBackgroundJob(full)).toEqual({
      id: full.id,
      command: "pnpm build",
      status: "running",
      startedAt: full.startedAt,
    });
  });

  it("açıklama varsa taşır, yoksa alan yazılmaz", () => {
    expect(toBackgroundJob(task({ description: "Depo özetini çıkar" })).description).toBe(
      "Depo özetini çıkar",
    );
    expect(toBackgroundJob(task())).not.toHaveProperty("description");
  });

  it("bitmiş görevde çıkış kodunu taşır", () => {
    expect(toBackgroundJob(task({ id: "bg-3", status: "exited", code: 1 })).code).toBe(1);
  });

  it("bitmiş görevde bitiş anını taşır", () => {
    expect(toBackgroundJob(task({ status: "exited", code: 0, endedAt: 42 })).endedAt).toBe(42);
    expect(toBackgroundJob(task())).not.toHaveProperty("endedAt");
  });

  it("kırpılmamış çıktıda dipnot yazılmaz", () => {
    expect(truncationNote(task({ outputChars: 100, output: "x".repeat(100) }), 100)).toBe("");
  });

  it("kırpılan çıktıda özgün uzunluğu ve gösterileni yazar", () => {
    const note = truncationNote(task({ outputChars: 50_000 }), 4_000);
    expect(note).toContain("50000");
    expect(note).toContain("4000");
  });
});

describe("isVerificationCommand", () => {
  it("paket yöneticisi ve doğrulama araçlarını yakalar", () => {
    for (const command of [
      "pnpm check && pnpm lint && pnpm test",
      "pnpm --filter @coilstudio/mobile-staff typecheck",
      "npx tsc --noEmit",
      "bun test",
      "cd apps/desktop && vitest run",
      "bunx vitest run",
      "biome check .",
      "go test ./...",
      "cargo clippy",
      "node --test",
      "deno test",
    ])
      expect(isVerificationCommand(command), command).toBe(true);
  });

  it("dosya okumayı ve bağımsız uzun işleri serbest bırakır", () => {
    for (const command of [
      "pnpm dev",
      "pnpm build",
      "pnpm --filter @codezal/desktop package:mac:unsigned",
      "expo export -p ios",
      "rm -rf node_modules && pnpm install",
      "sleep 45 && echo bitti",
      "cat jest.config.js",
      "ls vitest.config.ts",
      "grep -n eslint package.json",
      'git commit -m "go test düzeltmesi"',
    ])
      expect(isVerificationCommand(command), command).toBe(false);
  });
});

describe("bash_background aracı", () => {
  const bridge = (over: Record<string, unknown> = {}) => ({
    start: () => task(),
    get: () => task(),
    list: () => [task()],
    stop: () => true,
    ...over,
  });

  it("start komutu başlatır ve kimliği döner", async () => {
    let seen = "";
    const tool = backgroundTool(
      bridge({
        start: (c: string) => {
          seen = c;
          return task();
        },
      }),
    );
    expect(tool.name).toBe(BACKGROUND_TOOL);
    const r = await tool.execute(
      "1",
      { action: "start", command: " pnpm dev --host " },
      undefined,
      undefined,
      {} as never,
    );
    expect(seen).toBe("pnpm dev --host");
    expect(textOf(r)).toContain("bg-1");
  });

  it("start açıklamayı köprüye iletir; boş açıklama gönderilmez", async () => {
    const seen: Array<string | undefined> = [];
    const tool = backgroundTool(
      bridge({
        start: (_c: string, description?: string) => {
          seen.push(description);
          return task();
        },
      }),
    );
    const ctx = {} as never;
    await tool.execute(
      "1",
      { action: "start", command: "sleep 9", description: " Depo özetini çıkar " },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "2",
      { action: "start", command: "sleep 9", description: "  " },
      undefined,
      undefined,
      ctx,
    );
    expect(seen).toEqual(["Depo özetini çıkar", undefined]);
  });

  it("start komutsuz çağrılırsa uyarır", async () => {
    const tool = backgroundTool(bridge());
    const r = await tool.execute("1", { action: "start" }, undefined, undefined, {} as never);
    expect(textOf(r)).toBe("start için command alanı gerekli.");
  });

  it("doğrulama komutunu arka plana atmaz, ön planda bash ister", async () => {
    let called = false;
    const tool = backgroundTool(
      bridge({
        start: () => {
          called = true;
          return task();
        },
      }),
    );
    const r = await tool.execute(
      "1",
      { action: "start", command: "pnpm check && pnpm lint && pnpm test" },
      undefined,
      undefined,
      {} as never,
    );
    expect(called).toBe(false);
    expect(textOf(r)).toContain("ön planda");
    expect(textOf(r)).toContain("bash");
  });

  it("gözetimsiz oturumda başlatmayı reddeder", async () => {
    const tool = backgroundTool(bridge({ start: () => undefined }));
    const r = await tool.execute(
      "1",
      { action: "start", command: "pnpm dev" },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(r)).toContain("zamanlanmış görev");
  });

  it("output çalışan görevin çıktısını verir", async () => {
    const tool = backgroundTool(bridge({ get: () => task({ output: "derleniyor…" }) }));
    const r = await tool.execute(
      "1",
      { action: "output", id: "bg-1" },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(r)).toContain("derleniyor…");
    expect(textOf(r)).toContain("çalışıyor");
  });

  it("bilinmeyen kimlik hata metni döner", async () => {
    const tool = backgroundTool(bridge({ get: () => undefined }));
    const r = await tool.execute(
      "1",
      { action: "output", id: "bg-9" },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(r)).toBe("bg-9 diye bir arka plan görevi yok.");
  });

  it("list oturumun görevlerini sayar", async () => {
    const tool = backgroundTool(bridge());
    const r = await tool.execute("1", { action: "list" }, undefined, undefined, {} as never);
    expect(textOf(r)).toBe("bg-1 çalışıyor — pnpm test");
  });

  it("özet satırı bitmiş görevde çıkış kodunu gösterir", () => {
    expect(describeTask(task({ status: "exited", code: 1 }))).toBe(
      "bg-1 bitti (çıkış 1) — pnpm test",
    );
  });
});
