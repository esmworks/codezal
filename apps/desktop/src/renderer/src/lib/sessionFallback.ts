import type { SessionSummary } from "@codezal/contracts";
import { worktreeParent } from "./format";

/** Kenar çubuğundaki bölüm anahtarı: sabitlenenler, Asistan projesi ya da Kodlama klasörü. */
function sectionKey(s: SessionSummary): string {
  if (s.pinned) return "pinned";
  if (s.mode === "asistan") return `p:${s.projectId ?? ""}`;
  return `c:${worktreeParent(s.cwd) ?? s.cwd}`;
}

/**
 * Açık sohbet silinince ya da arşivlenince geçilecek sohbet: kenar çubuğunda aynı bölümde hemen
 * altındaki, yoksa üstündeki. Bölümde başka sohbet kalmadıysa null; çağıran ana ekrana döner,
 * başka projeye atlamaz. `list` değişiklikten önceki listedir, `gone` kalkan kimliklerdir.
 */
export function fallbackSession(
  list: SessionSummary[],
  activeId: string,
  gone: ReadonlySet<string>,
): SessionSummary | null {
  const active = list.find((s) => s.id === activeId);
  if (!active) return null;
  const key = sectionKey(active);
  // Sıra kenar çubuğuyla aynı: bölüm içinde son kullanım en üstte.
  const peers = list
    .filter((s) => s.mode === active.mode && !s.archived && sectionKey(s) === key)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const index = peers.indexOf(active);
  const below = peers.slice(index + 1).find((s) => !gone.has(s.id));
  if (below) return below;
  return (
    peers
      .slice(0, index)
      .reverse()
      .find((s) => !gone.has(s.id)) ?? null
  );
}
