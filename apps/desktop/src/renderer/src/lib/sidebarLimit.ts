import type { SessionSummary } from "@codezal/contracts";

/**
 * Kenar çubuğunda grup başına varsayılan görünür sohbet sayısı. Yüzlerce sohbet barındıran
 * projelerde liste sonsuza uzamasın diye kalanı "göster" satırının arkasında katlanır.
 */
export const SESSION_LIMIT = 5;

/**
 * Görünecek sohbetleri ve katlananların sayısını döner. Açık (aktif) sohbet dilimin dışında
 * kalsa bile listeye eklenir: kullanıcı üzerinde çalıştığı satırı kenar çubuğunda da görsün.
 */
export function visibleSessions(
  items: SessionSummary[],
  expanded: boolean,
  activeSessionId: string | null,
): { visible: SessionSummary[]; hidden: number } {
  if (expanded || items.length <= SESSION_LIMIT) return { visible: items, hidden: 0 };
  const head = items.slice(0, SESSION_LIMIT);
  const active = activeSessionId ? items.find((s) => s.id === activeSessionId) : undefined;
  const visible = active && !head.includes(active) ? [...head, active] : head;
  return { visible, hidden: items.length - visible.length };
}

/**
 * "N sohbet daha göster" / "Gizle" satırı görünsün mü? Katlanmışken yalnızca gerçekten gizli
 * sohbet kaldıysa; açıkken liste sınırı aştığı için yeniden gizlenebilir durumdaysa. Aksi
 * hâlde açık sohbet dilim dışından gelip her şey görünürken "0 sohbet daha göster" çıkardı.
 */
export function sessionToggleVisible(expanded: boolean, total: number, hidden: number): boolean {
  return expanded ? total > SESSION_LIMIT : hidden > 0;
}
