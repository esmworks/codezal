import { z } from "zod";

/** Günlük seviyeleri. `debug` yalnızca ayrıntılı günlük açıkken yazılır (ayrı dosyaya). */
export const LogLevel = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

/** Tanılama görüntüleyicisinin gördüğü tek satır: halka tampon ve canlı akış aynı şekli paylaşır. */
export const LogLine = z.object({
  /** Unix milisaniye; görüntüleyici yerel saate çevirir. */
  at: z.number(),
  level: LogLevel,
  scope: z.string(),
  message: z.string(),
});
export type LogLine = z.infer<typeof LogLine>;

/** `app:logTail` isteği: seviye verilmezse tüm seviyeler; üst sınır main tarafında uygulanır. */
export const LogTailRequest = z.object({
  lines: z.number().int().positive().max(2000).optional(),
  level: LogLevel.optional(),
});
export type LogTailRequest = z.infer<typeof LogTailRequest>;

export const LogTailResponse = z.object({ lines: z.array(LogLine) });
export type LogTailResponse = z.infer<typeof LogTailResponse>;

/**
 * PRD 11 başarı ölçütlerinin yerel ölçümleri. Veriler yalnız main sürecin belleğinde (ve günlük
 * satırında) durur; hiçbir yere gönderilmez.
 * - `windowReady`: süreç başlangıcı → ana pencere `ready-to-show`.
 * - `firstRender`: süreç başlangıcı → renderer'ın ilk anlamlı boyaması (kenar çubuğu listeleri yüklü).
 * - `toolCard`: main'de araç olayının üretimi → renderer'da kartın (ya da grup satırının) çizilmesi.
 */
export const PerfMetric = z.enum(["windowReady", "firstRender", "toolCard"]);
export type PerfMetric = z.infer<typeof PerfMetric>;

/**
 * Renderer'ın bildirdiği ölçüm. İlk boyama duvar saati anıyla gelir (süreç başlangıcını main
 * bilir); araç kartı gecikmesi renderer'da hesaplanmış süre olarak gelir.
 */
export const PerfRecordRequest = z.discriminatedUnion("metric", [
  z.object({ metric: z.literal("firstRender"), at: z.number() }),
  z.object({ metric: z.literal("toolCard"), ms: z.number().nonnegative().max(600_000) }),
]);
export type PerfRecordRequest = z.infer<typeof PerfRecordRequest>;

export const PerfMetricSummary = z.object({
  metric: PerfMetric,
  /** PRD hedefi (ms); ölçüm bu değerin **altında** kalmalı. */
  target: z.number(),
  count: z.number().int().nonnegative(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  last: z.number().nullable(),
  /** p95 hedefin altındaysa true; ölçüm yoksa null (karar verilmez). */
  pass: z.boolean().nullable(),
});
export type PerfMetricSummary = z.infer<typeof PerfMetricSummary>;

export const PerfSummary = z.object({
  /** Paketlenmemiş sürümün ölçümü yayın sürümünü temsil etmez; arayüz bunu not düşer. */
  packaged: z.boolean(),
  metrics: z.array(PerfMetricSummary),
});
export type PerfSummary = z.infer<typeof PerfSummary>;
