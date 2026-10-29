import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantProject } from "@codezal/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { AppStores } from "../stores.js";

// Kanallar Electron'a bağlanmadan sınanır: `handle` yerine kayıtları toplayan bir casus,
// çöp kutusu ve bildirim için en az Electron yüzeyi.
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload: never) => unknown>(),
  trashItem: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/codezal-ipc-test" },
  Notification: { isSupported: () => false },
  shell: { trashItem: mocks.trashItem, openPath: vi.fn() },
}));

vi.mock("../ipc.js", () => ({
  handle: (channel: string, fn: (payload: never) => unknown) => {
    mocks.handlers.set(channel, fn);
  },
}));

const { registerAssistantIpc } = await import("./assistant.js");

function channel<Req, Res>(name: string): (payload: Req) => Promise<Res> {
  const fn = mocks.handlers.get(name);
  if (!fn) throw new Error(`kanal kaydı yok: ${name}`);
  return fn as (payload: Req) => Promise<Res>;
}

const project = (): AssistantProject => ({
  id: "p1",
  name: "Finans",
  description: "",
  instructions: "",
  memory: [],
  context: [],
  createdAt: 1,
});

let docs = "";
let userData = "";
beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "cz-docs-"));
  userData = mkdtempSync(join(tmpdir(), "cz-user-"));
  mocks.handlers.clear();
  mocks.trashItem.mockClear();
  registerAssistantIpc({
    paths: { documents: docs },
    stores: new AppStores(userData),
    engine: {},
  } as unknown as AppContext);
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

type CopyRes = { project: AssistantProject; bytes: number; needsConfirm: boolean };

describe("assistant:saveProject / copyContext / removeContext", () => {
  it("proje kaydedilince çıktı ve bağlam klasörleri hazır olur", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    await save(project());
    const root = join(docs, "Codezal Asistan", "Finans");
    expect(existsSync(join(root, "Çıktılar"))).toBe(true);
    expect(existsSync(join(root, "Bağlam"))).toBe(true);
  });

  it("kopyalar, yolunu projeye yazar ve diskte kalıcı olur", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    const src = join(docs, "kaynak.md");
    writeFileSync(src, "içerik");
    await save({
      ...project(),
      context: [{ kind: "file", value: src, label: "kaynak.md", copy: null }],
    });

    const copy = channel<{ projectId: string; value: string }, CopyRes>("assistant:copyContext");
    const res = await copy({ projectId: "p1", value: src });

    const target = join(docs, "Codezal Asistan", "Finans", "Bağlam", "kaynak.md");
    expect(res.needsConfirm).toBe(false);
    expect(res.project.context[0]?.copy?.path).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("içerik");
    const stored = JSON.parse(readFileSync(join(userData, "assistant.json"), "utf8")) as {
      projects: AssistantProject[];
    };
    expect(stored.projects[0]?.context[0]?.copy?.path).toBe(target);
  });

  it("bağlantı bağlamını kopyalamaz", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    await save({
      ...project(),
      context: [{ kind: "link", value: "https://x.test", label: "x.test", copy: null }],
    });
    const copy = channel<{ projectId: string; value: string }, CopyRes>("assistant:copyContext");
    await expect(copy({ projectId: "p1", value: "https://x.test" })).rejects.toThrow();
    expect(mocks.trashItem).not.toHaveBeenCalled();
  });

  it("kaldırınca kopya çöp kutusuna taşınır, bağlam listeden çıkar", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    const src = join(docs, "kaynak.md");
    writeFileSync(src, "içerik");
    await save({
      ...project(),
      context: [{ kind: "file", value: src, label: "kaynak.md", copy: null }],
    });
    const copy = channel<{ projectId: string; value: string }, CopyRes>("assistant:copyContext");
    const copied = await copy({ projectId: "p1", value: src });
    const target = copied.project.context[0]?.copy?.path ?? "";

    const remove = channel<{ projectId: string; value: string }, { project: AssistantProject }>(
      "assistant:removeContext",
    );
    const res = await remove({ projectId: "p1", value: src });

    expect(res.project.context).toHaveLength(0);
    expect(mocks.trashItem).toHaveBeenCalledWith(target);
  });

  it("yenileme aynı yolu korur, tek kopya kalır", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    const src = join(docs, "kaynak.md");
    writeFileSync(src, "eski");
    await save({
      ...project(),
      context: [{ kind: "file", value: src, label: "kaynak.md", copy: null }],
    });
    const copy = channel<{ projectId: string; value: string }, CopyRes>("assistant:copyContext");
    const first = await copy({ projectId: "p1", value: src });
    const target = first.project.context[0]?.copy?.path ?? "";
    writeFileSync(src, "yeni");
    const again = await copy({ projectId: "p1", value: src });
    expect(again.project.context[0]?.copy?.path).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("yeni");
  });

  it("bağlam klasörü dışındaki kayıtlı kopyayı çöpe atmaz", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    await save({
      ...project(),
      context: [
        {
          kind: "file",
          value: "/kayıt/dışı",
          label: "dış",
          copy: { path: join(userData, "önemli.json"), copiedAt: 1 },
        },
      ],
    });
    const remove = channel<{ projectId: string; value: string }, { project: AssistantProject }>(
      "assistant:removeContext",
    );
    const res = await remove({ projectId: "p1", value: "/kayıt/dışı" });
    expect(res.project.context).toHaveLength(0);
    expect(mocks.trashItem).not.toHaveBeenCalled();
  });

  it("büyük kaynağı onaysız kopyalamaz", async () => {
    const save = channel<AssistantProject, AssistantProject>("assistant:saveProject");
    const big = join(docs, "buyuk.bin");
    writeFileSync(big, "");
    const fd = openSync(big, "w");
    ftruncateSync(fd, 501 * 1024 * 1024);
    closeSync(fd);
    await save({
      ...project(),
      context: [{ kind: "file", value: big, label: "buyuk.bin", copy: null }],
    });

    const copy = channel<{ projectId: string; value: string }, CopyRes>("assistant:copyContext");
    const res = await copy({ projectId: "p1", value: big });

    expect(res.needsConfirm).toBe(true);
    expect(existsSync(join(docs, "Codezal Asistan", "Finans", "Bağlam", "buyuk.bin"))).toBe(false);
    expect(res.project.context[0]?.copy).toBeNull();
  });
});
