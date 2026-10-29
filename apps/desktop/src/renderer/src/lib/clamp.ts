/**
 * Uzun metni mesajda katlamak için önizleme üretir. Satır ya da karakter sınırı aşılırsa ilk
 * satırlar önizleme olur; tam metin yalnızca "Tümünü göster" ile açılır. Saf fonksiyon:
 * kırpma kararı testte doğrulanır, çizim `components/Clamp` içinde yapılır.
 */

/** Önizlemede gösterilecek varsayılan satır sayısı. */
export const CLAMP_LINES = 12;

/** Tek uzun satırlık metinler için varsayılan karakter sınırı. */
export const CLAMP_CHARS = 900;

export interface ClampOptions {
  /** Önizlemede gösterilecek en çok satır. */
  lines?: number | undefined;
  /** Önizlemede gösterilecek en çok karakter (tek uzun satır için). */
  chars?: number | undefined;
}

export interface ClampResult {
  /** Katlanmış hâlde gösterilecek metin; kırpılmadıysa metnin kendisi. */
  preview: string;
  /** Önizlemede gösterilmeyen satır sayısı (karakter kırpmasında 0 olabilir). */
  hiddenLines: number;
  /** Metnin toplam satır sayısı (sondaki satır sonu sayılmaz). */
  totalLines: number;
  /** Metin sınırı aşıyor mu; false ise tam metin gösteriliyor. */
  clamped: boolean;
}

export function clampText(text: string, options: ClampOptions = {}): ClampResult {
  const maxLines = options.lines ?? CLAMP_LINES;
  const maxChars = options.chars ?? CLAMP_CHARS;
  // Sondaki satır sonu boş bir satır sayılmasın; "N satır" sayacı bir fazla çıkardı.
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && text.length <= maxChars) {
    return { preview: text, hiddenLines: 0, totalLines, clamped: false };
  }
  let preview = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
  if (preview.endsWith("\n")) preview = preview.slice(0, -1);
  const shownLines = preview.length === 0 ? 0 : preview.split("\n").length;
  return {
    preview,
    hiddenLines: Math.max(0, totalLines - shownLines),
    totalLines,
    clamped: true,
  };
}
