/**
 * E2E test kimlikleri: `data-testid` değerlerinin **tek kaynağı**.
 *
 * Neden gerekli: uçtan uca testler kullanıcıya görünen rol/metin seçicilerini kullanır
 * (Playwright'ın önerisi budur) ama **düzen ve yapı** ölçen testler öyle yapamaz. Dün gece
 * kırılan testlerin ikisi tam bu yüzden kırılmıştı: biri sohbet kolonunu `max-w-[720px]`
 * sınıfıyla, öbürü paneli `main > firstElementChild > firstElementChild` zinciriyle buluyordu.
 * Sınıf ya da DOM sırası değişince test, ölçtüğü şey değişmediği hâlde düşer.
 *
 * Kural: **davranış** için rol/metin seçicisi kullan (erişilebilirlik de ondan faydalanır);
 * **düzen** ölçen bir test için buradaki kimliği kullan. Kimlikler tek yerde durur ki testler
 * arasında kopyalanan dizeler olmasın ve renderer ile e2e aynı sabiti paylaşsın.
 *
 * Kimlikler kullanıcıya görünmez ve erişilebilirlik ağacına girmez (`data-*`), bu yüzden
 * üretimde kalmalarının maliyeti yoktur.
 */
export const TEST_IDS = {
  /** Sohbetin kaydırma kabı; dikey çubuk burada, pencere kenarına yakın durur. */
  chatScroll: "chat-scroll",
  /** Sohbet kolonu: transkript, tur çubuğu ve composer aynı hizayı paylaşır. */
  chatColumn: "chat-column",
  /**
   * Composer kutusu. Sohbet kolonuyla **hizasını** karşılaştırmak için işaretlenir: kutu kolonun
   * içinde tam genişlikte durduğu için ikisinin yatay merkezi aynıdır, yani ölçü eşdeğerdir ve
   * kolon sarmalayıcısını (oturum ekranında) ayrıca işaretlemek gerekmez.
   */
  composerBox: "composer-box",
  /** Sohbetin ana alanı (kenar çubuğu ile sağ panel arasında kalan bölge). */
  chatArea: "chat-area",
  /** Yüzen panel (Ortam bilgisi / İlerleme kutuları); sağ üstte mutlak konumda durur. */
  floatPanel: "float-panel",
  /** Kayan panel kabuğu (`SlidePane`); genişliği ölçülür ve kırpma kutusu budur. */
  slidePane: "slide-pane",
  /** Sağ çalışma paneli (sekmeler, terminal, dosyalar, değişiklikler). */
  sidePanel: "side-panel",
  /** Komut ekranı kartı (`/yardım`); arama kutusu ve satırları bu kaptan ölçülür. */
  commandsScreen: "commands-screen",
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/** `data-testid` özniteliği; JSX'te `{...testId(TEST_IDS.chatScroll)}` diye yayılır. */
export function testId(id: TestId): { "data-testid": TestId } {
  return { "data-testid": id };
}
