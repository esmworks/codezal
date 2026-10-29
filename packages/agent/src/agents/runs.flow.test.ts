import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PermissionMode, PermissionRequest } from "@codezal/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodezalEngine } from "../engine.js";
import type { WorktreeService } from "../worker.js";
import { FLOW_MODEL, FLOW_PROVIDER, flowPrompt, registerFlowModel } from "./flow-model.js";

/**
 * Ajan koşularının uçtan uca akışı: gerçek motor, gerçek git deposu ve worktree'ler; yalnız model
 * senaryoludur (`flow-model.ts`, Pi'nin faux sağlayıcısı).
 */

const root = mkdtempSync(join(tmpdir(), "codezal-runs-flow-"));
const worktreeRoot = join(root, "worktrees");
let repo = "";
let permission: PermissionMode = "full";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function lines(out: string): string[] {
  return out.split("\n").filter((line) => line.trim() !== "");
}

// Worktree'ler depo dışında: depo içinde olsalar ana klasör izlenmeyen dosya yüzünden kirli sayılırdı.
const worktrees: WorktreeService = {
  create: async ({ cwd, id }) => {
    const branch = `ajan-${id.replace(/[^a-z0-9]/gi, "")}`;
    const path = join(worktreeRoot, branch);
    git(cwd, "worktree", "add", "-q", "-b", branch, path);
    return path;
  },
  remove: async (cwd, path) => {
    const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD");
    git(cwd, "worktree", "remove", "--force", path);
    git(cwd, "branch", "-D", branch);
  },
  changedFiles: async (_cwd, path) =>
    lines(git(path, "status", "--porcelain")).map((line) => line.slice(3)),
  diff: async (path) => {
    git(path, "add", "--intent-to-add", "--", ".");
    return git(path, "diff", "HEAD");
  },
  apply: async (cwd, path) => {
    const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD");
    if (lines(git(path, "status", "--porcelain")).length > 0) {
      git(path, "add", "-A");
      git(path, "commit", "-qm", `Codezal ajan: ${branch}`);
    }
    try {
      git(cwd, "merge", "--no-edit", branch);
    } catch (error) {
      git(cwd, "merge", "--abort");
      throw error;
    }
    // Main köprüsü gibi (`worktreeClean` varsayılan açık): uygulanan worktree ve dalı silinir.
    git(cwd, "worktree", "remove", "--force", path);
    git(cwd, "branch", "-d", branch);
  },
  dirty: async (cwd) => lines(git(cwd, "status", "--porcelain")).length > 0,
};

const engine = new CodezalEngine({
  agentDir: join(root, "pi"),
  sessionsDir: join(root, "sessions"),
  memoryDir: join(root, "memory"),
  agentsDir: join(root, "agents"),
  agentsStateFile: join(root, "agents-state.json"),
  worktrees,
  agentRuns: () => ({ concurrency: 3, worktreePermission: permission }),
});

let flow: { reset: () => void } | undefined;
const events: AgentEvent[] = [];

beforeAll(async () => {
  mkdirSync(worktreeRoot, { recursive: true });
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
  permission = "full";
  repo = mkdtempSync(join(root, "repo-"));
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "test@codezal.dev");
  git(repo, "config", "user.name", "Codezal Test");
  writeFileSync(join(repo, "kare.js"), "export const kare = (a) => a + a;\n");
  writeFileSync(join(repo, "kup.js"), "export const kup = (a) => a * 3;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "ilk");
});

afterEach(() => {
  for (const line of lines(git(repo, "worktree", "list", "--porcelain"))) {
    const path = line.startsWith("worktree ") ? line.slice(9) : "";
    if (path !== "" && path !== repo && path.startsWith(worktreeRoot)) {
      git(repo, "worktree", "remove", "--force", path);
    }
  }
});

