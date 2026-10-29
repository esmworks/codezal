import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { BackgroundRunner } from "./background.js";
import { type BashBridge, bashTool } from "./bash-tool.js";
import {
  pathVariants,
  SANDBOX_EXEC,
  type SandboxDecision,
  sandboxCommand,
  sandboxDecision,
  sandboxProfile,
  sandboxSpec,
  sbplString,
  shellQuote,
} from "./sandbox.js";

describe("Seatbelt profili", () => {
  it("SBPL dizesinde ters bölü ve çift tırnak kaçırılır", () => {
    expect(sbplString("/a/b")).toBe('"/a/b"');
    expect(sbplString('/a/"x"')).toBe('"/a/\\"x\\""');
    expect(sbplString("/a\\b")).toBe('"/a\\\\b"');
    // Önce ters bölü: tırnağın kaçış karakteri ikinci kez kaçırılmaz.
    expect(sbplString('\\"')).toBe('"\\\\\\""');
  });

  it("kurallar sırayla: serbest, yazma kapalı, yazılabilir kökler, veri kökü kapalı", () => {
    const profile = sandboxProfile({ writable: ["/proje", "/dev"], denied: ["/veri"] });
    const lines = profile.trim().split("\n");
    expect(lines).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      '(allow file-write* (subpath "/proje") (subpath "/dev"))',
      '(deny file-read* file-write* (subpath "/veri"))',
    ]);
  });

  it("veri kökünün içindeki çalışma klasörü yeniden açılır (Asistan oturumu)", () => {
    const profile = sandboxProfile({
      writable: ["/veri/asistan/p", "/tmp-yok"],
      denied: ["/veri"],
    });
    const last = profile.trim().split("\n").at(-1);
    expect(last).toBe('(allow file-read* file-write* (subpath "/veri/asistan/p"))');
  });

  it("boşluk ve tırnak içeren yol profili bozmaz", () => {
    const profile = sandboxProfile({
      writable: ['/Users/a/Application Support/x"y'],
      denied: [],
    });
    expect(profile).toContain('(subpath "/Users/a/Application Support/x\\"y")');
  });

  it("varsayılan yazılabilir kökler önbellekleri ve geçici klasörleri içerir", () => {
    const spec = sandboxSpec({
      cwd: "/proje",
      outputsDir: "/cikti",
      userDataDir: "/veri",
      home: "/ev",
      env: { TMPDIR: "/var/folders/xx/T/" },
    });
    expect(spec.writable).toEqual(
      expect.arrayContaining([
        "/proje",
        "/cikti",
        "/private/tmp",
        "/private/var/folders",
        "/var/folders/xx/T/",
        "/ev/Library/Caches",
        "/ev/.npm",
        "/ev/Library/pnpm",
        "/ev/.cache",
        "/ev/.cargo/registry",
        "/ev/go/pkg",
        "/dev",
      ]),
    );
    expect(spec.denied).toEqual(["/veri"]);
  });

  it.skipIf(process.platform !== "darwin")("symlink'li yol gerçek hâliyle de yazılır", () => {
    expect(pathVariants("/tmp")).toEqual(["/private/tmp", "/tmp"]);
    expect(pathVariants("/var/yok-boyle-bir-sey")).toEqual(["/var/yok-boyle-bir-sey"]);
  });

  it("kabuk sarmalayıcısı tek tırnağı kaçırır", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(sandboxCommand("echo 'a'", "(version 1)", "/bin/bash", ["-c"])).toBe(
      `exec ${SANDBOX_EXEC} -p '(version 1)' '/bin/bash' '-c' 'echo '\\''a'\\'''`,
    );
  });

  it("ayar kapalıyken ya da macOS dışında karar kapalıdır", () => {
    expect(sandboxDecision(false, { cwd: "/proje" })).toEqual({ kind: "off" });
    if (process.platform !== "darwin") {
      expect(sandboxDecision(true, { cwd: "/proje" })).toEqual({ kind: "off" });
    }
  });
});

