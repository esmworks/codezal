import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets, retrySync } from "@codezal/agent";
import type { LogLevel, LogLine } from "@codezal/contracts";

const MAX_BYTES = 5 * 1024 * 1024;
/** Tanılama sayfasının gördüğü halka tampon; canlı akış yokken de geçmiş kalır. */
const BUFFER_LINES = 500;

/**
 * Tek dosyaya eklemeli yazan havuz. Paket eklemek yerine küçük bir sarmalayıcı; 5 MB'ı aşınca
 * tek yedek (`.1`) tutar. Yazım hatası yutulur: loglama uygulamayı düşürmemeli.
 */
class LogSink {
  readonly path: string;

  constructor(dir: string, file: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, file);
  }

  write(line: string): void {
    try {
      this.#rotate();
      appendFileSync(this.path, line, "utf8");
    } catch {
      // Disk dolu ya da izin yok; yazamazsak sessiz kal.
    }
  }

  #rotate(): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    try {
      // Windows'ta günlük dosyası kilitli olabilir (Defender/indeksleyici); kısa beklemeyle yinelenir.
      retrySync(() => renameSync(this.path, `${this.path}.1`));
    } catch {
      // Devir başarısızsa dosya büyümeye devam eder; sonraki boyut denetiminde yeniden denenir.
    }
  }
}

type Listener = (line: LogLine) => void;

/**
 * Dosya loglayıcı: `logs/codezal.log` (bilgi/uyarı/hata) ve `logs/codezal-debug.log` (debug).
 * Ayrıntılı satırlar ayrı dosyaya gider ki ana günlük şişmesin. Son satırlar bellekte halka
 * tamponda tutulur; Tanılama sayfası oradan beslenir ve canlı akışa abone olabilir.
 */
export class FileLogger {
  readonly path: string;
  readonly debugPath: string;
  #main: LogSink;
  #debug: LogSink;
  #buffer: LogLine[] = [];
  #listeners = new Set<Listener>();
  #verbose: boolean;

  constructor(dir: string, verbose = false) {
    this.#main = new LogSink(dir, "codezal.log");
    this.#debug = new LogSink(dir, "codezal-debug.log");
    this.path = this.#main.path;
    this.debugPath = this.#debug.path;
    this.#verbose = verbose;
  }

  get verbose(): boolean {
    return this.#verbose;
  }

  /** Ayrıntılı günlük anahtarı; kapatınca debug satırı ne yazılır ne tampona girer. */
  setVerbose(on: boolean): void {
    this.#verbose = on;
  }

  info(scope: string, message: string): void {
    this.#write("info", scope, message);
  }

  warn(scope: string, message: string): void {
    this.#write("warn", scope, message);
  }

  error(scope: string, error: unknown): void {
    const text =
      error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
    this.#write("error", scope, text);
  }

  debug(scope: string, message: string): void {
    if (!this.#verbose) return;
    this.#write("debug", scope, message);
  }

  /** Halka tampondan son satırlar; seviye verilirse yalnız o seviye. */
  tail(lines = BUFFER_LINES, level?: LogLevel): LogLine[] {
    const filtered = level ? this.#buffer.filter((l) => l.level === level) : this.#buffer;
    return filtered.slice(-lines);
  }

  /** Canlı akış aboneliği; dönen fonksiyon aboneliği kaldırır. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #write(level: LogLevel, scope: string, message: string): void {
    const masked = maskSecrets(message);
    const line: LogLine = { at: Date.now(), level, scope, message: masked };
    this.#buffer.push(line);
    if (this.#buffer.length > BUFFER_LINES)
      this.#buffer.splice(0, this.#buffer.length - BUFFER_LINES);
    for (const listener of this.#listeners) {
      try {
        listener(line);
      } catch {
        // Abone hatası diğer aboneleri ve yazımı engellemesin.
      }
    }
    const text = `${new Date(line.at).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${masked}\n`;
    if (level === "debug") this.#debug.write(text);
    else this.#main.write(text);
    if (level === "error") console.error(text.trimEnd());
  }
}

let current: FileLogger | undefined;

export function initLogger(dir: string, verbose = false): FileLogger {
  current = new FileLogger(dir, verbose);
  return current;
}

/** `CODEZAL_LOG=debug|verbose|1` ayrıntılı günlüğü ayardan bağımsız açar (geliştirme aracı). */
export function verboseFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|debug|verbose)$/i.test(env.CODEZAL_LOG ?? "");
}

/** Henüz başlatılmadıysa konsola düşer; main erken hataları da kaybetmesin. */
export const log = {
  info: (scope: string, message: string) => current?.info(scope, message),
  warn: (scope: string, message: string) =>
    current?.warn(scope, message) ?? console.warn(scope, message),
  error: (scope: string, error: unknown) =>
    current?.error(scope, error) ?? console.error(scope, error),
  debug: (scope: string, message: string) => current?.debug(scope, message),
  setVerbose: (on: boolean) => current?.setVerbose(on),
  verbose: () => current?.verbose ?? false,
  tail: (lines?: number, level?: LogLevel) => current?.tail(lines, level) ?? [],
  subscribe: (listener: (line: LogLine) => void) => current?.subscribe(listener) ?? (() => {}),
  path: () => current?.path ?? "",
  debugPath: () => current?.debugPath ?? "",
};
