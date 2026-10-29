import { z } from "zod";
import { Usage, WorkerStatus } from "./events.js";

/**
 * Ayrık ajan koşusu (`agent` aracının `background` / `isolation: "worktree"` kipi). Bekletilen
 * alt ajan bellekte çalışır ve ana tura yalnız özet döner; ayrık koşu ise tam bir oturumdur:
 * kendi transkripti, izin kapısı ve maliyet sayacı vardır, worktree kipinde değişikliği kullanıcı
 * inceleyip ana dala uygular. Durum enum'ları olaylarda da taşındığı için `events.ts` içindedir.
 */

/** Tek koşunun görünür durumu; Ajanlar kutusu ve paneli bununla çizilir. */
export const WorkerInfo = z.object({
  id: z.string(),
  /** Koşuyu başlatan oturum; koşu yalnız bu oturumun Ajanlar kutusunda görünür. */
  parentSessionId: z.string(),
  /** Kök klasör: yalıtımsız koşu burada çalışır, worktree bundan açılır ve buraya uygulanır. */
  cwd: z.string(),
  /** Çalışan ajan tanımının adı (`general`, `explore` ya da kullanıcı ajanı). */
  agent: z.string(),
  /** Kısa ad; satırda görünür (modelin `description`'ı ya da görevin ilk satırı). */
  title: z.string(),
  /** Modelin verdiği görev metni. */
  task: z.string(),
  status: WorkerStatus,
  /** Koşu kendi git worktree'sinde mi; değilse ana oturumun klasöründe çalışır. */
  isolated: z.boolean().default(false),
  /** Ana tur beklemeden sürdü mü; bitince ana oturum dürtülür. */
  background: z.boolean().default(false),
  /** Worktree klasörü; yalıtımsız koşuda boş. */
  worktree: z.string(),
  /** Koşunun oturumu; kurulana kadar null (izin/soru yanıtı bu kimlikle eşleşir). */
  sessionId: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** Canlı alt satır: son eylem. */
  activity: z.string().optional(),
  /** Koşunun modeli (`sağlayıcı/kimlik`) ve düşünme düzeyi; oturum açılınca dolar. */
  model: z.string().optional(),
  thinking: z.string().optional(),
  /** Adım sayacı: koşunun çalıştırdığı araç sayısı (ikisi aynı; toplam önceden bilinmez). */
  stepsDone: z.number().int().nonnegative().default(0),
  stepsTotal: z.number().int().nonnegative().default(0),
  /** Değişen dosya sayısı; worktree koşusunda bitişte hesaplanır. */
  filesChanged: z.number().int().nonnegative().optional(),
  /** Koşunun kendi token/maliyet tüketimi. */
  usage: Usage.optional(),
  /** Bitiş özeti (ana oturuma dönen sonuç); çalışan koşuda yok. */
  result: z.string().optional(),
  /** Koşu hatası; çalışan koşuda null. */
  error: z.string().nullable().default(null),
});
export type WorkerInfo = z.infer<typeof WorkerInfo>;

/** Worktree koşusu inceleme kararı: ana dala uygula ya da worktree'yi sil. */
export const WorkerReviewDecision = z.enum(["apply", "discard"]);
export type WorkerReviewDecision = z.infer<typeof WorkerReviewDecision>;
