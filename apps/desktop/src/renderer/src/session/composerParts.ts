import type { ImageAttachment } from "@codezal/contracts";

/**
 * Görünen metinde sanal yer tutucu olarak duran yapıştırma parçası. Gerçek içerik metne
 * gömülmez; böylece uzun yapıştırmalar kutuyu doldurmaz ve taşıma/sıfırlama sırasında
 * içerik state'te güvende kalır.
 */
export interface PastePart {
  id: string;
  /** Metinde görünen yer tutucu; gönderimde `text` ile değişir. */
  placeholder: string;
  /** Gönderimde yer tutucunun yerine geçen gerçek içerik. */
  text: string;
  /** Görünen metindeki aralık. */
  start: number;
  end: number;
}

/** Composer'ın tek doğruluk kaynağı: görünen metin + yapıştırma parçaları + görseller + alıntılar. */
export interface ComposerDraft {
  text: string;
  pastes: PastePart[];
  images: ImageAttachment[];
  /** Sohbetten "Yanıtla" ile alınan metinler; gönderimde mesajın sonuna blok olarak eklenir. */
  quotes: string[];
}

export function emptyDraft(): ComposerDraft {
  return { text: "", pastes: [], images: [], quotes: [] };
}

/** Taslakta gönderilecek bir mesaj var mı; tek başına alıntı mesaj sayılmaz (soru yazılmalı). */
export function hasMessage(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.images.length > 0 || draft.pastes.length > 0;
}

/** Saklanacak bir şey var mı; alıntı da sayılır ki oturumlar arasında gidip gelince kaybolmasın. */
export function isDraftEmpty(draft: ComposerDraft): boolean {
  return !hasMessage(draft) && draft.quotes.length === 0;
}

/** Alıntıyı sona ekler; boş ya da zaten ekli alıntı taslağı değiştirmez. */
export function addQuote(draft: ComposerDraft, raw: string): ComposerDraft {
  const quote = normalizePaste(raw).trim();
  if (!quote || draft.quotes.includes(quote)) return draft;
  return { ...draft, quotes: [...draft.quotes, quote] };
}

export function removeQuoteAt(draft: ComposerDraft, index: number): ComposerDraft {
  return { ...draft, quotes: draft.quotes.filter((_, i) => i !== index) };
}

/** Sonu satır sonuyla biten metin fazladan satır saymaz. */
export function pasteLineCount(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return (body.match(/\n/g)?.length ?? 0) + 1;
}

/**
 * Uzun yapıştırma çipe dönüşür: OpenCode TUI eşiği (3+ satır veya 150+ karakter).
 * Altında kalan metin doğrudan yazılır; küçük parçalar için çip gürültü olur.
 */
export function shouldCollapsePaste(text: string): boolean {
  const trimmed = text.trim();
  return pasteLineCount(trimmed) >= 3 || trimmed.length > 150;
}

/** Satır sonlarını tek biçime indirir; CRLF karışıklığı offsetleri bozardı. */
export function normalizePaste(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `paste-${idSeq}`;
}

/**
 * Taslakta tekil yer tutucu: aynı boyda iki yapıştırma aynı etiketi taşısaydı `syncDraft` metin
 * sırasıyla eşlerdi ve birincisi silinince kalan etiket birincinin içeriğini gönderirdi.
 */
export function uniquePlaceholder(pastes: readonly PastePart[], label: string): string {
  const taken = new Set(pastes.map((part) => part.placeholder));
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label} #${n}`)) n += 1;
  return `${label} #${n}`;
}

/**
 * Yer tutucuyu görünen metne `start..end` aralığına yerleştirir ve parça offsetlerini
 * kaydırır. Aralık bir parçanın üstüne gelirse eski parça düşer (yer tutucusu da silinir).
 */
export function insertPaste(
  draft: ComposerDraft,
  realText: string,
  placeholder: string,
  start: number,
  end: number,
): ComposerDraft {
  const from = Math.max(0, Math.min(start, draft.text.length));
  const to = Math.max(from, Math.min(end, draft.text.length));
  const delta = placeholder.length - (to - from);
  const pastes: PastePart[] = [];
  for (const part of draft.pastes) {
    if (part.end <= from) pastes.push(part);
    else if (part.start >= to)
      pastes.push({ ...part, start: part.start + delta, end: part.end + delta });
  }
  pastes.push({
    id: nextId(),
    placeholder,
    text: realText,
    start: from,
    end: from + placeholder.length,
  });
  pastes.sort((a, b) => a.start - b.start);
  return {
    text: draft.text.slice(0, from) + placeholder + draft.text.slice(to),
    pastes,
    images: draft.images,
    quotes: draft.quotes,
  };
}

