/**
 * Tur çubuğu ipucu balonunun metin özetleri.
 *
 * ZCode paritesi: `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` ile aynı semantik —
 * en çok iki paragraf, paragraf içi boşluklar sadeleşir, sınır aşılırsa `...` ile kısaltılır.
 */

export const PREVIEW_MAX_CHARS = 220;
export const PREVIEW_MAX_PARAGRAPHS = 2;

/** Balonun ikinci satırının durumu: asistan metni var, henüz yok ya da tur sürüyor. */
export type TurnPreviewKind = "text" | "empty" | "running";

interface BuildPreviewTextOptions {
  texts: readonly string[];
  fallback: string;
  maxChars?: number;
  maxParagraphs?: number;
}

export interface AssistantPreviewInput {
  texts: readonly string[];
  running: boolean;
  emptyFallback: string;
  runningFallback: string;
}

export interface AssistantPreview {
  assistantPreview: string;
  assistantPreviewKind: TurnPreviewKind;
}

/** Paragrafları böler, iç boşlukları tek boşluğa indirir ve ilk `maxParagraphs` paragrafı döner. */
export function normalizePreviewParagraphs(
  text: string,
  maxParagraphs = PREVIEW_MAX_PARAGRAPHS,
): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
}

/** Sınırı aşan metni `...` ile kısaltır; en az 8 karakterlik sınır korunur. */
export function truncatePreview(text: string, maxChars = PREVIEW_MAX_CHARS): string {
  const limit = Math.max(8, maxChars);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

/** Metinleri özetler; hiç metin kalmazsa `fallback` döner. */
export function buildPreviewText({
  texts,
  fallback,
  maxChars = PREVIEW_MAX_CHARS,
  maxParagraphs = PREVIEW_MAX_PARAGRAPHS,
}: BuildPreviewTextOptions): string {
  const paragraphs = normalizePreviewParagraphs(texts.join("\n\n"), maxParagraphs);
  if (paragraphs.length === 0) return fallback;
  return truncatePreview(paragraphs.join("\n"), maxChars);
}

/** Turun asistan satırını ve durumunu çözer: metin varsa özet, yoksa sürüyor/boş ikamesi. */
export function resolveAssistantPreview({
  texts,
  running,
  emptyFallback,
  runningFallback,
}: AssistantPreviewInput): AssistantPreview {
  if (texts.some((text) => text.trim().length > 0)) {
    return {
      assistantPreview: buildPreviewText({ texts, fallback: emptyFallback }),
      assistantPreviewKind: "text",
    };
  }
  if (running) {
    return { assistantPreview: runningFallback, assistantPreviewKind: "running" };
  }
  return { assistantPreview: emptyFallback, assistantPreviewKind: "empty" };
}
