/**
 * Oturum ek sistem istemlerini birleştirir: create çağrısının ekleri (seçim, tür kuralı) ve
 * mode ekleri (asistan talimatları, önizleme sunucusu). Öncelik ezmesi yok:
 * boş/yalnız boşluk girişler elenir, hepsi boşsa undefined döner.
 */
export function mergeExtraSystem(...parts: (string | undefined)[]): string | undefined {
  const merged = parts
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
  return merged || undefined;
}
