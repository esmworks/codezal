import { randomBytes } from "node:crypto";
import { dict, type Locale } from "@codezal/i18n";

/**
 * Görünmez karakterler: sıfır genişlikli boşluk/birleştiriciler, yön değiştiriciler, BOM, yumuşak
 * tire ve Unicode etiket blokları (U+E0000–E007F). Sayfaya gizlenen talimat ekranda görünmez ama
 * modele metin olarak ulaşır ("ASCII smuggling"); silinince ya görünür olur ya da tümden kaybolur.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁯﻿\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * Talimat enjeksiyonu imzaları (legacy `redactInjectionAttempts`). Legacy eşleşen satırı silerdi;
 * burada yalnız sayılır: "jailbreak" ya da "önceki talimatları yok say" geçen bir haber satırı
 * silinirse özet bozulur, kalıbı aşmak da kolaydır. Sayı zarfın uyarısına yazılır.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|messages|prompts|commands|rules|directions)/i,
  /\bforget\s+(?:everything|all)\s+(?:above|before|you\s+(?:were|have\s+been)\s+told)/i,
  /\bnew\s+(?:instructions?|system\s+prompt)\s*:/i,
  /\bsystem\s*:\s*you\s+(?:are|must|should|will)\b/i,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,
  /\[\/?INST\]/,
  /###\s*(?:instruction|system)\s*:/i,
  /\bBEGIN\s+SYSTEM\s+(?:PROMPT|MESSAGE)\b/i,
  /\b(?:claude|assistant|gpt|the\s+ai|ai\s+agent|codezal)[,:\s]+(?:please\s+)?(?:execute|run|delete|curl|wget|send|post|upload|exfiltrate|email)\b/i,
  /\b(?:print|reveal|show|output)\s+(?:the\s+|your\s+)?(?:system\s+prompt|hidden\s+(?:rules|instructions)|api\s+keys?|credentials)\b/i,
  /\bdeveloper\s+mode\s+(?:enabled|on|activated)\b/i,
  /(?:önceki|yukarıdaki|daha\s+önceki)\s+(?:tüm\s+|bütün\s+)?(?:talimatları|komutları|kuralları|mesajları)\s+(?:yok\s+say|unut|görmezden\s+gel|dikkate\s+alma)/i,
  /(?:yeni\s+talimatlar?|sistem\s+istemi)\s*:/i,
];

/** Talimat kalıbı taşıyan satır sayısı. */
export function countInjectionLines(text: string): number {
  let hits = 0;
  for (const line of text.split("\n")) {
    if (INJECTION_PATTERNS.some((re) => re.test(line))) hits++;
  }
  return hits;
}

/** Güvenilmez içeriğin kaynağı: web araçları ya da bağlı servisler (MCP, yerel Google servisleri). */
export type UntrustedKind = "web" | "service";

const MARKER: Record<UntrustedKind, string> = { web: "WEB", service: "SERVICE" };

/**
 * Dışarıdan gelen metni güvenilmez veri bloğuna alır. Sınır kimliği her çağrıda rastgeledir: içerik
 * kapanış satırını taklit edip bloğun dışına "sistem" metni yazamaz. Görünmez karakterler silinir,
 * talimat kalıbı varsa sayısı uyarıya eklenir. Servis içeriği (e-posta, belge, kayıt) başkasının
 * yazdığı metni taşır; web içeriğiyle aynı korumayı alır.
 */
export function wrapUntrusted(
  source: string,
  body: string,
  lang: Locale,
  kind: UntrustedKind = "web",
): string {
  const p = dict(lang).prompt;
  const clean = stripInvisible(body);
  const hits = countInjectionLines(clean);
  const id = randomBytes(6).toString("hex");
  const tag = MARKER[kind];
  const notice = kind === "web" ? p.webUntrusted : p.serviceUntrusted;
  return [
    `<<<UNTRUSTED_${tag}_CONTENT id=${id} source=${stripInvisible(source).replace(/\s+/g, " ")}>>>`,
    notice.replace("{{id}}", id),
    ...(hits > 0 ? [p.webUntrustedHits.replace("{{n}}", String(hits))] : []),
    "---",
    clean,
    `<<<END_UNTRUSTED_${tag}_CONTENT id=${id}>>>`,
  ].join("\n");
}

const WRAPPED =
  /<<<UNTRUSTED_(WEB|SERVICE)_CONTENT id=([0-9a-f]+)[^\n]*>>>\n[\s\S]*?\n---\n([\s\S]*?)\n<<<END_UNTRUSTED_\1_CONTENT id=\2>>>/g;

/**
 * Arayüz için: sarılmış blokların başlık, uyarı ve bitiş satırları atılır, içerik kalır. Kart
 * kullanıcıya servisin ya da sayfanın döndürdüğünü gösterir; uyarı yalnız modele yöneliktir.
 * Bitiş satırı kırpılmış blok olduğu gibi kalır.
 */
export function unwrapUntrusted(text: string): string {
  return text.replace(WRAPPED, "$3");
}
