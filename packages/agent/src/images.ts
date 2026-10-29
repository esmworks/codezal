import type { ImageAttachment } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";

/**
 * Görsel başına base64 bütçesi. Pi'nin küçültücüsü adayları PNG, JPEG(q80), JPEG(q85)… sırasıyla
 * üretir ve bütçenin altına düşen ilk adayı seçer; bütçe yüksek olduğunda ekran görüntüleri
 * megabaytlık PNG olarak kalıyordu. 700 KB, 2000 piksellik bir ekran görüntüsünün PNG'sini eler
 * ama q80 JPEG'ini (~0,5 MB) ölçek düşürmeden geçirir.
 *
 * Neden bu kadar düşük: sağlayıcı ağ geçitleri istek gövdesini sınırlar (OpenCode Go: 6 MiB) ve
 * oturumdaki tüm görseller her turda yeniden gönderilir. Megabaytlık PNG'lerle sınır dört ekran
 * görüntüsünde doluyor ve sonraki her tur açıklamasız 400 alıyordu.
 *
 * Bütçeyi aşan saydam PNG'ler JPEG'e dönerken saydamlığını yitirir; ekran görüntüsü ve fotoğrafta
 * sorun değil, bu boyutta saydam görsel de nadirdir.
 */
const LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 700 * 1024 };
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Arayüzden gelen görselleri Pi ImageContent'e çevirir; büyükleri Pi'nin `resizeImage`'ı ile küçültür.
 * Küçültme başarısız olursa (WASM yoksa) görsel olduğu gibi gönderilir.
 */
export async function prepareImages(
  images: readonly ImageAttachment[],
  lang: Locale = "tr",
): Promise<ImageContent[]> {
  const out: ImageContent[] = [];
  for (const img of images) {
    if (!SUPPORTED_IMAGE_TYPES.has(img.mimeType)) {
      const d = dict(lang);
      throw new Error(d.errors.imageTypeUnsupported.replace("{{type}}", img.mimeType));
    }
    let data = img.data;
    let mimeType = img.mimeType;
    try {
      const resized = await resizeImage(Buffer.from(img.data, "base64"), img.mimeType, LIMITS);
      if (resized?.wasResized) {
        data = resized.data;
        mimeType = resized.mimeType;
      }
    } catch {
      // küçültme yapılamadı; orijinal gider
    }
    out.push({ type: "image", data, mimeType });
  }
  return out;
}
