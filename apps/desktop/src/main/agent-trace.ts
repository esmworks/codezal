import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { maskSecrets, removeQuietly, retrySync } from "@codezal/agent";
import type { AgentEvent } from "@codezal/contracts";
import { log } from "./log.js";

/** Oturum başına yazılan bayt sınırı; aşılınca dosya `.1` olarak devredilir. */
const MAX_BYTES = 5 * 1024 * 1024;
/** Saklama süresi; eski iz dosyaları açılışta silinir ki klasör sınırsız büyümesin. */
const RETENTION_DAYS = 7;
/** Aynı anda açık tutulan akış sayısı: geçmiş oturumlar yazmadıkça akış açmaz. */
const MAX_STREAMS = 8;

interface OpenTrace {
  stream: WriteStream;
  bytes: number;
}

/** Oturum kimliğini dosya adına çevirir; yol ayırıcı ve boşluklar dosya adına sızmasın. */
export function traceFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson`;
}

/**
 * Ajan olaylarının oturum başına NDJSON izi (`agent-events/<oturum>.ndjson`).
 *
 * Kalıcı günlük (`codezal.log`) insan okur satırlar içerir; burada ise olayın kendisi saklanır,
 * böylece bir hata raporunda "hangi sırayla ne oldu" sonradan çıkarılabilir. Satırlar
 * `maskSecrets`'ten geçer (PRD §9) ve yazım hatası yutulur: tanılama akışı düşürmemeli.
 */
export class AgentTrace {
  readonly dir: string;
  #enabled: boolean;
  #open = new Map<string, OpenTrace>();

  constructor(dir: string, enabled: boolean) {
    this.dir = dir;
    this.#enabled = enabled;
    mkdirSync(dir, { recursive: true });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (!on) for (const id of [...this.#open.keys()]) this.close(id);
  }

  fileOf(sessionId: string): string {
    return join(this.dir, traceFileName(sessionId));
  }

  /** Olayı NDJSON satırı olarak yazar; kapalıyken ya da hata durumunda sessizce döner. */
  write(event: AgentEvent): void {
    if (!this.#enabled) return;
    const line = `${maskSecrets(JSON.stringify(event))}\n`;
    let entry = this.#stream(event.sessionId);
    if (!entry) return;
    if (entry.bytes > MAX_BYTES) {
      this.#rotate(event.sessionId);
      entry = this.#stream(event.sessionId);
      if (!entry) return;
    }
    entry.bytes += Buffer.byteLength(line);
    entry.stream.write(line);
  }

  /** Oturum silinince izi de silinir: sahibi olmayan veriyi tutmuyoruz. */
  remove(sessionId: string): void {
    this.close(sessionId);
    removeQuietly(this.fileOf(sessionId));
    removeQuietly(`${this.fileOf(sessionId)}.1`);
  }

  close(sessionId: string): void {
    const entry = this.#open.get(sessionId);
    if (!entry) return;
    this.#open.delete(sessionId);
    entry.stream.end();
  }

  /** Açılışta çağrılır: `days` günden eski iz dosyalarını siler, silinen sayısını döner. */
  prune(days = RETENTION_DAYS, now = Date.now()): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs > days * 86_400_000 && removeQuietly(path)) {
          removed += 1;
        }
      } catch {
        // Silinemeyen dosya sonraki açılışta yeniden denenir.
      }
    }
    if (removed > 0) log.debug("agent-trace", `${removed} eski iz dosyası silindi`);
    return removed;
  }

  #stream(sessionId: string): OpenTrace | undefined {
    const existing = this.#open.get(sessionId);
    if (existing) return existing;
    // En eski akış kapatılır: Map ekleme sırasını korur, LRU için yeterli.
    if (this.#open.size >= MAX_STREAMS) {
      const oldest = this.#open.keys().next().value;
      if (oldest !== undefined) this.close(oldest);
    }
    try {
      const stream = createWriteStream(this.fileOf(sessionId), { flags: "a" });
      stream.on("error", (error) => {
        log.warn("agent-trace", `iz yazılamadı: ${String(error)}`);
        this.close(sessionId);
      });
      // Mevcut dosyanın boyutu devralınır: önceki oturumdan kalan büyük iz de devrilsin.
      let bytes = 0;
      try {
        bytes = statSync(this.fileOf(sessionId)).size;
      } catch {
        // Yeni dosya.
      }
      const entry: OpenTrace = { stream, bytes };
      this.#open.set(sessionId, entry);
      return entry;
    } catch (error) {
      log.warn("agent-trace", `iz açılamadı: ${String(error)}`);
      return undefined;
    }
  }

  #rotate(sessionId: string): void {
    this.close(sessionId);
    try {
      // Windows'ta dosya kilidi yüzünden devir düşebilir; kısa beklemeyle yinelenir.
      retrySync(() => renameSync(this.fileOf(sessionId), `${this.fileOf(sessionId)}.1`));
    } catch {
      // Devir başarısızsa dosya büyümeye devam eder; sonraki turda yeniden denenir.
    }
  }
}
