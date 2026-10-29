import type { ProjectRef } from "@codezal/contracts";

/** Klasör seçimi kullanan tek bölüm Kodlama; Asistan kendi projelerini kullanır. */
export type FolderMode = "kodlama";
/** Bölüm başına kayıtlı yol. Alan yoksa hiç seçim yapılmamış, `null` ise kullanıcı kaldırmış. */
export type Selection = Partial<Record<FolderMode, string | null>>;

export const folderMode = (): FolderMode => "kodlama";

/**
 * Bölümün açılıştaki seçimi. Kayıtlı yol listede varsa o; kullanıcı seçimi kaldırdıysa (`null`)
 * hiçbiri; hiç seçim yapılmamışsa en son klasör açılır.
 */
export function resolveSelection(
  recent: ProjectRef[],
  stored: Selection,
  mode: FolderMode,
): ProjectRef | null {
  if (mode in stored) {
    const path = stored[mode];
    return path ? (recent.find((p) => p.path === path) ?? null) : null;
  }
  return recent[0] ?? null;
}
