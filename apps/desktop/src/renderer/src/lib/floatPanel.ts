/**
 * Sohbet çerçevesi: ZCode'un transkript kolonuyla aynı ölçüler, artı sağda yüzen panel payı.
 *
 * Panel bir sütun değil, sohbetin üstünde duran katmandır: sohbet alanı pencerenin sağına kadar
 * uzandığı için dikey kaydırma çubuğu pencere kenarına yapışır. Panel açıkken içerik alanını
 * daraltmak için kolonun bulunduğu kabın sağ dolgusuna panelin genişliği eklenir; kolon hem
 * panel açıkken hem kapalıyken aynı yerde durur, geçişte kaymaz.
 */

/** Yüzen panel genişliği; `EnvBox` ve `TaskBoxes` bu genişlikte çizilir. */
export const FLOAT_PANEL_WIDTH = 314;

/**
 * Sol mesaj çubuğunun şeridi: sohbet kolonunun solunda ayrı ve dar bir sütun (ZCode'un tur
 * gezgini de böyle ayrı bir şeritte durur). Çizgiler metnin üzerine binmez, kırpılmaz.
 * `--rail-pad` sohbet alanının genişliğine bağlıdır: alan daraldığında şerit kapanır ve sohbet
 * tam genişliği kullanır (ZCode'un gezgini de 864px altında görünmez).
 */

/** Sohbet alanı kabına konan çubuk payı: dar alanda 0, geniş alanda şerit genişliği (2rem). */
export const RAIL_PAD_CLASS = "[--rail-pad:0px] @min-[864px]/chat:[--rail-pad:2rem]";

/** Şeridin kendisi: yalnız geniş alanda çizilir, daralınca kapanır. */
export const RAIL_STRIP_CLASS = "hidden w-8 shrink-0 @min-[864px]/chat:block";

/**
 * Sohbet kolonu (transkript, mesaj çubuğu ve composer aynı sınıfı kullanır; kenarlar hizalı kalır).
 *
 * Genişlik ZCode'dan: sütun 896px'tir, yalnız pencere çok genişken (≥1536px) 1152px'e çıkar.
 * Ölçüt **pencerenin değil sohbet alanının** genişliğidir (`@container/chat`): yan panel ve kenar
 * çubuğu açıkken sohbet alanı dar kalır, kolon da ona göre dar kalır. Eskiden `xl:` ile pencere
 * genişliğine bakılıyordu; kenar çubuğu açıkken bile kolon 1152px'e çıkıp sohbeti gereğinden çok
 * genişletiyordu.
 */
export const CHAT_COLUMN =
  "mx-auto w-full max-w-[896px] px-4 md:px-6 @min-[1536px]/chat:max-w-[1152px]";

/**
 * Sohbet kabının yatay dolguları. Sol ve sağ **aynı** ölçüyü paylaşır: solda mesaj çubuğunun
 * şeridi, sağda yüzen panelin payı (+ şerit payı). Böylece sohbet, kenar çubuğu ile yüzen panel
 * arasında eşit boşlukla durur; eskiden sağdaki pay yalnız panel kadardı ve sohbet sağa yatık
 * görünüyordu.
 */
export function chatPadLeft(): string {
  return "var(--rail-pad, 0px)";
}

export function chatPadRight(floatPanel: boolean): string {
  return floatPanel
    ? `calc(${FLOAT_PANEL_WIDTH}px + var(--rail-pad, 0px))`
    : "var(--rail-pad, 0px)";
}

/**
 * Kaydırma çubuğu genişliği: `styles.css`'teki `::-webkit-scrollbar` ile aynı olmalı. Transkript
 * kabı `scrollbar-gutter: stable both-edges` ile iki yanda bu kadar yer ayırır; kabın dışındaki
 * composer bu payı almazsa her yandan 10px geniş kalıyor, alt alta duran kartla hizası kayıyordu.
 */
export const SCROLLBAR_GUTTER = 10;

/** Transkript kabının dışındaki composer şeridinin yatay dolgusu: kabın payı + çubuk payı. */
export function composerPad(floatPanel: boolean): { paddingLeft: string; paddingRight: string } {
  return {
    paddingLeft: `calc(${chatPadLeft()} + ${SCROLLBAR_GUTTER}px)`,
    paddingRight: `calc(${chatPadRight(floatPanel)} + ${SCROLLBAR_GUTTER}px)`,
  };
}
