import type { ScheduledTask } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { nextRun, Scheduler } from "./scheduler";

const task = (
  schedule: ScheduledTask["schedule"],
  extra: Partial<ScheduledTask> = {},
): ScheduledTask => ({
  id: "t",
  title: "t",
  prompt: "p",
  projectId: null,
  schedule,
  paused: false,
  model: null,
  permission: "full",
  allowWeb: false,
  lastRunAt: null,
  lastResult: null,
  lastSessionId: null,
  nextRunAt: null,
  ...extra,
});

describe("nextRun", () => {
  // 2026-09-05 Cumartesi 10:00 yerel
  const from = new Date(2026, 8, 5, 10, 0, 0).getTime();
  const runAt = (t: ScheduledTask) => new Date(nextRun(t, from) ?? 0);

  it("günlük: saat geçtiyse yarın", () => {
    const n = runAt(task({ kind: "daily", time: "09:00" }));
    expect(n.getDate()).toBe(6);
    expect(n.getHours()).toBe(9);
  });
  it("günlük: saat gelmediyse bugün", () => {
    const n = runAt(task({ kind: "daily", time: "18:30" }));
    expect(n.getDate()).toBe(5);
    expect(n.getMinutes()).toBe(30);
  });
  it("hafta içi: cumartesiden pazartesiye atlar", () => {
    const n = runAt(task({ kind: "weekdays", time: "08:00" }));
    expect(n.getDay()).toBe(1);
  });
  it("haftalık ve aylık", () => {
    expect(runAt(task({ kind: "weekly", time: "09:00", weekday: 3 })).getDay()).toBe(3);
    const m = runAt(task({ kind: "monthly", time: "09:00", monthDay: 1 }));
    expect(m.getDate()).toBe(1);
    expect(m.getMonth()).toBe(9);
  });
  it("yalnız elle: plan yok", () => {
    expect(nextRun(task({ kind: "manual", time: "" }), from)).toBeNull();
  });
  it("aralık", () => {
    expect(nextRun(task({ kind: "interval", intervalMin: 15, time: "" }), from)).toBe(
      from + 15 * 60_000,
    );
  });
});

