import { createInstance, type i18n as I18nInstance, type ThirdPartyModule } from "i18next";
import { en } from "./en.js";
import { tr } from "./tr.js";

export { en, tr };

/**
 * Desteklenen dillerin kayıt defteri: tek yer. Yeni dil eklemek için sözlük dosyası (`xx.ts`)
 * yazılır, buraya bir satır eklenir; `Locale` tipi, i18next kaynakları, Intl etiketleri ve
 * `supportedLngs` buradan türetilir. Kalan iki elle senkron nokta `AppSettings.language` enumu
 * (parity testi bekçi) ve sözlükteki `settings.genel.languageNames.<kod>` adıdır.
 * Girdi sırası Ayarlar'daki dil seçicisinin sırasıdır.
 */
export const LOCALES = {
  tr: { dictionary: tr, tag: "tr-TR" },
  en: { dictionary: en, tag: "en-US" },
} as const;

/** Desteklenen dil kodu ("tr" | "en"). */
export type Locale = keyof typeof LOCALES;

/** Dil sözlüğünün biçimi: `en` genişletilmiş (string) tiptir, literal tip de ona sığar. */
export type Dict = typeof en;

/** Sözlüklerin kaynak dili: eksik anahtarın düştüğü dil ve `t()` tipinin kaynağı. */
export const SOURCE_LOCALE: Locale = "tr";

/** Sistem dili desteklenmiyorsa uygulanan dil: İngilizce (kullanıcı kararı, 2026). */
export const FALLBACK_LOCALE: Locale = "en";

/** Etiket desteklenen bir dil kodu mu ("tr", "en")? `in` kullanılmaz: prototip anahtarları ("toString") dil sanılmasın. */
export function isLocale(tag: string | undefined): tag is Locale {
  return tag !== undefined && Object.hasOwn(LOCALES, tag);
}

/** Desteklenen dil kodları kayıt defteri sırasıyla. */
export const LOCALE_CODES: Locale[] = Object.keys(LOCALES).filter(isLocale);

/**
 * Dil etiketini desteklenen dile çözer: "tr-TR" → "tr", "en-GB" → "en". Hem i18next'in o anki
 * dili hem de işletim sisteminin dili (ilk açılış algılaması) bu işlevden geçer; desteklenmeyen
 * ya da boş etiket İngilizceye düşer.
 */
export function localeOf(tag: string | undefined): Locale {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0];
  return base !== undefined && isLocale(base) ? base : FALLBACK_LOCALE;
}

/** Dil kodunun Intl etiketi: "tr" → "tr-TR", "en" → "en-US" (tarih/sayı biçimlendirmesi). */
export function localeTag(locale: Locale): string {
  return LOCALES[locale].tag;
}

/** Dil seçimi: sözlük nesnesi (agent, React dışında `t()` yerine alanları doğrudan okur). */
export function dict(locale: Locale): Dict {
  return LOCALES[locale].dictionary;
}

/** i18next kaynakları kayıt defterinden türetilir; yeni dil eklendiğinde değişmez. */
export const resources = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, { translation: LOCALES[code].dictionary }]),
) as Record<Locale, { translation: Dict }>;

/** i18next tip güvenliği: t() anahtarları derleme zamanında doğrulanır (namespace boyutu). */
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof tr };
  }
}

/** Sözlükteki derin anahtar yolları ("agent.tool.read" gibi). Kayıtlarla t() tipi otomatik eşleşir. */
export type TranslationKey = TrKey<typeof tr>;

type TrKey<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${TrKey<T[K]>}`;
    }[keyof T & string];

/** Yeni bir i18next örneği; plugin (örn. initReactI18next) init'ten önce takılır. */
export function createI18n(initial: Locale, plugin?: ThirdPartyModule): I18nInstance {
  const instance = createInstance();
  if (plugin) instance.use(plugin);
  instance.init({
    resources,
    lng: initial,
    fallbackLng: SOURCE_LOCALE,
    supportedLngs: LOCALE_CODES,
    interpolation: { escapeValue: false },
  });
  return instance;
}
