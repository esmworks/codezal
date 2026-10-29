import { z } from "zod";

/** electron-updater durumu; Ayarlar > Hesap ve sağ alttaki güncelleme kartı bu durumu gösterir. */
export const UpdateStatus = z.object({
  state: z.enum(["disabled", "idle", "checking", "available", "downloading", "ready", "error"]),
  /** Bulunan ya da indirilen sürüm; yeni sürüm yokken çalışan sürümü taşır. */
  version: z.string().optional(),
  /** Çalışan uygulamanın sürümü; kartta "eski → yeni" karşılaştırması için. */
  currentVersion: z.string().optional(),
  /** İndirme yüzdesi (0-100). */
  percent: z.number().min(0).max(100).optional(),
  /** İndirilen bayt. */
  transferred: z.number().optional(),
  /** Toplam bayt; sağlayıcı vermezse 0 olabilir (belirsiz ilerleme). */
  total: z.number().optional(),
  /** Sağlayıcının verdiği sürüm notları; generic sağlayıcıda genellikle boştur. */
  releaseNotes: z.string().optional(),
  message: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;
