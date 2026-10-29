/**
 * Kenar çubuğunda çoklu seçim. Burada yalnızca işaretli satır anahtarları tutulur; neyin silineceği
 * çağıranın işi. Sıra listedeki görünen sıradır: Shift aralığı buna göre hesaplanır.
 */
export interface MarkState {
  /** İşaretli satır anahtarları, listedeki sırayla. */
  keys: string[];
  /** Shift aralığının başladığı satır; satır listeden düşünce boşalır. */
  anchor: string | null;
}

export interface MarkMods {
  /** Cmd/Ctrl: tek satırı ekler ya da çıkarır. */
  toggle: boolean;
  /** Shift: çapadan tıklanan satıra kadarki aralığı seçer. */
  range: boolean;
}

export const noMarks: MarkState = { keys: [], anchor: null };

/** Anahtarları listedeki sıraya dizer; listede olmayanları atar. */
function inOrder(order: string[], keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  return order.filter((k) => wanted.has(k));
}

/**
 * Satır tıklaması. Shift çapadan tıklanana kadarki aralığı seçer (öncekilerin yerine geçer); Cmd/Ctrl
 * ve seçim kipindeki sade tıklama tek satırı ekler-çıkarır. Çapa her tıklamada tıklanan satıra kayar
 * ki art arda Shift ile aralık büyütülebilsin.
 */
export function markClick(
  state: MarkState,
  order: string[],
  key: string,
  mods: MarkMods,
): MarkState {
  if (!order.includes(key)) return state;
  if (mods.range) {
    const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : key;
    const a = order.indexOf(anchor);
    const b = order.indexOf(key);
    const [from, to] = a <= b ? [a, b] : [b, a];
    return { keys: order.slice(from, to + 1), anchor };
  }
  const marked = state.keys.includes(key);
  const keys = inOrder(order, marked ? state.keys.filter((k) => k !== key) : [...state.keys, key]);
  return { keys, anchor: key };
}

/** Listeden düşen (silinen ya da bölüm değişince kaybolan) satırların işaretini bırakır. */
export function pruneMarks(state: MarkState, order: string[]): MarkState {
  const keys = inOrder(order, state.keys);
  const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : null;
  const same =
    anchor === state.anchor &&
    keys.length === state.keys.length &&
    keys.every((k, i) => k === state.keys[i]);
  // Değişmediyse aynı nesne döner: durum tazelenmez, budayan effect döngüye girmez.
  return same ? state : { keys, anchor };
}
