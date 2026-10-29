import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Windows'ta silme/taşıma işlemleri açık dosya, antivirüs ya da arama dizini yüzünden geçici
 * olarak `EBUSY`/`EPERM` ile düşer; POSIX'te aynı hata neredeyse hiç görülmez. Bu yardımcılar
 * kilit hatalarını kısa beklemelerle yineler, kalıcı hataları olduğu gibi bırakır.
 */
const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EEXIST"]);

export function isRetryableFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

/**
 * Senkron beklemek zorundayız: çağrı yerleri (günlük devri, ayar yazımı) senkron API'lerde.
 * Bekleme yalnız hata yolunda ve toplam ~200 ms; normal akışta hiç beklenmez.
 */
function sleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Atomics yoksa (beklenmez) kısa meşgul bekleme.
    }
  }
}

/** İşlemi yalnız geçici dosya sistemi hatalarında yeniden dener; diğer hatayı hemen fırlatır. */
export function retrySync<T>(fn: () => T, attempts = 3, delayMs = 70): T {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isRetryableFsError(error)) throw error;
      last = error;
      if (i < attempts - 1) sleep(delayMs * (i + 1));
    }
  }
  throw last;
}

/** Sessizce siler: kilit hatasında yeniden dener, yine olmazsa yok sayar. */
export function removeQuietly(path: string, options: { recursive?: boolean } = {}): boolean {
  try {
    retrySync(() => rmSync(path, { recursive: options.recursive ?? false, force: true }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomik yazım: önce `.tmp` dosyasına yazılır, sonra taşınır. Yarım yazılmış JSON okunmaz ve
 * izleyiciler (fs.watch) boş dosya görmez.
 *
 * `mode` verilirse geçici dosya **o izinlerle** doğar: kimlik dosyalarında (`keys.json`,
 * `auth.json`) yazıp sonra `chmod` etmek, aradaki pencerede düz anahtarı süreç umask'ıyla
 * (genelde 0644) herkese okunur bırakıyordu; çökme hâlinde `.tmp` de öyle kalıyordu.
 */
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  retrySync(() =>
    writeFileSync(tmp, data, options.mode === undefined ? {} : { mode: options.mode }),
  );
  try {
    retrySync(() => renameSync(tmp, path));
  } catch (error) {
    removeQuietly(tmp);
    throw error;
  }
}
