import { createI18n, SOURCE_LOCALE } from "@codezal/i18n";

/**
 * Ana süreçteki tek i18next örneği. Başlangıç dili kaynak dildir: `app.getLocale()` yalnızca
 * ready sonrası okunabildiği için gerçek dil (ilk açılışta algılanan ya da ayardaki dil) index.ts
 * içinde changeLanguage ile uygulanır; menü o dile göre yeniden kurulur.
 */
export const i18n = createI18n(SOURCE_LOCALE);
