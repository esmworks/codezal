/**
 * Arama için metin katlama: hem Türkçe hem İngilizce yazımda aynı sonucu verir. Main (oturum
 * içeriği araması) ve renderer (listeler, sohbet içi bulma) aynı kuralı kullanmak zorunda olduğu
 * için tek yerde durur.
 *
 * Neden `toLocaleLowerCase("tr")` yetmiyor: Türkçe küçültmede `I → ı` olur, `i → i` kalır. Bir
 * oturum adı "Fix IPC timeout" iken `ıpc` üretildiği için kullanıcı `ipc` yazınca eşleşme
 * bulunamıyordu (aynı sorun `ui`, `ide`, `ios` gibi bütün kısaltmalarda). Ters yönde de aynı
 * tuzak var: "İstanbul" `toLowerCase()` ile `i̇stanbul` (i + birleşen nokta) olur ve `istanbul`
 * araması tutmaz.
 *
 * Çözüm: aksanları ayır ve at, noktasız `ı`yı `i`ye indir, sonra yerel ayardan bağımsız küçült.
 * Böylece dört yazım da (`IPC`, `ıpc`, `İpc`, `ipc`) aynı anahtara iner.
 */
export function foldForSearch(text: string): string {
  return (
    text
      .normalize("NFD")
      // Birleşen aksan işaretleri: `İ` bu adımda `I` + U+0307 olur, nokta burada düşer.
      .replace(/[̀-ͯ]/g, "")
      // Noktasız küçük i (U+0131) ve noktalı büyük İ (U+0130): kaçışla yazılır ki kaynakta
      // sözlük dışı Türkçe harf kalmasın (i18n kapısı bunu yakalar).
      .replace(/ı/g, "i")
      .replace(/İ/g, "i")
      .toLowerCase()
  );
}

/** Sorgu metni katlanmış hedefte geçiyor mu; ikisi de katlanır. */
export function matchesFold(haystack: string, needle: string): boolean {
  return foldForSearch(haystack).includes(foldForSearch(needle));
}

/** Katlanmış metin ve her katlanmış UTF-16 biriminin özgün metindeki başlangıç konumu. */
export interface FoldedText {
  folded: string;
  /** `map[i]`: `folded[i]`'nin geldiği kod noktasının özgün metindeki konumu. */
  map: number[];
}

/** ASCII dışı kod noktalarının katlaması; aynı harf metinde binlerce kez geçer. */
const charFolds = new Map<string, string>();

function foldChar(ch: string): string {
  const cached = charFolds.get(ch);
  if (cached !== undefined) return cached;
  const folded = foldForSearch(ch);
  if (charFolds.size < 4096) charFolds.set(ch, folded);
  return folded;
}

/**
 * Konum haritalı katlama. Katlama uzunluğu korumaz: önceden ayrışık (NFD) yazılmış metinde
 * birleşen işaretler düşer, Hangul hecesi birkaç harfe açılır. Eşleşmenin özgün metindeki yerini
 * (özet parçası, vurgu aralığı) bulmak için katlama kod noktası kod noktası yapılır ve her çıktı
 * biriminin kaynağı tutulur. Bulma bu çıktı üstünde yapılmalı; `foldForSearch` ile bütün metin
 * katlaması nadir durumlarda (Yunanca son sigma) farklı sonuç verebilir.
 */
export function foldWithMap(text: string): FoldedText {
  let folded = "";
  const map: number[] = [];
  let at = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      // ASCII hızlı yolu: büyük harf küçülür, gerisi olduğu gibi.
      folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
      map.push(at);
    } else {
      const f = foldChar(ch);
      folded += f;
      for (let i = 0; i < f.length; i++) map.push(at);
    }
    at += ch.length;
  }
  return { folded, map };
}

/** Sorgunun katlanmış biçimi; `foldWithMap` çıktısında aranacak anahtar. */
export function foldQuery(query: string): string {
  return foldWithMap(query.trim()).folded;
}

/** Katlanmış aralığı özgün metindeki `[start, end)` aralığına çevirir. */
export function originalRange(
  source: FoldedText,
  text: string,
  foldedStart: number,
  foldedLength: number,
): { start: number; end: number } {
  const start = source.map[foldedStart] ?? text.length;
  const lastIndex = foldedStart + foldedLength - 1;
  const last = source.map[lastIndex];
  if (last === undefined) return { start, end: text.length };
  // Son katlanmış birimin geldiği kod noktasının tamamı aralığa girer (vekil çift bölünmesin).
  const cp = text.codePointAt(last) ?? 0;
  return { start, end: last + (cp > 0xffff ? 2 : 1) };
}

/** Katlanmış metinde sorgunun bütün geçişleri (örtüşmesiz), özgün metin konumlarıyla. */
export function findAllFolded(
  text: string,
  needle: string,
  limit = Number.POSITIVE_INFINITY,
): { start: number; end: number }[] {
  if (!needle) return [];
  const source = foldWithMap(text);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  while (out.length < limit) {
    const at = source.folded.indexOf(needle, from);
    if (at < 0) break;
    out.push(originalRange(source, text, at, needle.length));
    from = at + needle.length;
  }
  return out;
}

/** Özet parçası: eşleşmenin çevresi, eşleşme aralığı parça içinde. */
export interface Snippet {
  text: string;
  matchStart: number;
  matchEnd: number;
}

/** Boşlukları tek boşluğa indirir; özet tek satırda okunur. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Eşleşmenin çevresinden kısa özet. Satır sonları boşluğa iner, kesilen uçlara `…` konur ve
 * kesim mümkünse kelime sınırına çekilir (yarım kelime ile başlamasın). Eşleşmenin kendisi hiç
 * kırpılmaz.
 */
export function buildSnippet(text: string, start: number, end: number, radius = 60): Snippet {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  let beforeFrom = Math.max(0, s - radius);
  if (beforeFrom > 0) {
    const space = text.slice(beforeFrom, s).search(/\s/);
    if (space >= 0 && beforeFrom + space < s) beforeFrom += space + 1;
  }
  let afterTo = Math.min(text.length, e + radius);
  if (afterTo < text.length) {
    const tail = text.slice(e, afterTo);
    const space = tail.search(/\s\S*$/);
    if (space > 0) afterTo = e + space;
  }
  const lead = beforeFrom > 0 ? "…" : "";
  const before = squash(text.slice(beforeFrom, s)).replace(/^\s+/, "");
  const match = squash(text.slice(s, e));
  const after = squash(text.slice(e, afterTo)).replace(/\s+$/, "");
  const trail = afterTo < text.length ? "…" : "";
  const head = `${lead}${before}`;
  return {
    text: `${head}${match}${after}${trail}`,
    matchStart: head.length,
    matchEnd: head.length + match.length,
  };
}
