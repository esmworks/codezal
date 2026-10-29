import { z } from "zod";

/**
 * `ctx.ui` köprüsü: motor-içi uzantı fabrikaları (`codezal-*`) Pi'nin arayüz isteklerini bu
 * şemayla gönderir. Kullanıcı eklentisi yüzeyi kaldırıldıktan sonra bu sözleşme yalnız
 * motor-içi kullanım için durur.
 */
export const ExtensionUiRequest = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  kind: z.enum(["confirm", "select", "input"]),
  title: z.string(),
  message: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  placeholder: z.string().nullable(),
});
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequest>;

/** Kullanıcı cevabı: confirm → boolean, select/input → metin; iptalda null (confirm reddedilir). */
export const ExtensionUiValue = z.union([z.string(), z.boolean(), z.null()]);
export type ExtensionUiValue = z.infer<typeof ExtensionUiValue>;