async function session(mode: PermissionMode = "full"): Promise<string> {
  const summary = await engine.createSession({
    cwd: repo,
    mode: "kodlama",
    model: { provider: FLOW_PROVIDER, id: FLOW_MODEL },
    thinking: "low",
    permission: mode,
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

const read = (file: string) => readFileSync(join(repo, file), "utf8");

const KARE = { file: "kare.js", content: "export const kare = (a) => a * a;" };
const KUP = { file: "kup.js", content: "export const kup = (a) => a * a * a;" };

describe("ajan koşuları uçtan uca (senaryolu model, gerçek git)", () => {
  it("temiz depoda paralel iki yazan ajan: biri kökte, biri worktree'de; Uygula ana dala girer", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([KARE, KUP]));

    const runs = engine.listAgentRuns(id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error("koşu yok");
    expect(run.isolated).toBe(true);
    expect(run.status).toBe("review");
    // Kökte çalışan ajanın değişikliği ana klasörde, worktree'dekinin değişikliği henüz değil.
    const rootFile = run.title.startsWith("kare") ? "kup.js" : "kare.js";
    const isolatedFile = rootFile === "kare.js" ? "kup.js" : "kare.js";
    const isolatedFix = isolatedFile === "kare.js" ? KARE.content : KUP.content;
    expect(read(rootFile)).toBe(`${(rootFile === "kare.js" ? KARE : KUP).content}\n`);
    expect(read(isolatedFile)).not.toContain(isolatedFix);
    expect(await engine.agentRunDiff(id, run.id)).toContain(isolatedFix);

    // Kökteki değişiklik commit'lenir ki birleştirme ana klasördeki yerel değişiklikle çakışmasın.
    git(repo, "commit", "-qam", "kök düzeltmesi");
    await engine.reviewAgentRun(id, run.id, "apply");
    expect(read(isolatedFile)).toBe(`${isolatedFix}\n`);
    // Kökteki commit yüzünden birleştirme fast-forward değil; koşunun commit'i geçmişte olmalı.
    expect(git(repo, "log", "-3", "--format=%s")).toMatch(/Codezal ajan: ajan-/);
    expect(engine.listAgentRuns(id)[0]?.status).toBe("done");
    expect(lines(git(repo, "worktree", "list"))).toHaveLength(1);
    await engine.closeSession(id);
  }, 30_000);

  it("kirli depoda otomatik yalıtım yapılmaz: iki ajan da kökte çalışır", async () => {
    writeFileSync(join(repo, "not.txt"), "commit'lenmemiş\n");
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([KARE, KUP]));

    expect(engine.listAgentRuns(id)).toHaveLength(0);
    expect(read("kare.js")).toBe(`${KARE.content}\n`);
    expect(read("kup.js")).toBe(`${KUP.content}\n`);
    expect(lines(git(repo, "worktree", "list"))).toHaveLength(1);
    await engine.closeSession(id);
  }, 30_000);

  it("model isolation: none gönderirse çağrı reddedilir, dosya değişmez", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([{ ...KARE, isolation: "none" }]));

    expect(engine.listAgentRuns(id)).toHaveLength(0);
    expect(read("kare.js")).toBe("export const kare = (a) => a + a;\n");
    const failed = events.find(
      (e) => e.type === "tool_end" && e.sessionId === id && e.isError === true,
    );
    expect(failed, "agent çağrısı şema hatasıyla bitmeli").toBeDefined();
    await engine.closeSession(id);
  }, 30_000);

  it("arka plan koşusu worktree'de; bitince ana oturum uyanır, Sil worktree ve dalı kaldırır", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([{ ...KARE, background: true }]));
    await until(() => engine.listAgentRuns(id)[0]?.status === "review", "koşu incelemeye düşsün");
    // Dürtme ana oturumda yeni bir tur açar (arka plan sonucu modele gider).
    await until(
      () => events.filter((e) => e.type === "run_start" && e.sessionId === id).length >= 2,
      "ana oturum dürtülsün",
    );
    const run = engine.listAgentRuns(id)[0];
    if (!run) throw new Error("koşu yok");
    expect(run.background).toBe(true);
    expect(read("kare.js")).toBe("export const kare = (a) => a + a;\n");

    await engine.reviewAgentRun(id, run.id, "discard");
    expect(engine.listAgentRuns(id)[0]?.status).toBe("cancelled");
    expect(lines(git(repo, "worktree", "list"))).toHaveLength(1);
    expect(lines(git(repo, "branch", "--list", "ajan-*"))).toHaveLength(0);
    expect(read("kare.js")).toBe("export const kare = (a) => a + a;\n");
    await engine.closeSession(id);
  }, 30_000);

  it("çakışan Uygula ana dalı bozmaz, koşu incelemede kalır", async () => {
    const id = await session();
    await engine.promptAndWait(id, flowPrompt([{ ...KARE, background: true }]));
    await until(() => engine.listAgentRuns(id)[0]?.status === "review", "koşu incelemeye düşsün");
    const run = engine.listAgentRuns(id)[0];
    if (!run) throw new Error("koşu yok");
    // Ajan çalışırken kullanıcı aynı satırı ana dalda değiştirdi.
    writeFileSync(join(repo, "kare.js"), "export const kare = (a) => a ** 2;\n");
    git(repo, "commit", "-qam", "ana değişiklik");
    const head = git(repo, "rev-parse", "HEAD");

    await expect(engine.reviewAgentRun(id, run.id, "apply")).rejects.toThrow();
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(engine.listAgentRuns(id)[0]?.status).toBe("review");
    await engine.reviewAgentRun(id, run.id, "discard");
    await engine.closeSession(id);
  }, 30_000);

  it("Sor modunda koşunun izni ana oturumda run etiketiyle sorulur ve yanıtla kalkar", async () => {
    permission = "ask";
    const id = await session("ask");
    const asked: PermissionRequest[] = [];
    const off = engine.bus.subscribe((event) => {
      if (event.type === "permission_request" && event.request.run) asked.push(event.request);
    });
    const done = engine.promptAndWait(id, flowPrompt([{ ...KARE, background: true }]));
    await until(() => asked.length > 0, "koşunun izin isteği gelsin");
    const request = asked[0];
    if (!request) throw new Error("istek yok");
    expect(request.sessionId).toBe(id);
    expect(request.run?.title).toBe("kare.js düzelt");
    // Ana oturumun durumu koşunun isteğiyle "waiting"e dönmez.
    const statuses = events.filter((e) => e.type === "status" && e.sessionId === id);
    expect(statuses.at(-1)).not.toMatchObject({ status: "waiting" });

    engine.respondPermission(request.requestId, "allow");
    await until(
      () =>
        events.some((e) => e.type === "permission_resolved" && e.requestId === request.requestId),
      "kart kalksın",
    );
    await done;
    await until(() => engine.listAgentRuns(id)[0]?.status === "review", "koşu incelemeye düşsün");
    off();
    const run = engine.listAgentRuns(id)[0];
    if (run) await engine.reviewAgentRun(id, run.id, "discard");
    await engine.closeSession(id);
  }, 30_000);

  it("plan modunda arka plan yazan ajan reddedilir, dosya değişmez", async () => {
    const id = await session("plan");
    await engine.promptAndWait(id, flowPrompt([{ ...KARE, background: true }]));
    expect(engine.listAgentRuns(id)).toHaveLength(0);
    expect(read("kare.js")).toBe("export const kare = (a) => a + a;\n");
    await engine.closeSession(id);
  }, 30_000);
});
