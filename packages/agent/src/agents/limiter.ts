/**
 * Eşzamanlılık sınırı. Sınır her girişte yeniden okunur: ayar değişince yeni koşular yeni
 * sınırla bekler, çalışanlar kesilmez. Fazla iş sırada bekler; bekleyen iptal edilirse sıradan düşer.
 */
export class Limiter {
  readonly #limit: () => number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: () => number) {
    this.#limit = limit;
  }

  /** Çalışan iş sayısı (test ve tanı için). */
  get active(): number {
    return this.#active;
  }

  /** Yuva boşalınca `task`ı çalıştırır; sırada beklerken `signal` düşerse iş hiç başlamaz. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #free(): boolean {
    return this.#active < Math.max(1, this.#limit());
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.#free()) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.#active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(enter);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(new Error("aborted"));
      };
      this.#waiting.push(enter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #release(): void {
    this.#active -= 1;
    while (this.#free()) {
      const next = this.#waiting.shift();
      if (!next) return;
      next();
    }
  }
}
