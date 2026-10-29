import { useSyncExternalStore } from "react";
import { invoke } from "../api";

/**
 * Yanıt metnindeki yol çiplerinin diskte durup durmadığı. Çip yalnız dosya varsa tıklanır:
 * asistanın Drive'daki ya da başka makinedeki bir dosyanın adını yazması sahte bir "aç" düğmesi
 * üretiyordu, tıklayınca görüntüleyici "okunamadı" diyordu.
 *
 * Aynı karedeki sorgular tek `files:exists` çağrısında toplanır (kanal en çok 50 yol alır, fazlası
 * parçalanır). Sonuç modül ömrü boyunca önbellekte kalır; yok çıkanlar `forgetMissing` ile yeniden
 * sorulur (tur bitince ajan dosyayı yazmış olabilir). Yeniden sorgu sürerken eski `false` gösterilir
 * ki çip bir an bağlantıya dönüp geri gelmesin.
 */

const MAX_BATCH = 50;

export interface ExistsStore {
  /** `undefined`: henüz bilinmiyor (sorgu kuyruğa alınır). */
  get: (path: string) => boolean | undefined;
  subscribe: (listener: () => void) => () => void;
  forgetMissing: () => void;
}

export function createExistsStore(check: (paths: string[]) => Promise<boolean[]>): ExistsStore {
  const cache = new Map<string, boolean>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;

  const emit = () => {
    for (const l of listeners) l();
  };

  const flush = () => {
    scheduled = false;
    const paths = [...queued];
    queued.clear();
    for (let i = 0; i < paths.length; i += MAX_BATCH) {
      const batch = paths.slice(i, i + MAX_BATCH);
      for (const p of batch) inFlight.add(p);
      check(batch)
        .then((found) => {
          batch.forEach((p, j) => {
            cache.set(p, found[j] ?? true);
          });
        })
        // Yoklama başarısızsa çip gizlenmez: görüntüleyici zaten okuyamadığını söyler.
        .catch(() => {
          for (const p of batch) cache.set(p, true);
        })
        .finally(() => {
          for (const p of batch) inFlight.delete(p);
          emit();
        });
    }
  };

  const enqueue = (path: string) => {
    if (inFlight.has(path) || queued.has(path)) return;
    queued.add(path);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  return {
    get(path) {
      const known = cache.get(path);
      if (known === undefined) enqueue(path);
      return known;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forgetMissing() {
      for (const [path, exists] of cache) if (!exists) enqueue(path);
    },
  };
}

const store = createExistsStore((paths) => invoke("files:exists", { paths }));

/** Yok çıkan yolları yeniden sorar; render sırasında değil etkide çağrılır. */
export const forgetMissingPaths = (): void => store.forgetMissing();

/** Yol verilmezse `undefined`; hook koşulsuz çağrılabilsin diye. */
export function usePathExists(path: string | undefined): boolean | undefined {
  return useSyncExternalStore(store.subscribe, () => (path ? store.get(path) : undefined));
}
