import { z } from "zod";

/**
 * Kullanıcı hook'ları (Claude Code'un PreToolUse / PostToolUse kancalarının karşılığı). Kaynaklar:
 * `userData/hooks.json` (genel) ve güvenilen projede `.codezal/ayarlar.json` +
 * `ayarlar.local.json` içindeki `hooks` alanı. Komut kullanıcının kabuğunda, oturumun çalışma
 * klasöründe koşar; stdin'e çağrının JSON'u yazılır.
 */
export const HookEvent = z.enum(["PreToolUse", "PostToolUse"]);
export type HookEvent = z.infer<typeof HookEvent>;

export const HookEntry = z.object({
  /** Araç adı için düzenli ifade (tam eşleşme); boş ya da `*` tüm araçlar demektir. */
  matcher: z.string().default(""),
  command: z.string().trim().min(1),
  /** Saniye; verilmezse 30. Süre dolarsa çağrı engellenmez, uyarı günlüğe düşer. */
  timeoutSec: z.number().positive().max(600).optional(),
});
export type HookEntry = z.infer<typeof HookEntry>;

export const HooksConfig = z.object({
  PreToolUse: z.array(HookEntry).optional(),
  PostToolUse: z.array(HookEntry).optional(),
});
export type HooksConfig = z.infer<typeof HooksConfig>;

/** Çözülmüş hook: olayı ve geldiği dosyayla (Ayarlar'daki liste ve günlük bunu gösterir). */
export const ResolvedHook = HookEntry.extend({
  event: HookEvent,
  /** Hook'un okunduğu dosyanın tam yolu. */
  source: z.string(),
});
export type ResolvedHook = z.infer<typeof ResolvedHook>;
