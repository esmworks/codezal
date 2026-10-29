import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { removeQuietly, retrySync, writeFileAtomic } from "./fsx.js";

/** Bu boyutun üstündeki dosyalar yedeklenmez (geri alma o dosyayı atlar). */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

interface Entry {
  path: string;
  /** Tur öncesinde dosya var mıydı; yoksa geri alma dosyayı siler. */
  existed: boolean;
  /** Yedek dosyasının adı (`existed` ise). */
  blob?: string;
  /** Yedek alınamadı (boyut sınırı ya da dosya değil): geri alma bunu bildirir. */
  skipped?: boolean;
}

interface Manifest {
  entries: Entry[];
  /**
   * Tur yedeği eksik olabilir: terminal komutu taranan dosya sınırını aştı ya da değişen dosya
   * sayısı kayıt sınırını geçti. Geri alma bunu bildirir; kullanıcı "her şey geri alındı" sanmaz.
   */
  partial?: boolean;
}

/** `recordBatch` girdisi: terminal komutu sonrası ölçülen tek değişiklik. */
export type BatchItem =
  | { path: string; kind: "created" }
  /** Tur öncesi içerik bellekte (git nesnesi) ya da önceden kopyalanmış dosyada. */
  | { path: string; kind: "content"; data: Uint8Array }
  | { path: string; kind: "content"; file: string }
  /** Tur öncesi içerik alınamadı (bütçe/boyut sınırı): geri alma bunu bildirir. */
  | { path: string; kind: "skipped" };

export interface RestoreResult {
  /** Tur öncesi içeriğine döndürülen dosyalar. */
  restored: string[];
  /** Turda oluşturulduğu için silinen dosyalar. */
  removed: string[];
  /**
   * Yedeklenemediği için geri alınamayan dosyalar (`MAX_SNAPSHOT_BYTES` üstü ya da dosya değil).
   * Bildirilmezse kullanıcı "geri alındı" mesajını görüp büyük dosyanın değişmiş hâlini
   * farkında olmadan bırakırdı.
   */
  skipped: string[];
  /** Turun yedeği eksik (tarama/kayıt sınırı aşıldı): bazı değişiklikler kapsanmamış olabilir. */
  partial: boolean;
}

/**
 * Tur öncesi dosya yedekleri: `edit`/`write` çalışmadan önce dosyanın o anki hâli saklanır,
 * kullanıcı "Geri al" deyince tur öncesine dönülür. Anahtar oturum + kullanıcı mesajı sırası
 * (renderer ve geri sarma aynı sırayla sayar). Aynı turda aynı dosyaya ikinci dokunuş yedeği
 * değiştirmez: ilk hâl korunur. Terminal komutlarının değiştirdikleri `bash-snapshot.ts`
 * üzerinden `recordBatch` ile aynı tura yazılır (komut öncesi tarama + sonrası fark).
 */
