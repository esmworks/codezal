import { loadJson, saveJson } from "./storage";

/**
 * Yazma kutusu geçmişi: gönderilen istemler proje başına saklanır, ↑/↓ ile geri çağrılır.
 *
 * Neden proje başına: kullanıcı bir projede çalışırken "aynı şeyi yeniden söylemek" ister;
 * başka bir projenin istemleri bu listede gürültü olurdu. Anahtarlar oturum değil proje
 * olduğundan geçmiş oturumlar arasında da taşınır.
 *
 * Kalıcılık `localStorage`'dadır (taslaklarla aynı yaklaşım): istemler zaten oturum dosyalarında
 * durur, burada yalnız kullanıcının geri çağırabileceği kısa bir liste tutulur.
 */
const KEY = "codezal.promptHistory";

/** Proje başına saklanan istem sayısı. */
export const MAX_HISTORY = 50;

/** Tek istemin saklanan en fazla uzunluğu; çok satırlı yapıştırmalar listeyi şişirmesin. */
export const MAX_ENTRY_CHARS = 2_000;

type History = Record<string, string[]>;

/**
 * Liste her seferinde depodan okunur. Modül düzeyinde önbellek tutulmuyor: önbellek, depolamayı
 * dışarıdan temizleyen bir çağıranla (test, oturum sıfırlama) sessizce ayrışırdı ve kazanç
 * ölçülemez küçük (en fazla `MAX_HISTORY` kısa satır).
 */
function read(): History {
  const raw = loadJson<unknown>(KEY, {});
  const out: History = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      out[key] = value.filter((v): v is string => typeof v === "string");
    }
  }
  return out;
}

/** Projenin istem geçmişi (en yeni başta). */
export function historyFor(key: string): string[] {
  return read()[key] ?? [];
}

/**
 * Gönderilen istemi kaydeder. Aynı istem üst üste gönderildiyse listeye ikinci kez eklenmez,
 * var olan kayıt başa alınır: kabuk geçmişiyle aynı davranış.
 */
export function rememberPrompt(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const entry = trimmed.slice(0, MAX_ENTRY_CHARS);
  const all = read();
  const list = (all[key] ?? []).filter((t) => t !== entry);
  list.unshift(entry);
  saveJson(KEY, { ...all, [key]: list.slice(0, MAX_HISTORY) });
}

/**
 * Geçmişte gezinme durumu: `index` null ise kullanıcı hâlâ yazdığı taslakta.
 *
 * `draft` **çağıranın taslak tipidir** (`ComposerDraft`), metin değil: gezinme yalnız görünen
 * metni saklasaydı, uzun yapıştırmaların yer tutucuları çözülemez hâle gelir ve kullanıcının
 * yapıştırdığı içerik gönderimde yer tutucu metinle değişirdi.
 */
export interface HistoryCursor<T = string> {
  index: number | null;
  /** Gezinmeye başlarken kutuda duran taslak; listenin sonuna gelince geri konur. */
  draft: T;
}

/** Gezinme sonucu: yazılacak metin ve yeni imleç. */
export interface HistoryStep<T = string> {
  text: string;
  cursor: HistoryCursor<T>;
}

/**
 * ↑: bir önceki (daha eski) isteme gider. Listenin başındayken yerinde kalır.
 * Gezinmeye ilk kez girildiğinde kutudaki taslak saklanır.
 */
export function historyPrev<T>(
  list: readonly string[],
  cursor: HistoryCursor<T>,
  draft: T,
): HistoryStep<T> {
  if (list.length === 0) return { text: "", cursor };
  const start: HistoryCursor<T> = cursor.index === null ? { index: null, draft } : cursor;
  const next = start.index === null ? 0 : Math.min(list.length - 1, start.index + 1);
  return { text: list[next] ?? "", cursor: { index: next, draft: start.draft } };
}

/** ↓: daha yeni isteme gider; listenin sonunda kullanıcının kendi taslağına döner. */
export function historyNext<T>(list: readonly string[], cursor: HistoryCursor<T>): HistoryStep<T> {
  // Gezinme sürerken ↓ bir sonraki (daha yeni) isteme, listenin sonunda kullanıcının taslağına
  // gider. `index === null` iken çağrılmamalıdır: o durumda ↓ normal satır gezinmesidir ve
  // buradan dönmek kutuyu boşaltırdı.
  if (cursor.index === null) return { text: "", cursor };
  const next = cursor.index - 1;
  if (next < 0) return { text: "", cursor: { index: null, draft: cursor.draft } };
  return { text: list[next] ?? "", cursor: { index: next, draft: cursor.draft } };
}

/**
 * İmleç gezinmeyi tetiklemeli mi. Çok satırlı kutuda ↑/↓ önce satırlar arasında gezinmelidir:
 * yalnızca imlecin üstünde (↑) ya da altında (↓) satır yoksa geçmişe gidilir.
 */
export function atHistoryEdge(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: "up" | "down",
): boolean {
  // Seçim varsa kullanıcı metin seçiyor: ok tuşu seçimi daraltmalı, geçmişi açmamalı.
  if (selectionStart !== selectionEnd) return false;
  return direction === "up"
    ? !value.slice(0, selectionStart).includes("\n")
    : !value.slice(selectionEnd).includes("\n");
}
