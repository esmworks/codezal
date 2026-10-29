/**
 * Kota yanıtlarını defansif okumak için yardımcılar. Kota uçlarının bir kısmı belgelenmemiş
 * (CommandCode `/alpha/*`) ya da alan adları zamanla değişebiliyor; bu yüzden eksik ya da yanlış
 * tipteki alan `undefined` döner ve 0 gibi görünmez. Adaptörler zorunlu alanı bulamazsa
 * `QuotaError("schema")` fırlatır.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Sayı ya da sayı metni ("110.00"); diğer her şey `undefined`. */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Epoch ms, epoch saniye ya da ISO metnini epoch ms'e çevirir. */
export function epochMs(value: unknown): number | undefined {
  const direct = num(value);
  if (direct !== undefined) return direct < 1e12 ? Math.round(direct * 1000) : Math.round(direct);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `Promise.allSettled` sonucundan yalnız başarılı değeri alır; hata sessizce düşer. */
export function settledValue(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "fulfilled" ? result.value : undefined;
}
