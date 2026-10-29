import type { PerfRecordRequest } from "@codezal/contracts";
import { invoke } from "../api";

/**
 * PRD 11 ölçümlerinin renderer yarısı: ilk anlamlı boyama ve araç kartı gecikmesi. Sonuçlar
 * main'e (`perf:record`) gider ve orada kalır; hiçbir yere gönderilmez.
 */

/** Görünmeyen (sanal pencere dışı, katlanmış) satırın bekleyen kaydı bu süreden sonra düşer. */
const PENDING_TTL_MS = 30_000;
/** Bekleyen kayıt üst sınırı: bellek, kart hiç çizilmese de büyümesin. */
const PENDING_LIMIT = 64;

type Report = (req: PerfRecordRequest) => void;

const send: Report = (req) => void invoke("perf:record", req).catch(() => undefined);

/**
 * Araç olayının main'de üretildiği an (`event.at`) ile satırın ilk çizildiği an arasını ölçer.
 * Olay geldiğinde beklenen kimlik kaydedilir, kart ya da grup satırı çizilince süre bildirilir;
 * aynı kimlik ikinci kez sayılmaz.
 */
export class ToolLatencyTracker {
  #pending = new Map<string, number>();
  #report: Report;

  constructor(report: Report = send) {
    this.#report = report;
  }

  expect(id: string, at: number, now = Date.now()): void {
    for (const [key, since] of this.#pending)
      if (now - since > PENDING_TTL_MS) this.#pending.delete(key);
    if (this.#pending.size >= PENDING_LIMIT) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(id, at);
  }

  rendered(id: string, now = Date.now()): void {
    const at = this.#pending.get(id);
    if (at === undefined) return;
    this.#pending.delete(id);
    if (now - at > PENDING_TTL_MS) return;
    this.#report({ metric: "toolCard", ms: Math.max(0, now - at) });
  }

  get size(): number {
    return this.#pending.size;
  }
}

export const toolLatency = new ToolLatencyTracker();

let firstRenderSent = false;

/**
 * İlk anlamlı boyama: kenar çubuğu listeleri yüklendikten sonraki ilk kare. Süreç başına bir
 * kez; StrictMode'un çift efekti ve yeniden denemeler ikinci örnek üretmesin.
 */
export function reportFirstRender(report: Report = send): void {
  // DOM'suz ortamda (birim testi) boyama yok; ölçülecek bir şey de yok.
  if (firstRenderSent || typeof requestAnimationFrame !== "function") return;
  firstRenderSent = true;
  // rAF karenin boyamasından hemen önce çalışır; içindeki zamanlayıcı boyama bittikten sonra.
  requestAnimationFrame(() => {
    setTimeout(() => report({ metric: "firstRender", at: Date.now() }), 0);
  });
}
