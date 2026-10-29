import type { CodezalEngine } from "@codezal/agent";
import type { ScheduledTask } from "@codezal/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AppStores } from "./stores.js";

// `assistant.ts` Electron'a yalnız bildirim ve yol için dokunur; burada saf yardımcı sınanır.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/codezal-test" },
  Notification: { isSupported: () => false },
}));
vi.mock("./ipc.js", () => ({ broadcast: vi.fn() }));

const { contextLine, runScheduled } = await import("./assistant.js");

const note = (source: string) => `kopya; kaynak: ${source}`;

describe("contextLine", () => {
  it("kopyası olmayan bağlamı kaynak yoluyla yazar", () => {
    expect(
      contextLine({ kind: "file", value: "/a/rapor.pdf", label: "rapor.pdf", copy: null }, note),
    ).toBe("- [file] rapor.pdf: /a/rapor.pdf");
  });

  it("kopyası olanda birincil yol kopyadır, kaynak parantezde kalır", () => {
    expect(
      contextLine(
        {
          kind: "folder",
          value: "/a/Projeler",
          label: "Projeler",
          copy: { path: "/p/Bağlam/Projeler", copiedAt: 1 },
        },
        note,
      ),
    ).toBe("- [folder] Projeler: /p/Bağlam/Projeler (kopya; kaynak: /a/Projeler)");
  });
});

describe("runScheduled", () => {
  const task: ScheduledTask = {
    id: "g",
    title: "Görev",
    prompt: "p",
    projectId: null,
    schedule: { kind: "manual", time: "" },
    paused: false,
    model: { provider: "m", id: "x" },
    permission: "plan",
    allowWeb: true,
    lastRunAt: null,
    lastResult: null,
    lastSessionId: null,
    nextRunAt: null,
  };

  /** Koşu sırasında `during` çalışır; sonuç yazımı depoya düşer. */
  function setup(during: (tasks: ScheduledTask[]) => ScheduledTask[]) {
    let tasks: ScheduledTask[] = [task];
    const web: boolean[] = [];
    const stores = {
      settings: { get: () => ({ defaultModel: null, notifications: false }) },
      projects: () => [],
      tasks: () => tasks,
      saveTask: (t: ScheduledTask) => {
        tasks = [...tasks.filter((x) => x.id !== t.id), t];
        return t;
      },
    } as unknown as AppStores;
    const engine = {
      createSession: async () => ({ id: "oturum" }),
      permissions: {
        setUnattended: () => undefined,
        setWebAllowed: (_id: string, on: boolean) => web.push(on),
      },
      promptAndWait: async () => {
        tasks = during(tasks);
      },
      lastAssistantText: () => "bitti",
    } as unknown as CodezalEngine;
    return { run: () => runScheduled(engine, stores, task), tasks: () => tasks, web };
  }

  it("koşu sürerken silinen görevi sonuç yazarken geri getirmez", async () => {
    const s = setup(() => []);
    await s.run();
    expect(s.tasks()).toEqual([]);
  });

  it("sonucu güncel kaydın üstüne yazar", async () => {
    const s = setup((tasks) => tasks.map((t) => ({ ...t, title: "yeni ad" })));
    await s.run();
    expect(s.tasks()[0]?.title).toBe("yeni ad");
    expect(s.tasks()[0]?.lastResult).toBe("bitti");
    expect(s.tasks()[0]?.lastSessionId).toBe("oturum");
  });

  it("görevin web iznini koşu boyunca açar, bitince geri alır", async () => {
    const s = setup((tasks) => tasks);
    await s.run();
    expect(s.web).toEqual([true, false]);
  });
});
