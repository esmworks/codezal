import type { PerfMetric, PerfMetricSummary, PerfSummary } from "@codezal/contracts";

/**
 * PRD 11 başarı ölçütlerinin yerel ölçümü. Telemetri değildir: örnekler yalnız main sürecin
 * belleğinde halka tamponda durur, açılış ölçüleri ayrıca günlüğe bir satır düşer (oturumlar
 * arası geçmiş oradan okunur). Ağ yok, dosya yok.
 */

/** PRD 11: "araç çağrısının ekranda görünme gecikmesi 100 ms altında", "açılış 1,5 sn'den kısa". */
export const PERF_TARGETS: Readonly<Record<PerfMetric, number>> = {
  windowReady: 1500,
  firstRender: 1500,
  toolCard: 100,
};

/** Tampon boyları: açılış süreç başına bir kez ölçülür; araç kartı sık, son 200 yeter. */
const CAPACITY: Readonly<Record<PerfMetric, number>> = {
  windowReady: 20,
  firstRender: 20,
  toolCard: 200,
};

const METRICS: readonly PerfMetric[] = ["windowReady", "firstRender", "toolCard"];

/**
 * En yakın sıra yöntemiyle yüzdelik (enterpolasyon yok): sonuç her zaman gerçek bir örnektir,
 * az örnekte p95 en kötü ölçüye denk gelir ve hedefi yumuşatmaz.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1] ?? null;
}

/** Tek metriğin özeti; hedef "altında" ifadesi gereği karşılaştırma katıdır (p95 < hedef). */
export function summarizeMetric(
  metric: PerfMetric,
  samples: readonly number[],
  target = PERF_TARGETS[metric],
): PerfMetricSummary {
  const p95 = percentile(samples, 95);
  return {
    metric,
    target,
    count: samples.length,
    p50: percentile(samples, 50),
    p95,
    last: samples.at(-1) ?? null,
    pass: p95 === null ? null : p95 < target,
  };
}

export type PerfListener = (metric: PerfMetric, ms: number) => void;

export class PerfRecorder {
  #processStart: number;
  #samples = new Map<PerfMetric, number[]>();
  #firstRender = false;
  #listener: PerfListener | undefined;

  constructor(processStart: number) {
    this.#processStart = processStart;
  }

  get processStart(): number {
    return this.#processStart;
  }

  /**
   * İşletim sisteminin bildirdiği gerçek süreç başlangıcı (Electron hazır olunca bilinir). Yalnız
   * mevcut tahminden önceki ve bir dakikayı aşmayan düzeltme kabul edilir: platformun tuhaf bir
   * değeri (0, başka birim) açılışı saatlerce gösteremesin.
   */
  setProcessStart(at: number): void {
    const shift = this.#processStart - at;
    if (Number.isFinite(at) && at > 0 && shift >= 0 && shift < 60_000) this.#processStart = at;
  }

  /** Yeni örnek dinleyicisi (günlük satırı için); tek dinleyici yeter. */
  onSample(listener: PerfListener | undefined): void {
    this.#listener = listener;
  }

  record(metric: PerfMetric, ms: number): void {
    // Saat geri alınması ya da bozuk girdi: negatif/sonsuz süre ortalamayı zehirlemesin.
    if (!Number.isFinite(ms) || ms < 0) return;
    const buffer = this.#samples.get(metric) ?? [];
    buffer.push(ms);
    if (buffer.length > CAPACITY[metric]) buffer.splice(0, buffer.length - CAPACITY[metric]);
    this.#samples.set(metric, buffer);
    this.#listener?.(metric, ms);
  }

  /** Süreç başlangıcından `at` anına (duvar saati, ms) geçen süreyi kaydeder. */
  recordSinceStart(metric: PerfMetric, at: number): void {
    this.record(metric, at - this.#processStart);
  }

  /**
   * İlk boyama süreç başına bir kez sayılır: renderer yeniden yüklenince (geliştirmede ⌘R)
   * süreç başlangıcından dakikalar sonra gelen bildirim sahte bir açılış örneği olurdu.
   */
  recordFirstRender(at: number): boolean {
    if (this.#firstRender) return false;
    this.#firstRender = true;
    this.recordSinceStart("firstRender", at);
    return true;
  }

  samples(metric: PerfMetric): readonly number[] {
    return this.#samples.get(metric) ?? [];
  }

  summary(packaged: boolean): PerfSummary {
    return {
      packaged,
      metrics: METRICS.map((metric) => summarizeMetric(metric, this.samples(metric))),
    };
  }
}

/**
 * Süreç geneli kaydedici. Başlangıç önce Node'un süreç başlangıcıyla kurulur; uygulama hazır
 * olunca `app.getAppMetrics()`teki gerçek oluşturulma anıyla düzeltilir.
 */
export const perf = new PerfRecorder(performance.timeOrigin);
