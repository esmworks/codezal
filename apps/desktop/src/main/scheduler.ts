import type { ScheduledTask } from "@codezal/contracts";

/** Bir sonraki çalışma zamanı (yerel saat); elle çalıştırılan görevde yok. */
export function nextRun(task: ScheduledTask, from = Date.now()): number | null {
  const s = task.schedule;
  if (s.kind === "manual") return null;
  const [hh, mm] = s.time.split(":").map((n) => Number(n) || 0);
  if (s.kind === "interval") return from + (s.intervalMin ?? 60) * 60_000;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(hh ?? 9, mm ?? 0, 0, 0);
  for (let i = 0; i < 62; i++) {
    if (d.getTime() > from) {
      const wd = d.getDay();
      if (s.kind === "daily") return d.getTime();
      if (s.kind === "weekdays" && wd >= 1 && wd <= 5) return d.getTime();
      if (s.kind === "weekly" && wd === (s.weekday ?? 1)) return d.getTime();
      if (s.kind === "monthly" && d.getDate() === (s.monthDay ?? 1)) return d.getTime();
    }
    d.setDate(d.getDate() + 1);
  }
  return from + 24 * 3_600_000;
}

/** Dakikada bir uyanır; vadesi gelen görevleri çalıştırır. */
export class Scheduler {
  #timer: NodeJS.Timeout | undefined;
  readonly #load: () => ScheduledTask[];
  readonly #save: (task: ScheduledTask) => void;
  readonly #run: (task: ScheduledTask) => Promise<void>;
  /**
   * Şu anda koşan görevler. Tik, sıradaki çalışmayı planı **çalıştırmadan önce** yazdığı için
   * koşu aralıktan uzun sürerse sonraki tik aynı görevi ikinci kez başlatıyordu: aynı klasörde iki
   * ajan turu, çakışan düzenlemeler ve iki kez bildirim. Görev bitene kadar yeniden başlatılmaz;
   * plan bitiş anından hesaplanır (bkz. `tick`).
   */
  readonly #running = new Set<string>();

  constructor(
    load: () => ScheduledTask[],
    save: (task: ScheduledTask) => void,
    run: (task: ScheduledTask) => Promise<void>,
  ) {
    this.#load = load;
    this.#save = save;
    this.#run = run;
  }

  start(): void {
    for (const t of this.#load()) {
      if (t.nextRunAt === null && t.schedule.kind !== "manual")
        this.#save({ ...t, nextRunAt: nextRun(t) });
    }
    this.#timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Görevin depodaki güncel kaydı; silinmişse undefined. */
  #current(id: string): ScheduledTask | undefined {
    return this.#load().find((x) => x.id === id);
  }

  async tick(now = Date.now()): Promise<void> {
    // Tik uzun koşuları sırayla bekler; her koşudan sonra saat, verilen `now`dan geçen gerçek süre
    // kadar ilerletilir. Yoksa ilk görev saatlerce sürdüğünde sonrakilerin vadesi ve `lastRunAt`'i
    // eski anla ölçülürdü.
    const started = Date.now();
    let elapsed = 0;
    const clock = () => now + elapsed;
    // Liste başta yalnız kimlik için okunur; her görev başlatılmadan hemen önce **güncel** kaydı
    // yeniden okunur. Önceden baştaki anlık görüntü kullanılıyordu: A uzun sürerken sonraki tik B'yi
    // koşturup bitirse de bu tik A'dan dönünce B'nin bayat `nextRunAt`'ini görüp B'yi ikinci kez
    // başlatıyor, bu arada silinen/duraklatılan/düzenlenen görevi de bayat kayıtla geri yazıyordu.
    for (const id of this.#load().map((t) => t.id)) {
      const t = this.#current(id);
      if (!t) continue;
      // Planı olmayan görev (uygulama açıkken eklendi/düzenlendi) atlanmaz, önce planlanır.
      if (t.nextRunAt === null) {
        if (t.schedule.kind !== "manual") this.#save({ ...t, nextRunAt: nextRun(t, clock()) });
        continue;
      }
      const at = clock();
      if (t.paused || t.nextRunAt > at) continue;
      // Koşan görev yeniden başlatılmaz; sıradaki tik yine vadesi gelmiş görünse de bekler.
      if (this.#running.has(t.id)) continue;
      this.#running.add(t.id);
      // Koşu başlarken kaydedilir: kullanıcı görevin çalıştığını listede görsün.
      this.#save({ ...t, lastRunAt: at });
      try {
        await this.#run(t);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Koşu sırasında silinen görev geri yazılmaz; yalnız hâlâ var olan kayıt güncellenir.
        const cur = this.#current(t.id);
        if (cur) this.#save({ ...cur, lastResult: `Hata: ${msg}` });
      } finally {
        this.#running.delete(t.id);
        elapsed = Date.now() - started;
        // Plan bitişten hesaplanır: koşu aralıktan uzun sürdüğünde bir sonraki tur hemen değil,
        // tam bir aralık sonra gelir (yoksa uzun koşular birbirini kovalardı).
        const cur = this.#current(t.id);
        if (cur && !cur.paused && cur.schedule.kind !== "manual") {
          this.#save({ ...cur, nextRunAt: nextRun(cur) });
        }
      }
    }
  }
}
