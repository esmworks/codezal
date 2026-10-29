import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { IpcEventPayload, TerminalInfo } from "@codezal/contracts";
import { type IPty, spawn } from "node-pty";
import { userShell } from "./shell.js";

interface Entry {
  pty: IPty;
  info: TerminalInfo;
  /** pty süreci çıkınca çözülür. */
  exited: Promise<void>;
  done: boolean;
}

/**
 * `pty.kill()` (SIGHUP) sonrası beklenen süre. SIGHUP'ı yok sayan ya da yakalayıp kapanmayan
 * süreç (`nohup`'lu iş, takılı bir REPL) kapanışta sahipsiz kalıyordu; süre dolunca SIGKILL gider.
 */
export const KILL_GRACE_MS = 1_500;

type Emit = <C extends "terminal:data" | "terminal:exit">(
  channel: C,
  payload: IpcEventPayload<C>,
) => void;

/** node-pty terminalleri; veriler `terminal:data` olayıyla renderer'a akar (TODO 2). */
export class TerminalManager {
  readonly #entries = new Map<string, Entry>();
  readonly #emit: Emit;

  constructor(emit: Emit) {
    this.#emit = emit;
  }

  create(cwd: string, cols: number, rows: number): TerminalInfo {
    const shell = userShell();
    const id = randomUUID();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.LANG = env.LANG ?? "tr_TR.UTF-8";
    const pty = spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });
    const info: TerminalInfo = { id, cwd, title: `${basename(shell)} — ${basename(cwd)}` };
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const entry: Entry = { pty, info, exited, done: false };
    this.#entries.set(id, entry);
    pty.onData((data) => this.#emit("terminal:data", { id, data }));
    pty.onExit(({ exitCode }) => {
      entry.done = true;
      markExited();
      this.#entries.delete(id);
      this.#emit("terminal:exit", { id, code: exitCode });
    });
    return info;
  }

  write(id: string, data: string): void {
    this.#entries.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.#entries.get(id)?.pty.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      // Kapanmış pty'de resize hata verebilir; yok sayılır.
    }
  }

  kill(id: string): void {
    void this.#terminate(id);
  }

  /** Kibarca kapatır; süre içinde çıkmazsa zorla öldürür. Süreç gidince (ya da süre dolunca) çözülür. */
  #terminate(id: string): Promise<void> {
    const e = this.#entries.get(id);
    if (!e) return Promise.resolve();
    this.#entries.delete(id);
    try {
      e.pty.kill();
    } catch {
      // zaten kapanmış
    }
    // Windows'ta `kill()` ConPTY'yi ve süreç ağacını zaten sonlandırır; POSIX sinyali yoktur.
    if (process.platform === "win32" || e.done) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!e.done) {
          try {
            process.kill(e.pty.pid, "SIGKILL");
          } catch {
            // Bu arada çıkmış (ESRCH); yapılacak bir şey yok.
          }
        }
        resolve();
      }, KILL_GRACE_MS);
      void e.exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  list(): TerminalInfo[] {
    return [...this.#entries.values()].map((e) => e.info);
  }

  /** Uygulama kapanırken: hepsine SIGHUP, süre içinde çıkmayanlara SIGKILL. */
  async dispose(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.#terminate(id)));
  }
}