export class SnapshotStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #dir(sessionId: string, turn: number): string {
    return join(this.#root, sessionId, String(turn));
  }

  #read(dir: string): Manifest {
    const file = join(dir, "manifest.json");
    if (!existsSync(file)) return { entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Manifest>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        ...(parsed.partial === true ? { partial: true } : {}),
      };
    } catch {
      return { entries: [] };
    }
  }

  #write(dir: string, manifest: Manifest): void {
    // Atomik: yarım yazılmış manifest, geri almada dosyaları kaybettirirdi.
    writeFileAtomic(join(dir, "manifest.json"), JSON.stringify(manifest));
  }

  /** Dosyanın tur öncesi hâlini saklar; bu turda daha önce saklandıysa dokunmaz. */
  record(sessionId: string, turn: number, path: string): void {
    const dir = this.#dir(sessionId, turn);
    const manifest = this.#read(dir);
    if (manifest.entries.some((e) => e.path === path)) return;
    let entry: Entry;
    if (existsSync(path)) {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
        // Yedek alınamadı: kaydı tutulur ki geri alma bunu **bildirsin** (sessiz atlama yok).
        manifest.entries.push({ path, existed: true, skipped: true });
        this.#write(dir, manifest);
        return;
      }
      const blob = `${manifest.entries.length}.bin`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, blob), readFileSync(path));
      entry = { path, existed: true, blob };
    } else entry = { path, existed: false };
    manifest.entries.push(entry);
    this.#write(dir, manifest);
  }

  /**
   * Komut sonrası ölçülen değişiklikleri tek manifest yazımıyla kaydeder. Bu turda zaten kayıtlı
   * yol atlanır (ilk hâl korunur). `partial` verilirse tur yedeği eksik işaretlenir. Yeni
   * kaydedilen yollar döner.
   */
  recordBatch(
    sessionId: string,
    turn: number,
    items: readonly BatchItem[],
    partial = false,
  ): string[] {
    const dir = this.#dir(sessionId, turn);
    const manifest = this.#read(dir);
    const known = new Set(manifest.entries.map((e) => e.path));
    const added: string[] = [];
    for (const item of items) {
      if (known.has(item.path)) continue;
      known.add(item.path);
      if (item.kind === "created") {
        manifest.entries.push({ path: item.path, existed: false });
      } else if (item.kind === "skipped") {
        manifest.entries.push({ path: item.path, existed: true, skipped: true });
      } else {
        const blob = `${manifest.entries.length}.bin`;
        mkdirSync(dir, { recursive: true });
        try {
          if ("data" in item) writeFileSync(join(dir, blob), item.data);
          else copyFileSync(item.file, join(dir, blob));
          manifest.entries.push({ path: item.path, existed: true, blob });
        } catch {
          // Yedek yazılamadı: sessiz atlama yok, geri alma dosyayı "alınamadı" diye bildirir.
          manifest.entries.push({ path: item.path, existed: true, skipped: true });
        }
      }
      added.push(item.path);
    }
    if (partial) manifest.partial = true;
    if (added.length > 0 || partial) this.#write(dir, manifest);
    return added;
  }

  /** Bu turda yedeği alınmış yollar; komut öncesi kopyalama bunları atlar (ilk hâl zaten var). */
  recordedPaths(sessionId: string, turn: number): Set<string> {
    return new Set(this.#read(this.#dir(sessionId, turn)).entries.map((e) => e.path));
  }

  /**
   * Komut öncesi kopyaların geçici klasörü. Tur klasörünün altındadır: oturum silinince
   * (`clear`) onunla gider; okuma yolları yalnız `manifest.json`'a baktığı için karışmaz.
   */
  stageDir(sessionId: string, turn: number): string {
    return join(this.#dir(sessionId, turn), "stage");
  }

  /** Bu tur için yedek var mı (yalnız "eksik" işaretli boş kayıt da sayılır: bildirilsin). */
  has(sessionId: string, turn: number): boolean {
    const manifest = this.#read(this.#dir(sessionId, turn));
    return manifest.entries.length > 0 || manifest.partial === true;
  }

  /**
   * Bu oturumda `since` anından sonra değişmiş, yedeklemesi bulunan dosyalar. Arka plan görevi
   * başladıktan sonra yapılan düzeltmeleri tespit eder: bildirime "sonuç eski olabilir" notu
   * düşülür ve model gereksiz bir doğrulama koşusu başlatmaz. `bash` ile değişen dosyalar kapsam
   * dışıdır; silinmiş dosya değişiklik kanıtı sayılmaz.
   */
  changedSince(sessionId: string, since: number): string[] {
    const root = join(this.#root, sessionId);
    if (!existsSync(root)) return [];
    const out = new Set<string>();
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const entry of this.#read(join(root, dir.name)).entries) {
        if (out.has(entry.path)) continue;
        try {
          if (statSync(entry.path).mtimeMs > since) out.add(entry.path);
        } catch {
          // Dosya artık yok: "değişti" denemez, atlanır.
        }
      }
    }
    return [...out];
  }

  /**
   * Turdaki dosyaları tur öncesi hâline döndürür; yedek yoksa boş sonuç. `except` içindeki
   * yollara dokunulmaz (git tabanlı tur geri alması onları zaten döndürdü).
   */
  restore(sessionId: string, turn: number, except?: ReadonlySet<string>): RestoreResult {
    const dir = this.#dir(sessionId, turn);
    const { entries, partial } = this.#read(dir);
    const result: RestoreResult = {
      restored: [],
      removed: [],
      skipped: [],
      partial: partial === true,
    };
    for (const e of entries) {
      if (except?.has(e.path)) continue;
      if (e.skipped) {
        result.skipped.push(e.path);
        continue;
      }
      if (e.existed && e.blob) {
        const blob = join(dir, e.blob);
        if (!existsSync(blob)) continue;
        mkdirSync(dirname(e.path), { recursive: true });
        writeFileSync(e.path, readFileSync(blob));
        result.restored.push(e.path);
      } else if (!e.existed && existsSync(e.path)) {
        // Windows'ta dosya kilitli olabilir (editör, sunucu); kısa beklemeyle yeniden denenir,
        // yine olmazsa hata kullanıcıya geri alma hatası olarak döner.
        retrySync(() => unlinkSync(e.path));
        result.removed.push(e.path);
      }
    }
    return result;
  }

  /** Oturum silinince yedekleri de kaldırır. */
  clear(sessionId: string): void {
    removeQuietly(join(this.#root, sessionId), { recursive: true });
  }
}
