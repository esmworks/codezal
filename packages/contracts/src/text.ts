/**
 * Oturum başlığı türetimi. Main (oturum listesi) ve renderer (iyimser başlık) aynı kuralı
 * kullanmak zorunda olduğundan tek yerde durur: ilk anlamlı satır, sadeleştirilmiş boşluk,
 * kelime sınırında kısaltma. Yapıştırılan günlüklerde başlık satırlar arasında bölünmesin.
 */

/** Başlıkta gösterilecek en çok karakter. */
export const SESSION_TITLE_MAX = 80;

/** Kısayol komutunun talimat bloğu: `<codezal-command name="plan">talimat</codezal-command>`. */
export const PROMPT_COMMAND_TAG = "codezal-command";
/** `@dosya` bahislerinin okuma listesi; mesajın sonuna eklenir. */
export const PROMPT_FILES_TAG = "codezal-files";
/**
 * Sohbetten "Yanıtla" ile alınan alıntılar. Mesajın sonuna (okuma listesinden önce) eklenir:
 * başa konsaydı baştaki `/plan` ya da `/skill:ad` komutu tanınmazdı. Blok bir açıklama satırı
 * ve `> ` önekli alıntılardan oluşur; alıntılar boş satırla ayrılır.
 */
export const PROMPT_QUOTE_TAG = "codezal-quote";

const FILES_BLOCK = new RegExp(`\\s*<${PROMPT_FILES_TAG}>[\\s\\S]*?</${PROMPT_FILES_TAG}>\\s*$`);
const QUOTE_BLOCK = new RegExp(`\\s*<${PROMPT_QUOTE_TAG}>([\\s\\S]*?)</${PROMPT_QUOTE_TAG}>\\s*$`);
const COMMAND_BLOCK = new RegExp(
  `^\\s*<${PROMPT_COMMAND_TAG} name="([^"]+)">[\\s\\S]*?</${PROMPT_COMMAND_TAG}>`,
);
/** Pi `/skill:ad` çağrısını bu bloğa açar (beceri gövdesi + konum). */
const SKILL_BLOCK = /^\s*<skill name="([^"]+)" location="[^"]*">[\s\S]*?\n<\/skill>/;

function joinHead(head: string, rest: string): string {
  const body = rest.trim();
  return body ? `${head} ${body}` : head;
}

/**
 * Gönderimde eklenen blokları kullanıcının yazdığı biçime döndürür: komut talimatı `/plan`,
 * Pi beceri bloğu `/skill:ad` olur, okuma listesi düşer (bahisler metinde zaten durur).
 * Alıntı bloğu da düşer; balon alıntıları `promptQuotes` ile ayrıca çizer.
 * Başlık, balon ve kopyala aynı çözümü kullanır; blok yoksa metin olduğu gibi döner.
 */
export function collapsePromptMarkup(text: string): string {
  const body = text.replace(FILES_BLOCK, "").replace(QUOTE_BLOCK, "");
  const command = COMMAND_BLOCK.exec(body);
  if (command) return joinHead(`/${command[1] ?? ""}`, body.slice(command[0].length));
  const skill = SKILL_BLOCK.exec(body);
  if (skill) return joinHead(`/skill:${skill[1] ?? ""}`, body.slice(skill[0].length));
  return body;
}

/** Alıntı bloğu: açıklama satırı + `> ` önekli alıntılar. Alıntı yoksa boş metin. */
export function quoteBlock(quotes: readonly string[], head: string): string {
  const items = quotes.map((q) => q.trim()).filter(Boolean);
  if (items.length === 0) return "";
  const body = items
    .map((q) =>
      q
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n"),
    )
    .join("\n\n");
  return `<${PROMPT_QUOTE_TAG}>\n${head}\n\n${body}\n</${PROMPT_QUOTE_TAG}>`;
}

/** Gönderilen metindeki alıntılar, yazıldıkları sırayla; blok yoksa boş dizi. */
export function promptQuotes(text: string): string[] {
  const match = QUOTE_BLOCK.exec(text.replace(FILES_BLOCK, ""));
  if (!match) return [];
  const quotes: string[] = [];
  let current: string[] | null = null;
  for (const line of (match[1] ?? "").split("\n")) {
    if (line.startsWith(">")) {
      current ??= [];
      current.push(line.replace(/^> ?/, ""));
      continue;
    }
    // Önek taşımayan satır (açıklama ya da ayırıcı boş satır) alıntıyı kapatır.
    if (current) quotes.push(current.join("\n").trim());
    current = null;
  }
  if (current) quotes.push(current.join("\n").trim());
  return quotes.filter(Boolean);
}

/** Metinden alıntı bloğunu söker (okuma listesi yerinde kalır). */
export function stripPromptQuotes(text: string): string {
  return text.replace(QUOTE_BLOCK, "");
}

/**
 * İlk boş olmayan satırı başlığa çevirir; metin boşsa `fallback` döner. Gönderim blokları önce
 * çözülür: başlık talimat metni ya da `<codezal-command>` etiketi değil, yazılan istek olsun.
 */
export function deriveSessionTitle(firstMessage: string, fallback: string): string {
  const line = collapsePromptMarkup(firstMessage)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!line) return fallback;
  // Uzunluk **kod noktası** sayılır: vekil çiftleri (emoji) UTF-16 uzunluğuyla ölçülünce
  // başlık ikiye bölünüyor ve sonunda yarım karakter ("�") kalıyordu.
  const points = Array.from(line);
  if (points.length <= SESSION_TITLE_MAX) return line;
  const cut = points.slice(0, SESSION_TITLE_MAX).join("");
  const space = cut.lastIndexOf(" ");
  // Tek uzun kelimede (yol, jeton) boşluk aranmaz; kelimenin yarısını kesmek yerine sert kes.
  return `${(space > SESSION_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Model referansının kararlı etiketi ("sağlayıcı/kimlik"). Komut işaretleri bu etiketi saklar:
 * kayıt dile ve katalog sürümüne bağlı kalmaz, gösterilecek ad renderer'da katalogdan bulunur.
 */
export function modelLabel(ref: { provider: string; id: string }): string {
  return `${ref.provider}/${ref.id}`;
}

/** Etiketi geri çözer; ayraç yoksa ya da kenarda kalırsa `null` (bozuk/eski kayıt). */
export function parseModelLabel(label: string): { provider: string; id: string } | null {
  const at = label.indexOf("/");
  if (at <= 0 || at === label.length - 1) return null;
  return { provider: label.slice(0, at), id: label.slice(at + 1) };
}

/** Üretilen başlıkta izin verilen en çok karakter; kenar çubuğunda tek satıra sığsın. */
export const GENERATED_TITLE_MAX = 60;

/**
 * Modelin döndürdüğü başlığı temizler: ilk dolu satır, baştaki "Başlık:" etiketi, sarmalayan
 * tırnak/yıldız/kod işaretleri ve sondaki nokta düşer. Boş ya da aşırı uzun (model talimatı
 * yok sayıp paragraf yazdıysa) sonuç `undefined` döner; çağıran eldeki başlığı korur.
 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("```"));
  if (!line) return undefined;
  const title = line
    .replace(/^(başlık|title)\s*:\s*/i, "")
    .replace(/^[#>*_`"'“”‘’«»\s-]+|[*_`"'“”‘’«»\s]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || Array.from(title).length > GENERATED_TITLE_MAX) return undefined;
  return title;
}
