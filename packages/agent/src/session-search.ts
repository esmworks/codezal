import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  buildSnippet,
  collapsePromptMarkup,
  foldWithMap,
  originalRange,
  type SessionSearchHit,
} from "@codezal/contracts";
import { textOf } from "./mapping.js";

/**
 * Oturum içeriği araması (⌘K). Pi oturum dosyası (JSONL) satır satır okunur; yalnız kullanıcı ve
 * asistan mesajlarının metni dizine girer — araç çıktıları, görseller, düşünme blokları dışarıda.
 *
 * Neden ayrı dizin ve önbellek: bir oturum dosyası görseller ve araç çıktıları yüzünden onlarca MB
 * olabiliyor; her tuş vuruşunda dosyaları baştan okumak aramayı saniyelere çıkarırdı. Dosya bir
 * kez okunur, metin + katlanmış metin bellekte tutulur, dosya değişince (boyut/zaman) yenilenir.
 *
 * Neden etkin dal: geri sarılan (rewind) konuşmalar dosyada kalır ama transkriptte görünmez.
 * Pi yaprağı dosyadaki son kayıttır (`SessionManager._buildIndex`); ondan köke yürünen yol
 * dışındaki mesajlar aranmaz.
 */

/** Dizinlenmiş tek mesaj; `ordinal` etkin daldaki kullanıcı + asistan sırasıdır (1'den). */
export interface IndexedMessage {
  role: "user" | "assistant";
  at: number;
  ordinal: number;
  text: string;
  folded: string;
}

interface RawMessage {
  id: string;
  role: "user" | "assistant";
  at: number;
  text: string;
}

/**
 * Pi kayıt başlığı: `{"type":…,"id":…,"parentId":…,"timestamp":…` sırasıyla yazılır
 * (`appendMessage`). Başlık düzenli ifadeyle okunur; JSON yalnız aranacak satırlarda çözülür —
 * araç çıktısı ve görsel taşıyan dev satırlar hiç ayrıştırılmaz.
 */
const HEAD =
  /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)"),"timestamp":"[^"]*"(?:,"message":\{"role":"([^"]+)")?/;

/** Bozuk ya da beklenmeyen biçimdeki satırın yedek çözümü. */
function parseHead(
  line: string,
): { type: string; id: string; parentId: string | null; role?: string } | null {
  try {
    const entry = JSON.parse(line) as {
      type?: unknown;
      id?: unknown;
      parentId?: unknown;
      message?: { role?: unknown };
    };
    if (typeof entry.type !== "string" || typeof entry.id !== "string") return null;
    const role = entry.message?.role;
    return {
      type: entry.type,
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      ...(typeof role === "string" ? { role } : {}),
    };
  } catch {
    return null;
  }
}

/** Mesaj satırından görünen metin; kullanıcı mesajında gönderim blokları çözülür (balondaki gibi). */
function messageOf(line: string, id: string, role: "user" | "assistant"): RawMessage | null {
  let entry: { timestamp?: unknown; message?: { content?: unknown; timestamp?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const message = entry.message;
  if (!message) return null;
  const raw = textOf(message.content);
  const text = role === "user" ? collapsePromptMarkup(raw) : raw;
  const at =
    typeof message.timestamp === "number"
      ? message.timestamp
      : typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp) || 0
        : 0;
  return { id, role, at, text };
}

/**
 * Satır satır dizin kurucu. Akış okuyucu ve testler aynı kodu kullanır: `push` her satırda,
 * `finish` dosya sonunda çağrılır.
 */
export class SessionLineIndexer {
  readonly #parents = new Map<string, string | null>();
  readonly #messages: RawMessage[] = [];
  #leaf: string | null = null;

  push(line: string): void {
    if (!line.startsWith("{")) return;
    const head = HEAD.exec(line.slice(0, 400));
    const parsed = head
      ? {
          type: head[1] ?? "",
          id: head[2] ?? "",
          parentId: head[3] ?? null,
          ...(head[4] ? { role: head[4] } : {}),
        }
      : parseHead(line);
    if (!parsed || parsed.type === "session") return;
    this.#parents.set(parsed.id, parsed.parentId);
    this.#leaf = parsed.id;
    if (parsed.type !== "message") return;
    if (parsed.role !== "user" && parsed.role !== "assistant") return;
    const message = messageOf(line, parsed.id, parsed.role);
    if (message) this.#messages.push(message);
  }

  /** Etkin daldaki mesajlar, dosya sırasıyla (çocuk kayıt hep ebeveyninden sonra yazılır). */
  finish(): IndexedMessage[] {
    const path = new Set<string>();
    let cursor = this.#leaf;
    // Döngü koruması: bozuk dosyada ebeveyn zinciri kendine dönebilir.
    while (cursor !== null && !path.has(cursor)) {
      path.add(cursor);
      cursor = this.#parents.get(cursor) ?? null;
    }
    const out: IndexedMessage[] = [];
    for (const m of this.#messages) {
      if (!path.has(m.id)) continue;
      out.push({
        role: m.role,
        at: m.at,
        ordinal: out.length + 1,
        text: m.text,
        folded: foldWithMap(m.text).folded,
      });
    }
    return out;
  }
}

/** Satır dizisinden dizin (testler ve küçük girdiler için). */
export function indexSessionLines(lines: Iterable<string>): IndexedMessage[] {
  const indexer = new SessionLineIndexer();
  for (const line of lines) indexer.push(line);
  return indexer.finish();
}

/** Oturum dosyasını akışla okuyup dizinler; dosya bütünüyle belleğe alınmaz. */
export async function indexSessionFile(path: string): Promise<IndexedMessage[]> {
  const indexer = new SessionLineIndexer();
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) indexer.push(line);
  } finally {
    lines.close();
    input.destroy();
  }
  return indexer.finish();
}

