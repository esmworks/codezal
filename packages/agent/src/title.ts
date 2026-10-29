import { collapsePromptMarkup } from "@codezal/contracts";

/** Başlık isteminde her mesajdan alınan en çok karakter (maliyet sınırı). */
export const TITLE_INPUT_MAX = 1500;
/** İlk mesajın yanında gönderilen son kullanıcı mesajı sayısı (yeniden üretimde konu kayabilir). */
export const TITLE_RECENT_TURNS = 3;

/**
 * Başlık isteminin gövdesi: ilk kullanıcı mesajı, son birkaç mesaj ve son yanıt. İlk üretimde
 * yalnız ilk mesaj ve ilk yanıt vardır; elle yeniden üretimde konu değişmiş olabileceği için son
 * mesajlar da girer. Boş metinler atılır, her parça kısaltılır. Kullanıcı mesajı yoksa undefined.
 */
export function titlePrompt(
  userTexts: readonly string[],
  reply: string,
  labels: { user: string; reply: string },
): string | undefined {
  const asks = userTexts.map((text) => collapsePromptMarkup(text).trim()).filter(Boolean);
  if (asks.length === 0) return undefined;
  const picked = [
    ...new Set([asks[0] ?? "", ...asks.slice(1).slice(-TITLE_RECENT_TURNS)].filter(Boolean)),
  ];
  const lastReply = reply.trim();
  return [
    labels.user,
    ...picked.map((text) => `- ${text.slice(0, TITLE_INPUT_MAX)}`),
    ...(lastReply ? ["", labels.reply, lastReply.slice(0, TITLE_INPUT_MAX)] : []),
  ].join("\n");
}
