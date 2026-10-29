/**
 * Anahtar benzeri diziler. Sağlayıcı hata gövdeleri isteği (başlık ya da URL dahil) geri yansıtabilir;
 * Google `?key=AIza…`, GitHub belirteci ya da AWS erişim anahtarı böylece renderer'a ve günlüğe
 * düşüyordu. Desenler sağlayıcıların belgelenmiş öneklerine dayanır, genel "uzun dizi" tahmini
 * yapmaz: commit karması ya da dosya adı maskelenmesin.
 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Google API anahtarı ve OAuth erişim belirteci.
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z._-]{10,}/g,
  // GitHub: klasik (ghp/gho/ghu/ghs/ghr) ve ince ayarlı (github_pat_) belirteçler.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Groq ve xAI anahtarları.
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  // AWS erişim anahtarı kimliği (kalıcı AKIA, geçici ASIA).
  /\bA(?:KI|SI)A[0-9A-Z]{16}\b/g,
];

/** Hata mesajlarından anahtar benzeri dizileri temizler (PRD §9). */
export function maskSecrets(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "•••");
  return out;
}
