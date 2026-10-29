import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** node-pty taklidi: `kill` yalnız kayıt tutar, çıkışı test tetikler. */
const h = vi.hoisted(() => {
  interface FakePty {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    exit: (code: number) => void;
  }
  const ptys: FakePty[] = [];
  return { ptys };
});

vi.mock("node-pty", () => ({
  spawn: () => {
    let onExit: (e: { exitCode: number }) => void = () => undefined;
    const pty = {
      pid: 40_000 + h.ptys.length,
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: () => undefined,
      onExit: (cb: (e: { exitCode: number }) => void) => {
        onExit = cb;
      },
      exit: (code: number) => onExit({ exitCode: code }),
    };
    h.ptys.push(pty);
    return pty;
  },
}));
vi.mock("./shell.js", () => ({ userShell: () => "/bin/zsh" }));

const { KILL_GRACE_MS, TerminalManager } = await import("./terminals.js");

describe.skipIf(process.platform === "win32")("TerminalManager kapanışı", () => {
  let processKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ptys.length = 0;
    vi.useFakeTimers();
    processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });
  afterEach(() => {
    processKill.mockRestore();
    vi.useRealTimers();
  });

  it("SIGHUP'a rağmen yaşayan süreci süre dolunca SIGKILL ile öldürür", async () => {
    const tm = new TerminalManager(() => undefined);
    tm.create("/tmp", 80, 24);
    const pty = h.ptys[0];
    const disposed = tm.dispose();
    expect(pty?.kill).toHaveBeenCalledTimes(1);
    expect(processKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    await disposed;
    expect(processKill).toHaveBeenCalledWith(pty?.pid, "SIGKILL");
    expect(tm.list()).toEqual([]);
  });

  it("süre içinde çıkan sürece SIGKILL göndermez", async () => {
    const tm = new TerminalManager(() => undefined);
    const info = tm.create("/tmp", 80, 24);
    tm.kill(info.id);
    h.ptys[0]?.exit(0);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
    expect(processKill).not.toHaveBeenCalled();
  });
});
