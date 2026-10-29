import type { SkillCatalog } from "@codezal/contracts";
import { mentionText } from "./promptText";
import type { SlashSuggestion } from "./slashSearch";

/** Seçilen dosya yollarını taslağa `@yol` olarak ekler. */
export function withMentions(draft: string, paths: string[]): string {
  const tokens = paths.map(mentionText).join(" ");
  const base = draft.replace(/@\s*$/, "").trimEnd();
  return base ? `${base} ${tokens} ` : `${tokens} `;
}

/**
 * Katalogdaki açık beceriler `/` paneli satırlarına çevrilir. Satır ZCode'daki gibi yalnız adını
 * gösterir (`/skill:` öneki panelde ve etikette gürültüydü); gönderilen metin Pi'nin anladığı
 * `/skill:ad` biçimidir.
 */
export function skillSuggestions(catalog: SkillCatalog | null): SlashSuggestion[] {
  if (!catalog) return [];
  return catalog.skills
    .filter((s) => s.enabled)
    .map<SlashSuggestion>((s) => ({
      id: `skill:${s.name}`,
      kind: "skill",
      value: `/skill:${s.name}`,
      label: s.name,
      description: s.description,
      keywords: ["skill"],
      icon: "sparkle",
      runOnPick: false,
    }));
}
