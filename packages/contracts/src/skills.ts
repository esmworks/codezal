import { z } from "zod";

/**
 * Beceriler: Pi'nin kaynak sistemi (Agent Skills standardı `SKILL.md`). Renderer yalnızca bu özet
 * biçimini görür; dosya içerikleri main tarafında kalır. Prompt şablonları ve npm/git paketleri
 * kaldırıldı: paketler Pi yükleyicisinde sormadan kuruluyor, şablonlar da o paketlerden geliyordu.
 */
export const ResourceScope = z.enum(["user", "project", "temporary"]);
export type ResourceScope = z.infer<typeof ResourceScope>;

export const SkillInfo = z.object({
  /** `/skill:name` komutunun adı. */
  name: z.string(),
  description: z.string(),
  /** SKILL.md (ya da tek dosyalık beceri) tam yolu. */
  path: z.string(),
  /** Beceri klasörü; göreli yollar buna göre çözülür. */
  baseDir: z.string(),
  scope: ResourceScope,
  /** Kaynak etiketi: "auto", "local" vb. */
  source: z.string(),
  enabled: z.boolean(),
  /** `disable-model-invocation`: sistem istemine girmez, yalnızca `/skill:name` ile çağrılır. */
  hidden: z.boolean(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

export const ResourceDiagnostic = z.object({
  level: z.enum(["warning", "error"]),
  message: z.string(),
  path: z.string(),
});
export type ResourceDiagnostic = z.infer<typeof ResourceDiagnostic>;

export const SkillCatalog = z.object({
  skills: z.array(SkillInfo),
  /** Ayarlardaki kaynak klasörler (desen olmayan `skills` girdileri). */
  sources: z.array(z.string()),
  diagnostics: z.array(ResourceDiagnostic),
  /** Codezal'ın kendi beceri klasörü (`agentDir/skills`). */
  ownSkillsDir: z.string(),
});
export type SkillCatalog = z.infer<typeof SkillCatalog>;
