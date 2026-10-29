import { describe, expect, it } from "vitest";
import { terminalShellFor, userShell } from "./shell";

describe("userShell", () => {
  it("macOS/Linux'ta $SHELL, yoksa zsh", () => {
    if (process.platform === "win32") return;
    const prev = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
    expect(userShell()).toBe("/bin/bash");
    delete process.env.SHELL;
    expect(userShell()).toBe("/bin/zsh");
    if (prev) process.env.SHELL = prev;
  });
});

describe("terminalShellFor", () => {
  it("Windows'ta PowerShell, POSIX'te $SHELL verir", () => {
    expect(terminalShellFor("win32", {})).toBe("powershell.exe");
    expect(terminalShellFor("linux", { SHELL: "/usr/bin/fish" })).toBe("/usr/bin/fish");
    // $SHELL yoksa: macOS zsh, Linux POSIX kabuğu.
    expect(terminalShellFor("darwin", {})).toBe("/bin/zsh");
    expect(terminalShellFor("linux", {})).toBe("/bin/sh");
  });
});
