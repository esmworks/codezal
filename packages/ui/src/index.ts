/** Tasarımdaki renk token adları. tokens.css ile aynı sırada tutulur; testler bunu doğrular. */
export const TOKEN_NAMES = [
  "bg",
  "bg2",
  "card",
  "card2",
  "line",
  "line2",
  "tx",
  "tx2",
  "tx3",
  "acc",
  "accTx",
  "accSoft",
  "accLine",
  "onAcc",
  "green",
  "red",
  "amber",
  "link",
  "linkHov",
  "hov",
  "chip",
  "tray",
  "shHome",
  "scrollThumb",
  "scrollThumbHov",
  "sh",
  "sel",
  "selHov",
  "selSh",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

export const THEME_ATTR = "data-cz-light";

export type Theme = "koyu" | "açık" | "sistem";

export function applyTheme(theme: Theme, prefersLight = false): void {
  const light = theme === "açık" || (theme === "sistem" && prefersLight);
  document.body.toggleAttribute(THEME_ATTR, light);
}