/**
 * Kullanıcı düzenlemesinden sonra parçaları görünen metne göre yeniden konumlandırır.
 * Sıralı `indexOf` kullanılır; yer tutucular tekil olduğu için (`uniquePlaceholder`) her parça
 * kendi etiketini bulur. `Yapıştırıldı ~3 satır`, `Yapıştırıldı ~3 satır #2`'nin önekidir: kısa
 * olan uzunun başında eşleşmez. Yer tutucusu silinen ya da bozulan parça düşer.
 */
export function syncDraft(draft: ComposerDraft, text: string): ComposerDraft {
  if (draft.pastes.length === 0) return draft.text === text ? draft : { ...draft, text };
  const pastes: PastePart[] = [];
  let cursor = 0;
  for (const part of draft.pastes) {
    const longer = draft.pastes
      .map((other) => other.placeholder)
      .filter(
        (other) => other.length > part.placeholder.length && other.startsWith(part.placeholder),
      );
    let at = text.indexOf(part.placeholder, cursor);
    while (at !== -1 && longer.some((other) => text.startsWith(other, at))) {
      at = text.indexOf(part.placeholder, at + 1);
    }
    if (at === -1) continue;
    pastes.push({ ...part, start: at, end: at + part.placeholder.length });
    cursor = at + part.placeholder.length;
  }
  return { ...draft, text, pastes };
}

/**
 * Gönderim metni: parçalar sondan başa gerçek içerikle değiştirilir, böylece offsetler
 * kaymaz. Offset bozulmuşsa tek eşleşme noktasından kurtarılır; yer tutucu hiç yoksa
 * kullanıcı onu bozmuştur ve olduğu gibi bırakılır.
 */
export function expandDraft(draft: ComposerDraft): string {
  let text = draft.text;
  const parts = [...draft.pastes].sort((a, b) => b.start - a.start);
  for (const part of parts) {
    if (text.slice(part.start, part.end) === part.placeholder) {
      text = text.slice(0, part.start) + part.text + text.slice(part.end);
      continue;
    }
    const at = text.indexOf(part.placeholder);
    if (at === -1) continue;
    text = text.slice(0, at) + part.text + text.slice(at + part.placeholder.length);
  }
  return text;
}

export interface MergeImagesResult {
  draft: ComposerDraft;
  /** Eklenen görsel sayısı. */
  added: number;
  /** Sınır yüzünden eklenemeyen görsel sayısı. */
  rejected: number;
}

/** Görselleri sınıra kadar ekler; sınır aşılırsa fazlası reddedilir (Composer notice gösterir). */
export function mergeImages(
  draft: ComposerDraft,
  incoming: ImageAttachment[],
  max: number,
): MergeImagesResult {
  if (incoming.length === 0) return { draft, added: 0, rejected: 0 };
  const room = Math.max(0, max - draft.images.length);
  const take = incoming.slice(0, room);
  return {
    draft: take.length === 0 ? draft : { ...draft, images: [...draft.images, ...take] },
    added: take.length,
    rejected: incoming.length - take.length,
  };
}

export function removeImageAt(draft: ComposerDraft, index: number): ComposerDraft {
  return { ...draft, images: draft.images.filter((_, i) => i !== index) };
}

/** Store'a yazmadan önce gereksiz kopyayı önler; görsel ve alıntılar referansla karşılaştırılır. */
export function sameDraft(a: ComposerDraft, b: ComposerDraft): boolean {
  return (
    a.text === b.text &&
    a.images === b.images &&
    a.quotes === b.quotes &&
    samePastes(a.pastes, b.pastes)
  );
}

function samePastes(a: PastePart[], b: PastePart[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((part, i) => {
    const other = b[i];
    if (!other) return false;
    return (
      part.id === other.id &&
      part.start === other.start &&
      part.end === other.end &&
      part.placeholder === other.placeholder
    );
  });
}
