import type { ImageAttachment } from "@codezal/contracts";
import { i18n } from "./i18n";

export const MAX_IMAGES = 10;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isImageFile(file: File): boolean {
  return ACCEPTED.has(file.type);
}

/** Dosyayı base64 eke çevirir (data: öneki atılır). */
export function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(i18n.t("errors.fileUnreadable")));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve({
        mimeType: file.type,
        data: comma >= 0 ? url.slice(comma + 1) : "",
        ...(file.name && !file.name.startsWith("image.") ? { name: file.name } : {}),
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Yapıştırma ya da bırakma olayındaki görsel dosyalarını toplar. */
export async function attachmentsFrom(
  list: FileList | DataTransferItemList | null | undefined,
): Promise<ImageAttachment[]> {
  if (!list) return [];
  const files: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry) continue;
    const file = entry instanceof File ? entry : entry.kind === "file" ? entry.getAsFile() : null;
    if (file && isImageFile(file)) files.push(file);
  }
  return Promise.all(files.map(fileToAttachment));
}

export function dataUrl(img: Pick<ImageAttachment, "mimeType" | "data">): string {
  return `data:${img.mimeType};base64,${img.data}`;
}

export function approxKb(img: Pick<ImageAttachment, "data">): number {
  return Math.round((img.data.length * 3) / 4 / 1024);
}
