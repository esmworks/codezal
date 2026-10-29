import { describe, expect, it } from "vitest";
import { agentShell, agentShellRun, isPowerShell } from "./shell.js";

describe("isPowerShell", () => {
  it("PowerShell 5.1 ve pwsh 7 yollarını tanır", () => {
    expect(isPowerShell("powershell.exe")).toBe(true);
    expect(isPowerShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(
      true,
    );
    expect(isPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
  });

  it("bash ve sh'ı PowerShell saymaz", () => {
    expect(isPowerShell("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
    expect(isPowerShell("/bin/bash")).toBe(false);
    expect(isPowerShell("/bin/sh")).toBe(false);
  });
});

describe("agentShellRun", () => {
  it("bash komutu giriş profiliyle verir (-lc)", () => {
    const run = agentShellRun("pnpm test", "/bin/bash");
    expect(run.shell).toBe("/bin/bash");
    expect(run.args).toEqual(["-lc", "pnpm test"]);
    expect(run.powershell).toBe(false);
    expect(run.stdin).toBeUndefined();
  });

  it("PowerShell'de çıktıyı UTF-8'e sabitler", () => {
    const run = agentShellRun(
      "pnpm test",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(run.powershell).toBe(true);
    expect(run.args[0]).toBe("-Command");
    expect(run.args[1]).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8");
    expect(run.args[1]?.endsWith("pnpm test")).toBe(true);
  });

  it("kabuk çözümlemesi bir kez yapılır ve boş dönmez", () => {
    const shell = agentShell();
    expect(shell.shell.length).toBeGreaterThan(0);
    expect(shell.args.length).toBeGreaterThan(0);
    expect(agentShell()).toBe(shell);
  });

  it("POSIX'te kullanıcının kabuğunu kullanır", () => {
    if (process.platform === "win32") return;
    const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    expect(agentShell().shell).toBe(process.env.SHELL ?? fallback);
  });
});