const root = mkdtempSync(join(tmpdir(), "cz-sandbox-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Dar profil: yalnız çalışma klasörü ve /dev yazılabilir, sahte veri kökü kapalı. */
function fixture(name: string) {
  const base = join(root, name);
  const cwd = join(base, "proje");
  const outside = join(base, "disari");
  const userData = join(base, "veri");
  for (const dir of [cwd, outside, join(userData, "pi")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userData, "pi", "keys.json"), '{"anahtar":"gizli"}', "utf8");
  const profile = sandboxProfile({ writable: [cwd, "/dev"], denied: [userData] });
  return { cwd, outside, userData, profile };
}

const ctx = (cwd: string) =>
  ({
    cwd,
    sessionManager: { getSessionId: () => "t1", getSessionFile: () => undefined },
  }) as unknown as ExtensionContext;

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

function bridgeFor(runner: BackgroundRunner): BashBridge {
  return {
    unattended: () => false,
    start: (command, opts) =>
      runner.start("s1", opts.cwd, command, {
        backgrounded: false,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        onData: opts.onData,
      }),
    detach: (id) => runner.markBackgrounded(id),
    timeout: (id) => runner.timeout(id),
    stop: (id) => runner.stop(id),
    wait: (id) => runner.waitFor(id),
  };
}

describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))(
  "korumalı alan (macOS)",
  () => {
    it("çalışma klasörüne yazar, dışına yazamaz, veri kökünü okuyamaz", () => {
      const { cwd, outside, userData, profile } = fixture("kabuk");
      const command = [
        "echo ic > ic.txt && echo IC_TAMAM",
        `echo dis > "${join(outside, "dis.txt")}" || echo DIS_ENGEL`,
        `cat "${join(userData, "pi", "keys.json")}" || echo OKUMA_ENGEL`,
        `echo x > "${join(userData, "yeni.txt")}" || echo VERI_YAZMA_ENGEL`,
        "echo > /dev/null && echo DEVNULL_TAMAM",
      ].join("; ");
      const result = spawnSync(
        "/bin/bash",
        ["-c", sandboxCommand(command, profile, "/bin/bash", ["-c"])],
        { cwd, encoding: "utf8" },
      );
      expect(result.stdout).toContain("IC_TAMAM");
      expect(result.stdout).toContain("DIS_ENGEL");
      expect(result.stdout).toContain("OKUMA_ENGEL");
      expect(result.stdout).toContain("VERI_YAZMA_ENGEL");
      expect(result.stdout).toContain("DEVNULL_TAMAM");
      expect(result.stdout).not.toContain("gizli");
      expect(readFileSync(join(cwd, "ic.txt"), "utf8").trim()).toBe("ic");
      expect(existsSync(join(outside, "dis.txt"))).toBe(false);
      expect(existsSync(join(userData, "yeni.txt"))).toBe(false);
    });

    it("varsayılan profil geçerli: sandbox-exec profili kabul eder", () => {
      const { cwd, userData } = fixture("varsayilan");
      const decision = sandboxDecision(true, { cwd, userDataDir: userData });
      expect(decision.kind).toBe("on");
      if (decision.kind !== "on") return;
      const result = spawnSync(
        "/bin/bash",
        ["-c", sandboxCommand("echo ok", decision.profile, "/bin/bash", ["-c"])],
        {
          cwd,
          encoding: "utf8",
        },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ok");
    });

    it("bash aracı iki yolda da korumalı koşar ve çağrıyı bildirir", async () => {
      const { cwd, outside, profile } = fixture("arac");
      const runner = new BackgroundRunner({ onExit: () => {} });
      const sandboxed: string[] = [];
      const decision: SandboxDecision = { kind: "on", profile };
      const tool = bashTool(cwd, bridgeFor(runner), "tr", {
        sandbox: { decide: () => decision, onSandboxed: (id) => sandboxed.push(id) },
      });
      // Arka plana alınabilen yol (BackgroundRunner, argv düzeyinde sarma).
      const auto = textOf(
        await tool.execute(
          "c1",
          { command: `echo ic > a.txt && cat a.txt; echo x > "${outside}/a.txt" || echo ENGEL` },
          undefined,
          undefined,
          ctx(cwd),
        ),
      );
      expect(auto).toContain("ic");
      expect(auto).toContain("ENGEL");
      // Doğrulama komutu Pi'nin yerleşik yürütücüsünde kalır (spawnHook ile sarma).
      const verify = await tool
        .execute(
          "c2",
          // Komutu çalıştırmadan doğrulama kalıbına uyar (`npm … test`).
          { command: `echo npm test; echo x > "${outside}/b.txt"` },
          undefined,
          undefined,
          ctx(cwd),
        )
        .then(textOf, (error: unknown) => (error instanceof Error ? error.message : ""));
      expect(verify).toContain("Operation not permitted");
      expect(existsSync(join(outside, "a.txt"))).toBe(false);
      expect(existsSync(join(outside, "b.txt"))).toBe(false);
      expect(sandboxed).toEqual(["c1", "c2"]);
    });

    it("arka plan görevinin komutu özgün kalır", async () => {
      const { cwd, profile } = fixture("gorev");
      const runner = new BackgroundRunner({ onExit: () => {} });
      const task = runner.start("s1", cwd, "echo merhaba", { sandbox: profile });
      expect(task.command).toBe("echo merhaba");
      const done = await runner.waitFor(task.id);
      expect(done?.code).toBe(0);
      expect(done?.output).toContain("merhaba");
    });
  },
);

describe("sandbox-exec yoksa", () => {
  it("komut korumasız koşar, uyarı oturumda bir kez yazılır", async () => {
    const runner = new BackgroundRunner({ onExit: () => {} });
    const tool = bashTool(root, bridgeFor(runner), "tr", {
      sandbox: { decide: () => ({ kind: "missing" }) },
    });
    const first = textOf(
      await tool.execute("m1", { command: "echo bir" }, undefined, undefined, ctx(root)),
    );
    const second = textOf(
      await tool.execute("m2", { command: "echo iki" }, undefined, undefined, ctx(root)),
    );
    expect(first).toContain("bir");
    expect(first).toContain("sandbox-exec bulunamadı");
    expect(second).toContain("iki");
    expect(second).not.toContain("sandbox-exec");
  });
});
