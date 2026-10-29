import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ToolCallItem } from "@codezal/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodezalEngine } from "../engine.js";
import { FLOW_MODEL, FLOW_PROVIDER, flowPrompt, registerFlowModel } from "./flow-model.js";

/**
 * Tur yedeğinin terminal komutu ve alt ajan kapsamı, gerçek motorla (model senaryolu). Ana turu
 * "Geri al" komutun ve aynı klasörde çalışan alt ajanın değişikliklerini de döndürmeli; değişen
 * dosyalar araç kartında (`changedFiles`) görünmeli.
 */

const root = mkdtempSync(join(tmpdir(), "codezal-checkpoint-flow-"));
let work = "";

const engine = new CodezalEngine({
  agentDir: join(root, "pi"),
  sessionsDir: join(root, "sessions"),
  memoryDir: join(root, "memory"),
  agentsDir: join(root, "agents"),
  agentsStateFile: join(root, "agents-state.json"),
  snapshotsDir: join(root, "snapshots"),
});

let flow: { reset: () => void } | undefined;
const events: AgentEvent[] = [];

beforeAll(async () => {
  flow = registerFlowModel(await engine.runtime());
  engine.bus.subscribe((event) => {
    events.push(event);
  });
});

afterAll(async () => {
  await engine.dispose();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  flow?.reset();
  events.length = 0;
  work = mkdtempSync(join(root, "work-"));
  writeFileSync(join(work, "kare.js"), "export const kare = (a) => a + a;\n");
});

async function session(): Promise<string> {
  const summary = await engine.createSession({
    cwd: work,
    mode: "kodlama",
    model: { provider: FLOW_PROVIDER, id: FLOW_MODEL },
    thinking: "low",
    permission: "full",
    location: "local",
    projectId: null,
  });
  return summary.id;
}

async function until(check: () => boolean, label: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`zaman aşımı: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function toolItem(id: string, toolName: string): Promise<ToolCallItem | undefined> {
  const { transcript } = await engine.openSession(id);
  return transcript.find(
    (item): item is ToolCallItem => item.type === "tool" && item.toolName === toolName,
  );
}

const read = (file: string) => readFileSync(join(work, file), "utf8");
const ORIGINAL = "export const kare = (a) => a + a;\n";
const KARE = { file: "kare.js", content: "export const kare = (a) => a * a;" };

describe("tur yedeği: alt ajan ve terminal komutu", () => {
  it("bekletilen alt ajanın yazdığı dosya ana turla geri alınır ve agent kartında görünür", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([KARE]));
    expect(read("kare.js")).toBe(`${KARE.content}\n`);

    const agent = await toolItem(id, "agent");
    expect(agent?.changedFiles).toEqual([{ path: join(work, "kare.js"), kind: "edit" }]);

    const result = engine.undoTurnFiles(id, 1);
    expect(result.restored).toContain(join(work, "kare.js"));
    expect(read("kare.js")).toBe(ORIGINAL);
    await engine.closeSession(id);
  }, 30_000);

  it("arka plan koşusu (worktree'siz) ana oturumun açtığı tura yazar", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([{ ...KARE, background: true }]));
    await until(() => engine.listAgentRuns(id)[0]?.status === "done", "koşu bitsin");
    expect(engine.listAgentRuns(id)[0]?.isolated).toBe(false);
    expect(read("kare.js")).toBe(`${KARE.content}\n`);

    const result = engine.undoTurnFiles(id, 1);
    expect(result.restored).toContain(join(work, "kare.js"));
    expect(read("kare.js")).toBe(ORIGINAL);
    await engine.closeSession(id);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "terminal komutunun oluşturduğu/değiştirdiği/sildiği dosyalar geri alınır ve kartta görünür",
    async () => {
      writeFileSync(join(work, "sil.txt"), "silinecek\n");
      mkdirSync(join(work, "alt"));
      const id = await session();
      await engine.promptAndWait(
        id,
        "KOMUT:printf 'yeni' > alt/yeni.txt && rm sil.txt && printf 'degisti' > kare.js",
      );
      expect(read("kare.js")).toBe("degisti");
      expect(existsSync(join(work, "sil.txt"))).toBe(false);

      const bash = await toolItem(id, "bash");
      const kinds = new Map(bash?.changedFiles?.map((f) => [f.path, f.kind]));
      expect(kinds.get(join(work, "kare.js"))).toBe("edit");
      expect(kinds.get(join(work, "sil.txt"))).toBe("delete");
      expect(kinds.get(join(work, "alt", "yeni.txt"))).toBe("create");
      const end = events.find((e) => e.type === "tool_end" && e.sessionId === id);
      expect(end?.type === "tool_end" ? end.changedFiles?.length : 0).toBe(3);

      const result = engine.undoTurnFiles(id, 1);
      expect(result.partial).toBe(false);
      expect(read("kare.js")).toBe(ORIGINAL);
      expect(read("sil.txt")).toBe("silinecek\n");
      expect(existsSync(join(work, "alt", "yeni.txt"))).toBe(false);
      await engine.closeSession(id);
    },
    30_000,
  );
});
