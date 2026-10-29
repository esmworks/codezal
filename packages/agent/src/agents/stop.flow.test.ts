import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PermissionMode, ResolvedHook, ToolCallItem } from "@codezal/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodezalEngine } from "../engine.js";
import { FLOW_MODEL, FLOW_PROVIDER, flowPrompt, registerFlowModel } from "./flow-model.js";

/**
 * Alt ajanın durdurulan çağrıları, gerçek motorla (model senaryolu). Plan modunun engellediği ya
 * da kullanıcının hook'unun reddettiği `write`, Ajanlar panelindeki izde "hata" değil
 * "engellendi"/"reddedildi" bitmeli; işaret ana oturum kimliğiyle düşer, iz izleyicisi tüketir.
 */

const root = mkdtempSync(join(tmpdir(), "codezal-stop-flow-"));
let work = "";
let hooks: ResolvedHook[] = [];

const engine = new CodezalEngine({
  agentDir: join(root, "pi"),
  sessionsDir: join(root, "sessions"),
  memoryDir: join(root, "memory"),
  agentsDir: join(root, "agents"),
  agentsStateFile: join(root, "agents-state.json"),
  snapshotsDir: join(root, "snapshots"),
  hooks: () => hooks,
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
  hooks = [];
  work = mkdtempSync(join(root, "work-"));
});

/** Alt ajanın `write` çağrısının izdeki son hâli. */
async function subagentWrite(permission: PermissionMode): Promise<ToolCallItem | undefined> {
  const summary = await engine.createSession({
    cwd: work,
    mode: "kodlama",
    model: { provider: FLOW_PROVIDER, id: FLOW_MODEL },
    thinking: "low",
    permission,
    location: "local",
    projectId: null,
  });
  try {
    await engine.promptAndWait(summary.id, flowPrompt([{ file: "yeni.txt", content: "x" }]));
  } finally {
    await engine.closeSession(summary.id);
  }
  const ends = events.flatMap((e) =>
    e.type === "subagent_trace" &&
    e.sessionId === summary.id &&
    e.item.type === "tool" &&
    e.item.toolName === "write" &&
    e.item.status !== "running"
      ? [e.item]
      : [],
  );
  return ends.at(-1);
}

describe("alt ajanın durdurulan çağrıları", () => {
  it("plan modunun engellediği yazma izde 'engellendi' biter", async () => {
    const item = await subagentWrite("plan");
    expect(item?.status).toBe("blocked");
    expect(existsSync(join(work, "yeni.txt"))).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "hook'un reddettiği yazma izde 'reddedildi' biter",
    async () => {
      hooks = [
        {
          event: "PreToolUse",
          matcher: "write",
          command: "echo 'yazma yasak' >&2; exit 2",
          source: "/test",
        },
      ];
      const item = await subagentWrite("full");
      expect(item?.status).toBe("denied");
      expect(item?.output).toContain("yazma yasak");
      expect(existsSync(join(work, "yeni.txt"))).toBe(false);
    },
    30_000,
  );
});

describe("alt ajan izi oturum dosyasında", () => {
  it("biten koşu ve izi yeniden açılışta gelir, sonraki koşunun yayınında da kalır", async () => {
    const summary = await engine.createSession({
      cwd: work,
      mode: "kodlama",
      model: { provider: FLOW_PROVIDER, id: FLOW_MODEL },
      thinking: "low",
      permission: "full",
      location: "local",
      projectId: null,
    });
    const id = summary.id;
    await engine.promptAndWait(id, flowPrompt([{ file: "bir.txt", content: "1" }]));
    await engine.closeSession(id);

    const opened = await engine.openSession(id);
    expect(opened.subagents.map((r) => r.status)).toEqual(["done"]);
    const first = opened.subagents[0];
    const trace = opened.subagentTraces.find((t) => t.runId === first?.id);
    const write = trace?.items.find(
      (i): i is ToolCallItem => i.type === "tool" && i.toolName === "write",
    );
    expect(write?.status).toBe("done");

    events.length = 0;
    await engine.promptAndWait(id, flowPrompt([{ file: "iki.txt", content: "2" }]));
    const last = events.filter((e) => e.type === "subagents" && e.sessionId === id).at(-1);
    const ids = last?.type === "subagents" ? last.runs.map((r) => r.id) : [];
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(first?.id);
    await engine.closeSession(id);

    // İki koşu da dosyada: ikinci açılışta ikisi birden gelir.
    const again = await engine.openSession(id);
    expect(again.subagents.map((r) => r.id)).toEqual(ids);

    // Kopya oturum (openSession'dan geçmeden canlıya alınır) dosyayla gelen koşuları da görür.
    const fork = await engine.forkSession(id);
    const forked = await engine.openSession(fork.id);
    expect(forked.subagents.map((r) => r.id)).toEqual(ids);
    await engine.closeSession(fork.id);
    await engine.closeSession(id);
  }, 30_000);
});
