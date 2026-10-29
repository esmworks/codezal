import type { SessionSummary } from "@codezal/contracts";

const DAY_MS = 86_400_000;

/**
 * Arşive uygun oturumlar: son değişikliğin üstünden `days` gün geçmiş, sabitlenmemiş, çalışmayan
 * ve zaten arşivde olmayanlar. Saf işlev; zamanlayıcı yalnızca dönen kimlikleri arşivler.
 */
export function expiredSessions(
  sessions: readonly SessionSummary[],
  days: number,
  now: number,
): string[] {
  const cutoff = now - days * DAY_MS;
  return sessions
    .filter((s) => !s.archived && !s.pinned && !s.live && s.modifiedAt < cutoff)
    .map((s) => s.id);
}
