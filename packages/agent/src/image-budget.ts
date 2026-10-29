/**
 * Oturumdaki görsellerin toplam base64 bütçesi.
 *
 * Sağlayıcı ağ geçitleri istek gövdesini sınırlar (OpenCode Go'da ölçülen sınır tam 6 MiB) ve
 * oturumdaki bütün görseller her turda yeniden gönderilir. Sınır aşıldığında gelen yanıt
 * açıklamasız bir 400 olduğu için oturum kalıcı olarak kilitleniyordu: yeni mesaj göndermek de
 * işe yaramıyordu, çünkü hata girdideki birikmiş görsellerden kaynaklanıyordu.
 *
 * 4 MiB, geçmişin metin tarafına (araç çıktıları, sistem istemi, konuşma) 2 MiB pay bırakır.
 */
export const SESSION_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Bir istekte kabul edilen en fazla görsel sayısı, sağlayıcıya göre.
 *
 * DeepSeek görüntü API'si isteği 4 görselde keser ("At most 4 image(s) may be provided in one
 * prompt"); geçmişteki görseller de sayıldığı için beşinci görselden sonra oturum kilitleniyordu.
 * Aynı model OpenRouter gibi aracılardan gelince de sınır DeepSeek tarafında uygulanır; bu yüzden
 * sağlayıcı, adres ve model kimliği birlikte bakılır.
 */
const DEEPSEEK_MAX_IMAGES = 4;

/** Sınırın belirlenmesi için modelin gereken kadarı (Pi `Model` tipi bunları taşır). */
export interface ImageLimitModel {
  readonly provider?: string;
  readonly id?: string;
  readonly baseUrl?: string;
}

/** Modelin bir istekte kabul ettiği en fazla görsel; bilinen bir sınır yoksa `undefined`. */
export function maxImagesPerRequest(model: ImageLimitModel | undefined): number | undefined {
  if (!model) return undefined;
  const key = `${model.provider ?? ""} ${model.baseUrl ?? ""} ${model.id ?? ""}`.toLowerCase();
  if (key.includes("deepseek")) return DEEPSEEK_MAX_IMAGES;
  return undefined;
}

/** Pi mesajlarının bu iş için gereken kadarı; içerik dizisi yerinde değiştirilir. */
export interface TrimmableMessage {
  readonly role?: string;
  readonly content?: unknown;
}

export interface ImageLimits {
  /** Görsellerin toplam base64 uzunluğu için üst sınır. */
  readonly bytes: number;
  /** Görsel sayısı için üst sınır; yoksa yalnızca bayt bütçesi uygulanır. */
  readonly count?: number;
}

/** Düşürülen görselin yerine yazılacak metin; sebep yer tutucuyu seçer. */
export type ImagePlaceholder = (reason: "bytes" | "count") => string;

interface ImageBlock {
  type: "image";
  data: string;
}

function isImageBlock(value: unknown): value is ImageBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as { type?: unknown; data?: unknown };
  return block.type === "image" && typeof block.data === "string";
}

/**
 * Sınır aşıldıysa en eski görselleri metin yer tutucuya çevirir ve düşürülen sayısını döner.
 *
 * En eskiden başlanır: son turun görseli kullanıcının o an sorduğu şeydir, düşürülecek en son o
 * olmalıdır. Verilen dizi yerinde değişir; motor bunu Pi'nin her LLM çağrısından önce verdiği
 * kopya üzerinde çağırır, oturum dosyasındaki kayıt ve bellekteki geçmiş olduğu gibi kalır.
 */
export function trimImageHistory(
  messages: readonly TrimmableMessage[],
  limits: ImageLimits,
  placeholder: ImagePlaceholder,
): number {
  const budget = Math.max(0, limits.bytes);
  const maxCount =
    limits.count === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limits.count);
  const slots: { content: unknown[]; index: number; bytes: number }[] = [];
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const content: unknown[] = message.content;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!isImageBlock(block)) continue;
      slots.push({ content, index: i, bytes: block.data.length });
      total += block.data.length;
    }
  }
  let remaining = slots.length;
  if (total <= budget && remaining <= maxCount) return 0;

  let dropped = 0;
  for (const slot of slots) {
    if (total <= budget && remaining <= maxCount) break;
    // Sayı sınırı sağlayıcının kesin kuralıdır; ikisi de aşıldıysa kullanıcıya o anlatılır.
    const reason = remaining > maxCount ? "count" : "bytes";
    slot.content[slot.index] = { type: "text", text: placeholder(reason) };
    total -= slot.bytes;
    remaining -= 1;
    dropped += 1;
  }
  return dropped;
}