describe("Scheduler.tick", () => {
  it("vadesi gelen ve duraklatılmamış görevleri çalıştırır, sonrakini planlar", async () => {
    const now = Date.now();
    let store: ScheduledTask[] = [
      task({ kind: "interval", intervalMin: 5, time: "" }, { id: "due", nextRunAt: now - 1 }),
      task(
        { kind: "interval", intervalMin: 5, time: "" },
        { id: "later", nextRunAt: now + 60_000 },
      ),
      task(
        { kind: "interval", intervalMin: 5, time: "" },
        { id: "paused", nextRunAt: now - 1, paused: true },
      ),
    ];
    const ran: string[] = [];
    const s = new Scheduler(
      () => store,
      (t) => {
        store = store.map((x) => (x.id === t.id ? t : x));
      },
      async (t) => {
        ran.push(t.id);
      },
    );
    await s.tick(now);
    expect(ran).toEqual(["due"]);
    // Plan koşu bitişinden hesaplanır: uzun koşular aralığı aşıp birbirini kovalamaz.
    const next = store.find((t) => t.id === "due")?.nextRunAt ?? 0;
    expect(next).toBeGreaterThanOrEqual(now + 5 * 60_000);
    expect(next).toBeLessThan(now + 5 * 60_000 + 5_000);
  });

  /**
   * Regresyon: plan koşudan önce yazıldığı için aralıktan uzun süren bir görev, sonraki tikte
   * vadesi gelmiş görünüp **ikinci kez** başlatılıyordu — aynı klasörde çakışan iki ajan turu.
   */
  it("koşusu süren görevi ikinci kez başlatmaz", async () => {
    const now = Date.now();
    let store: ScheduledTask[] = [
      task({ kind: "interval", intervalMin: 5, time: "" }, { id: "uzun", nextRunAt: now - 1 }),
    ];
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    const s = new Scheduler(
      () => store,
      (t) => {
        store = store.map((x) => (x.id === t.id ? t : x));
      },
      async (t) => {
        started.push(t.id);
        await gate;
      },
    );
    const first = s.tick(now);
    // İlk koşu sürerken vadesi gelmiş ikinci bir tik: aynı görev yeniden başlamamalı.
    await s.tick(now + 10 * 60_000);
    expect(started).toEqual(["uzun"]);
    const finishedBefore = Date.now();
    release();
    await first;
    // Plan koşunun **bitişinden** hesaplandı, başlangıcından değil: aralıktan uzun koşu
    // kendini hemen tekrarlamaz.
    const after = store.find((t) => t.id === "uzun")?.nextRunAt ?? 0;
    expect(after).toBeGreaterThanOrEqual(finishedBefore + 5 * 60_000);
    await s.tick(after - 1);
    expect(started).toEqual(["uzun"]);
  });

  it("planı olmayan görev atlanmaz: ilk turda planlanır, vadesi gelince çalışır", async () => {
    const now = Date.now();
    let store: ScheduledTask[] = [task({ kind: "interval", intervalMin: 5, time: "" })];
    const ran: string[] = [];
    const s = new Scheduler(
      () => store,
      (t) => {
        store = store.map((x) => (x.id === t.id ? t : x));
      },
      async (t) => {
        ran.push(t.id);
      },
    );
    await s.tick(now);
    expect(ran).toEqual([]);
    expect(store[0]?.nextRunAt).toBe(now + 5 * 60_000);
    await s.tick(now + 5 * 60_000);
    expect(ran).toEqual(["t"]);
  });

  /**
   * Regresyon: tik listeyi başta bir kez okuyordu. A uzun sürerken ikinci tik B'yi koşturup
   * bitiriyor, ilk tik A'dan dönünce B'nin bayat `nextRunAt`'ini görüp B'yi ikinci kez başlatıyordu.
   */
  it("uzun görev sürerken başka tikte koşan görevi ilk tik yeniden başlatmaz", async () => {
    const now = Date.now();
    const every5 = { kind: "interval", intervalMin: 5, time: "" } as const;
    let store: ScheduledTask[] = [
      task(every5, { id: "A", nextRunAt: now - 1 }),
      task(every5, { id: "B", nextRunAt: now - 1 }),
    ];
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    const s = new Scheduler(
      () => store,
      (t) => {
        store = store.map((x) => (x.id === t.id ? t : x));
      },
      async (t) => {
        started.push(t.id);
        if (t.id === "A") await gate;
      },
    );
    const first = s.tick(now);
    // A sürerken bir dakika sonraki tik: A atlanır, B koşup biter ve yeni planını yazar.
    await s.tick(now + 60_000);
    expect(started).toEqual(["A", "B"]);
    release();
    await first;
    // İlk tik A'dan döndüğünde B'nin güncel planını görür; B ikinci kez başlamaz.
    expect(started).toEqual(["A", "B"]);
  });

  it("koşu sürerken silinen, duraklatılan ya da düzenlenen görevi bayat kayıtla geri yazmaz", async () => {
    const now = Date.now();
    const every5 = { kind: "interval", intervalMin: 5, time: "" } as const;
    let store: ScheduledTask[] = [
      task(every5, { id: "A", nextRunAt: now - 1 }),
      task(every5, { id: "silinen", nextRunAt: now - 1 }),
      task(every5, { id: "duraklatilan", nextRunAt: now - 1 }),
    ];
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    const s = new Scheduler(
      () => store,
      (t) => {
        // `AppStores.saveTask` gibi: kayıt yoksa eklenir (silinen görev geri gelebilir).
        store = [...store.filter((x) => x.id !== t.id), t];
      },
      async (t) => {
        started.push(t.id);
        if (t.id === "A") await gate;
      },
    );
    const first = s.tick(now);
    // A koşarken kullanıcı: A'yı yeniden adlandırır, bir görevi siler, birini duraklatır.
    store = store
      .filter((t) => t.id !== "silinen")
      .map((t) => (t.id === "A" ? { ...t, title: "yeni ad" } : t))
      .map((t) => (t.id === "duraklatilan" ? { ...t, paused: true } : t));
    release();
    await first;
    expect(started).toEqual(["A"]);
    expect(store.map((t) => t.id).sort()).toEqual(["A", "duraklatilan"]);
    expect(store.find((t) => t.id === "A")?.title).toBe("yeni ad");
    expect(store.find((t) => t.id === "duraklatilan")?.paused).toBe(true);
  });

  it("koşu sırasında silinen görevi bitişte geri eklemez", async () => {
    const now = Date.now();
    let store: ScheduledTask[] = [
      task({ kind: "interval", intervalMin: 5, time: "" }, { id: "A", nextRunAt: now - 1 }),
    ];
    const s = new Scheduler(
      () => store,
      (t) => {
        store = [...store.filter((x) => x.id !== t.id), t];
      },
      async () => {
        store = [];
        throw new Error("düştü");
      },
    );
    await s.tick(now);
    expect(store).toEqual([]);
  });

  it("yalnız elle görev zamanlayıcıda hiç planlanmaz ve çalışmaz", async () => {
    let store: ScheduledTask[] = [task({ kind: "manual", time: "" })];
    const saves: ScheduledTask[] = [];
    const ran: string[] = [];
    const s = new Scheduler(
      () => store,
      (t) => {
        saves.push(t);
        store = store.map((x) => (x.id === t.id ? t : x));
      },
      async (t) => {
        ran.push(t.id);
      },
    );
    s.start();
    s.stop();
    await s.tick(Date.now() + 3_600_000);
    expect(saves).toEqual([]);
    expect(ran).toEqual([]);
  });
});
