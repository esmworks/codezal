/**
 * Görünen (filtrelenmiş) sırayla yapılan fare taşımasını tam listeye uygular.
 *
 * Kenar çubuğunda bir moda ait oturumu olmayan klasörler listede gizli kalır; manuel sıra ise
 * tüm kayıtlı klasörleri kapsar. Bu yüzden görünen öğeler yeniden dizilirken görünmeyenler
 * göreli konumlarını korur: kaydın kendisi bozulmaz, yalnız görünenlerin yerleşimi değişir.
 *
 * `from` ya da `toIndex` geçersizse liste değişmeden döner.
 */
export function applyReorder(
  all: string[],
  visible: string[],
  from: string,
  toIndex: number,
): string[] {
  // Görünen listede olup kayıtta bulunmayan öğe sıraya girmez; yoksa indeksler kayar.
  const vis = visible.filter((k) => all.includes(k));
  const fromIndex = vis.indexOf(from);
  if (fromIndex < 0) return all;
  const rest = vis.filter((k) => k !== from);
  const target = Math.max(0, Math.min(rest.length, toIndex));
  // Sıra değişmiyor: hedef, öğenin çıkarılmasından sonraki kendi konumu.
  if (target === fromIndex) return all;
  const nextVisible = [...rest.slice(0, target), from, ...rest.slice(target)];

  const slots: number[] = [];
  for (const [i, key] of all.entries()) if (vis.includes(key)) slots.push(i);
  const next = [...all];
  slots.forEach((slot, i) => {
    const key = nextVisible[i];
    if (key !== undefined) next[slot] = key;
  });
  return next;
}

/** İmleç satırın alt yarısındaysa öğe hedefin arkasına bırakılır. */
export function dropAfter(rect: { top: number; height: number }, clientY: number): boolean {
  return clientY > rect.top + rect.height / 2;
}

/**
 * Bırakma konumunu görünen sıradaki hedef indekse çevirir: hedefin önüne bırakılıyorsa onun
 * indeksi, arkasına bırakılıyorsa bir fazlası. Sürüklenen öğenin kendisi görünen listeden
 * çıkarıldığı için hedef ondan sonraysa indeks bir azalır.
 */
export function dropIndex(visible: string[], from: string, target: string, after: boolean): number {
  const fromIndex = visible.indexOf(from);
  const targetIndex = visible.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0) return -1;
  const base = after ? targetIndex + 1 : targetIndex;
  return base > fromIndex ? base - 1 : base;
}
