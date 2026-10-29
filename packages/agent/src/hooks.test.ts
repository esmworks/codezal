import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedHook } from "@codezal/contracts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { type HookPayload, hookMatches, hooksExtension, resultText, runHook } from "./hooks.js";

const root = mkdtempSync(join(tmpdir(), "cz-hook-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** Geçici klasörde çalıştırılabilir küçük bir kabuk betiği yazar, yolunu döner. */
function script(body: string): string {
  counter += 1;
  const path = join(root, `hook-${counter}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const hook = (
  event: ResolvedHook["event"],
  command: string,
  extra: Partial<ResolvedHook> = {},
): ResolvedHook => ({ event, matcher: "", command, source: "/test/hooks.json", ...extra });

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

/** Pi'nin `on` kaydını taklit eder; kancalar adla çağrılır. */
function harness(hooks: ResolvedHook[] | (() => ResolvedHook[])) {
  const handlers = new Map<string, Handler>();
  const warnings: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  hooksExtension(
    "oturum-1",
    root,
    {
      hooks: () => (typeof hooks === "function" ? hooks() : hooks),
      shell: () => "/bin/sh",
      warn: (message) => warnings.push(message),
    },
    "tr",
  )(pi);
  const ctx = { cwd: root } as unknown as ExtensionContext;
  const call = (name: string, event: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`kanca yok: ${name}`);
    return handler(event, ctx);
  };
  return { call, warnings };
}

const payload = (event: HookPayload["event"]): HookPayload => ({
  event,
  tool: "bash",
  input: { command: "ls" },
  sessionId: "s",
  cwd: root,
});

describe.skipIf(process.platform === "win32")("hook'lar", () => {
  it("eşleştirici araç adının tamamına uygulanır", () => {
    expect(hookMatches("", "bash")).toBe(true);
    expect(hookMatches("*", "write")).toBe(true);
    expect(hookMatches("bash", "bash")).toBe(true);
    expect(hookMatches("bash", "bash_background")).toBe(false);
    expect(hookMatches("edit|write", "write")).toBe(true);
    expect(hookMatches("mcp_.*", "mcp_github_search")).toBe(true);
    expect(hookMatches("[", "bash")).toBeUndefined();
  });

  it("runHook çağrının JSON'unu stdin'e yazar, çalışma klasöründe koşar", async () => {
    const out = join(root, "payload.json");
    const command = script(`cat > "${out}"; pwd >&2; exit 0`);
    const run = await runHook(command, payload("PreToolUse"), {
      cwd: root,
      timeoutMs: 10_000,
      shell: "/bin/sh",
    });
    expect(run.code).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(payload("PreToolUse"));
    expect(run.stderr.trim()).toContain("cz-hook-run-");
  });

  it("runHook süre dolunca beklemez, timedOut döner", async () => {
    const started = Date.now();
    const run = await runHook(script("sleep 5"), payload("PreToolUse"), {
      cwd: root,
      timeoutMs: 200,
      shell: "/bin/sh",
    });
    expect(run.timedOut).toBe(true);
    expect(run.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stdin'i okumayan hook süreci düşürmez", async () => {
    const run = await runHook(script("exit 0"), payload("PreToolUse"), {
      cwd: root,
      timeoutMs: 10_000,
      shell: "/bin/sh",
    });
    expect(run.code).toBe(0);
  });

  it("PreToolUse çıkış kodu 2 çağrıyı engeller, stderr gerekçenin ilk satırıdır", async () => {
    const { call } = harness([
      hook("PreToolUse", script('echo "rm -rf yasak" >&2; exit 2'), { matcher: "bash" }),
    ]);
    const result = (await call("tool_call", {
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "rm -rf /" },
    })) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason.split("\n")[0]).toBe("rm -rf yasak");
    expect(result.reason).toContain("PreToolUse");
  });

  it("PreToolUse çıkış 0 geçer; diğer kodlar ve süre engellemez, uyarı yazar", async () => {
    const { call, warnings } = harness([
      hook("PreToolUse", script("exit 0")),
      hook("PreToolUse", script('echo "bozuk" >&2; exit 1')),
      hook("PreToolUse", script("sleep 5"), { timeoutSec: 0.2 }),
    ]);
    const result = await call("tool_call", { toolName: "read", toolCallId: "c2", input: {} });
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("1 koduyla çıktı: bozuk");
    expect(warnings[1]).toContain("bitmedi");
  });

  it("eşleşmeyen hook çalışmaz, geçersiz eşleştirici uyarıyla atlanır", async () => {
    const marker = join(root, "calisti");
    const { call, warnings } = harness([
      hook("PreToolUse", script(`touch "${marker}"; exit 2`), { matcher: "write" }),
      hook("PreToolUse", script("exit 2"), { matcher: "(" }),
    ]);
    const result = await call("tool_call", { toolName: "bash", toolCallId: "c3", input: {} });
    expect(result).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(warnings.join("\n")).toContain("geçersiz eşleştirici");
  });

  it("hook listesi okunamazsa çağrı sürer", async () => {
    const { call, warnings } = harness(() => {
      throw new Error("okunamadı");
    });
    const result = await call("tool_call", { toolName: "bash", toolCallId: "c4", input: {} });
    expect(result).toBeUndefined();
    expect(warnings[0]).toContain("okunamadı");
  });

  it("PostToolUse sonucu görür; 2 dönerse stderr sonuca eklenir", async () => {
    const seen = join(root, "post.json");
    const { call } = harness([
      hook("PostToolUse", script(`cat > "${seen}"; echo "testleri koş" >&2; exit 2`)),
    ]);
    const content = [{ type: "text", text: "çıktı satırı" }];
    const result = (await call("tool_result", {
      toolName: "write",
      toolCallId: "c5",
      input: { path: "a.ts" },
      content,
      isError: false,
      details: undefined,
    })) as { content: Array<{ type: string; text: string }> };
    const received = JSON.parse(readFileSync(seen, "utf8")) as HookPayload;
    expect(received.event).toBe("PostToolUse");
    expect(received.result).toBe("çıktı satırı");
    expect(received.isError).toBe(false);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual(content[0]);
    expect(result.content[1]?.text).toContain("testleri koş");
  });

  it("PostToolUse 0 dönerse sonuç değişmez", async () => {
    const { call } = harness([hook("PostToolUse", script("exit 0"))]);
    const result = await call("tool_result", {
      toolName: "write",
      toolCallId: "c6",
      input: {},
      content: [{ type: "text", text: "x" }],
      isError: false,
      details: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("resultText görselleri atlar ve uzun metni kırpar", () => {
    const text = resultText([
      { type: "text", text: "a".repeat(20_000) },
      { type: "image", data: "", mimeType: "image/png" },
    ]);
    expect(text.length).toBe(10_001);
  });
});
