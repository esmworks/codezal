/** localStorage sarmalayıcı: tarayıcı depolaması yoksa sessizce varsayılana döner. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Dizi varsayılanı dizi ister; spread edilirse `{0: ...}` nesnesine dönüşüp `.filter` patlar.
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...(parsed as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // depolama kapalı olabilir; sessizce geç
  }
}
