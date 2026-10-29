import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedHook } from "@codezal/contracts";
import {
  type Context,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { CodezalEngine } from "./engine.js";
import { SANDBOX_EXEC } from "./sandbox.js";

/**
 * Motor üzerinden uçtan uca: `codezal-hooks` fabrikası gerçekten kayıtlı mı, engel modele dönüyor
 * mu; korumalı alan açıkken `bash` sonucu `sandboxed` ile işaretleniyor mu.
 */
describe.skipIf(process.platform === "win32")(
  "hook'lar ve korumalı alan (motor, çevrimdışı)",
  () => {
    const root = mkdtempSync(join(tmpdir(), "codezal-hooks-engine-"));
    let hooks: ResolvedHook[] = [];
    let sandbox = false;
    const warnings: string[] = [];
    const engine = new CodezalEngine({
      agentDir: join(root, "pi"),
      sessionsDir: join(root, "sessions"),
      memoryDir: join(root, "memory"),
      hooks: () => hooks,
      hookEnv: () => process.env,
      log: (_level, _scope, message) => warnings.push(message),
      bashSandbox: () => sandbox,
      userDataDir: join(root, "veri"),
    });

    afterAll(async () => {
      await engine.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    async function registerFaux(provider: string) {
      const faux = createFauxCore({ api: provider, provider, models: [{ id: "faux-1" }] });
      const runtime = await engine.runtime();
      runtime.registerProvider(provider, {
        api: provider,
        baseUrl: "http://127.0.0.1:9",
        apiKey: "test",
        streamSimple: faux.streamSimple,
        models: [
          {
            id: "faux-1",
            name: "Faux",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 4096,
          },
        ],
      });
      return { faux, dispose: () => runtime.unregisterProvider(provider) };
    }

    /** Model `bash` çağırır, ikinci yanıtta araç sonucunu görür; tur bitince bağlam döner. */
    async function runBash(provider: string, cwd: string, command: string) {
      const { faux, dispose } = await registerFaux(provider);
      let followUp: Context | undefined;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
        (context) => {
          followUp = context;
          return fauxAssistantMessage("tamam");
        },
      ]);
      mkdirSync(cwd, { recursive: true });
      const s = await engine.createSession({
        cwd,
        mode: "kodlama",
        thinking: "low",
        permission: "full",
        location: "local",
        projectId: null,
      });
      const ends: Array<{
        isError: boolean;
        sandboxed?: boolean | undefined;
        denied?: boolean | undefined;
      }> = [];
      const offEnd = engine.bus.on("tool_end", (ev) => {
        if (ev.sessionId === s.id)
          ends.push({ isError: ev.isError, sandboxed: ev.sandboxed, denied: ev.denied });
      });
      try {
        await engine.setModel(s.id, { provider, id: "faux-1" });
        const ended = new Promise<void>((resolve) => {
          const off = engine.bus.on("run_end", (ev) => {
            if (ev.sessionId !== s.id) return;
            off();
            resolve();
          });
        });
        await engine.prompt(s.id, "çalıştır");
        await ended;
        const toolResult = followUp?.messages.find((m) => m.role === "toolResult");
        // Yeniden açılışta kart durumu oturum dosyasından kurulur (canlı akıştaki gibi kalmalı).
        engine.closeSession(s.id);
        const reopened = await engine.openSession(s.id);
        const statuses = reopened.transcript.flatMap((i) => (i.type === "tool" ? [i.status] : []));
        return { toolResult, ends, statuses };
      } finally {
        offEnd();
        engine.closeSession(s.id);
        dispose();
      }
    }

    it("PreToolUse 2 dönerse bash çalışmaz, gerekçe modele gider", async () => {
      const marker = join(root, "calisti");
      const guard = join(root, "guard.sh");
      writeFileSync(guard, '#!/bin/sh\necho "bu komut yasak" >&2\nexit 2\n', "utf8");
      chmodSync(guard, 0o755);
      hooks = [{ event: "PreToolUse", matcher: "bash", command: guard, source: "/test" }];
      try {
        const { toolResult, ends, statuses } = await runBash(
          "codezal-hook-block",
          join(root, "proje-engel"),
          `touch "${marker}"`,
        );
        expect(existsSync(marker)).toBe(false);
        expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
        const text =
          toolResult?.role === "toolResult"
            ? toolResult.content.map((c) => (c.type === "text" ? c.text : "")).join("")
            : "";
        expect(text.startsWith("bu komut yasak")).toBe(true);
        // Kart "hata" değil "reddedildi" çizilsin: komut hiç çalışmadı.
        expect(ends).toEqual([{ isError: true, sandboxed: undefined, denied: true }]);
        expect(statuses).toEqual(["denied"]);
      } finally {
        hooks = [];
      }
    }, 30_000);

    it.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))(
      "korumalı alan açıkken bash sonucu sandboxed işaretlenir, veri kökü okunamaz",
      async () => {
        // Motorun veri kökündeki anahtar dosyası Tam erişimde bile okunamamalı.
        sandbox = true;
        try {
          const engineUserData = join(root, "veri");
          mkdirSync(engineUserData, { recursive: true });
          writeFileSync(join(engineUserData, "keys.json"), "gizli", "utf8");
          const { toolResult, ends, statuses } = await runBash(
            "codezal-sandbox",
            join(root, "proje-korumali"),
            `echo ic > ic.txt; cat "${join(engineUserData, "keys.json")}"`,
          );
          const text =
            toolResult?.role === "toolResult"
              ? toolResult.content.map((c) => (c.type === "text" ? c.text : "")).join("")
              : "";
          expect(text).toContain("Operation not permitted");
          expect(text).not.toContain("gizli");
          expect(existsSync(join(root, "proje-korumali", "ic.txt"))).toBe(true);
          expect(ends).toEqual([{ isError: true, sandboxed: true, denied: undefined }]);
          expect(statuses).toEqual(["error"]);
        } finally {
          sandbox = false;
        }
      },
      30_000,
    );
  },
);
