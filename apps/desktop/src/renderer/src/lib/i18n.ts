import { createI18n, type Locale, localeOf } from "@codezal/i18n";
import { initReactI18next, useTranslation } from "react-i18next";

/**
 * Renderer'daki tek i18next örneği. Başlangıç dili sistem dilinden algılanır: ayarlar yüklenene
 * kadarki ilk boyama doğru dilde olur. Dil, ayarlar yüklendiğinde veya değiştiğinde
 * changeLanguage ile güncellenir; tüm useTranslation() bileşenleri otomatik yeniden çizilir.
 *
 * Not: testlerde `navigator.language` Node'un yerel ayarıdır. Görünen metni iddia eden testler dili
 * kendisi sabitlemeli (`i18n.changeLanguage("tr")`); aksi hâlde sonuç makineye göre değişir.
 */
export const i18n = createI18n(localeOf(navigator.language), initReactI18next);

/** Bileşenin o anki dili: useTranslation aboneliği sayesinde dil değişince yeniden çizilir. */
export function useLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return localeOf(instance.language);
}
