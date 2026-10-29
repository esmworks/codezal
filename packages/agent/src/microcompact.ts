/**
 * Bağlam yönetiminin **ucuz** kademesi: eski araç sonuçlarının gövdeleri yer tutucuya çevrilir.
 *
 * Neden gerekli: oturumdaki her araç sonucu (dosya okuması, kabuk çıktısı, arama sonucu) sonraki
 * her turda yeniden gönderilir. Uzun bir oturumda bunların toplamı bağlam penceresini doldurur ve
 * tek çare pahalı kademe kalır — tüm geçmişi özetleyen `compact()`, yani hem gecikme hem bilgi
 * kaybı. ZCode aynı iki kademeyi kullanır: önce ucuz olan (burada), yetmezse özet.
 *
 * Buradaki dönüşüm yalnızca **modele giden kopyada** olur (`context` kancası): oturum dosyası ve
 * bellekteki geçmiş değişmez, kullanıcı arayüzü tam çıktıyı göstermeye devam eder, geri sarma ve
 * araç kartları etkilenmez.
 *
 * Model ne kaybeder: eski bir araç sonucunun içeriği. Yer tutucu hangi aracın düşürüldüğünü
 * söylediği için model gerekirse aynı aracı yeniden çalıştırabilir; bu, bağlamı taşırmaktan
 * (tur kaybı) her durumda daha iyidir.
 */

/** Korunan en yeni araç sonucu sayısı: son adımlar modelin üzerinde çalıştığı bağlamdır. */
export const KEEP_RECENT_TOOL_RESULTS = 5;

/**
 * Bunun altındaki sonuçlar düşürülmez. Yer tutucu birkaç düzine karakter tuttuğu için kısa
 * sonuçları çevirmek kazanç sağlamaz, yalnızca bağlamı gürültüye çevirir.
 */
export const MIN_DROPPABLE_CHARS = 400;

/** Toplam kazanç bunun altındaysa geçmiş hiç değiştirilmez (gereksiz kopya ve gürültü olmasın). */
export const MIN_SAVINGS_CHARS = 2_000;

/** Pi mesajlarının bu iş için gereken kadarı. */
export interface CompactableMessage {
  readonly role?: string;
  readonly toolName?: string;
  /** Pi araç sonucunun hata işareti; hatalı sonuçlar düşürülmez. */
  readonly isError?: boolean;
  /** Araç sonuçlarında içerik dizisi; metin blokları yerinde değiştirilir. */
  readonly content?: unknown;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string";
}

/** Bir araç sonucu mesajındaki metin blokları ve toplam uzunlukları. */
function textBlocks(message: CompactableMessage): { block: TextBlock; length: number }[] {
  if (!Array.isArray(message.content)) return [];
  const out: { block: TextBlock; length: number }[] = [];
  for (const block of message.content)
    if (isTextBlock(block)) out.push({ block, length: block.text.length });
  return out;
}

/**
 * Eski araç sonuçlarını yer tutucuya çevirir ve **kazanılan karakter sayısını** döner.
 *
 * Verilen dizi yerinde değişir; motor bunu Pi'nin her LLM çağrısından önce verdiği kopyada
 * çağırır. En yeni `KEEP_RECENT_TOOL_RESULTS` sonuç korunur; görsel içeren sonuçlar hiç
 * düşürülmez (görsellerin kendi bütçesi var, `image-budget.ts`) ve hata sonuçları korunur —
 * modelin hatadan öğrendiği bilgi sonraki adımda gerekebilir.
 */
export function microcompact(
  messages: readonly CompactableMessage[],
  placeholder: (toolName: string) => string,
): number {
  const results: { message: CompactableMessage; blocks: { block: TextBlock; length: number }[] }[] =
    [];
  for (const message of messages) {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
    // Hata sonucu: model hatadan öğrendiğini sonraki adımlarda kullanır, yer tutucu bunu siler.
    if (message.isError === true) continue;
    // Görselli sonuç: metni düşürmek görseli düşürmez, görselin kendi bütçesi var.
    if (message.content.some((b) => (b as { type?: unknown }).type === "image")) continue;
    const blocks = textBlocks(message);
    if (blocks.length > 0) results.push({ message, blocks });
  }

  // En yeni `KEEP_RECENT_TOOL_RESULTS` sonuç korunur; adaylar ondan öncekilerdir.
  const candidates = results.slice(0, Math.max(0, results.length - KEEP_RECENT_TOOL_RESULTS));
  const plan: { message: CompactableMessage; blocks: TextBlock[]; text: string }[] = [];
  let savings = 0;
  for (const { message, blocks } of candidates) {
    const length = blocks.reduce((sum, b) => sum + b.length, 0);
    if (length < MIN_DROPPABLE_CHARS) continue;
    const text = placeholder(message.toolName ?? "");
    plan.push({ message, blocks: blocks.map((b) => b.block), text });
    savings += length - text.length * blocks.length;
  }
  // Kazanç eşiğin altındaysa geçmiş hiç değiştirilmez: gereksiz kopya ve gürültü olmasın.
  if (savings < MIN_SAVINGS_CHARS) return 0;

  for (const item of plan) {
    for (const block of item.blocks) block.text = item.text;
  }
  return savings;
}