/**
 * Dizinde katlanmış sorguyu arar: ilk eşleşen mesajın özeti ve sorguyu içeren mesaj sayısı.
 * Eşleşme yoksa `null`.
 */
export function searchMessages(
  messages: readonly IndexedMessage[],
  needle: string,
): Omit<SessionSearchHit, "id"> | null {
  if (!needle) return null;
  let first: IndexedMessage | undefined;
  let count = 0;
  for (const m of messages) {
    if (!m.folded.includes(needle)) continue;
    count++;
    first ??= m;
  }
  if (!first) return null;
  const source = foldWithMap(first.text);
  const at = source.folded.indexOf(needle);
  const range = originalRange(source, first.text, Math.max(0, at), needle.length);
  const snippet = buildSnippet(first.text, range.start, range.end);
  return {
    role: first.role,
    at: first.at,
    ordinal: first.ordinal,
    snippet: snippet.text,
    matchStart: snippet.matchStart,
    matchEnd: snippet.matchEnd,
    count,
  };
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  chars: number;
  messages: IndexedMessage[];
}

/** Önbellekte tutulacak en çok metin (karakter; özgün + katlanmış). */
const CACHE_CHARS = 12_000_000;

/**
 * Dosya başına dizin önbelleği (LRU). Dosyanın boyutu ya da değişme zamanı değişince yeniden
 * okunur; canlı oturuma eklenen mesaj böylece bir sonraki aramada görünür.
 */
export class SessionSearchIndex {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #limit: number;
  #chars = 0;

  constructor(limit = CACHE_CHARS) {
    this.#limit = limit;
  }

  /** Dosyanın dizini; dosya yoksa (henüz yazılmamış oturum) boş dizi. */
  async messages(path: string): Promise<IndexedMessage[]> {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(path);
    } catch {
      this.#drop(path);
      return [];
    }
    const cached = this.#cache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      // Yeniden ekleme Map sırasını tazeler: LRU ekleme sırasıyla çalışır.
      this.#cache.delete(path);
      this.#cache.set(path, cached);
      return cached.messages;
    }
    this.#drop(path);
    let messages: IndexedMessage[];
    try {
      messages = await indexSessionFile(path);
    } catch {
      return [];
    }
    const chars = messages.reduce((n, m) => n + m.text.length + m.folded.length, 0);
    this.#cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, chars, messages });
    this.#chars += chars;
    this.#evict();
    return messages;
  }

  /** Dosyada arar; isabet yoksa `null`. */
  async search(path: string, needle: string): Promise<Omit<SessionSearchHit, "id"> | null> {
    return searchMessages(await this.messages(path), needle);
  }

  #drop(path: string): void {
    const old = this.#cache.get(path);
    if (!old) return;
    this.#cache.delete(path);
    this.#chars -= old.chars;
  }

  #evict(): void {
    while (this.#chars > this.#limit && this.#cache.size > 1) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#drop(oldest);
    }
  }
}
