import { acceleratorKeys } from "@codezal/contracts";

/**
 * Kısayol gösterimi. Hızlandırıcılar ABD düzenine göre tanımlıdır; aynı fiziksel tuş kullanıcının
 * düzeninde başka karakter üretir (Türkçe Q'da Ayarlar ⌘, değil ⌘Ö'dür). `layout`
 * (`navigator.keyboard.getLayoutMap()`) verilirse harf oradan çözülür, yoksa ABD karşılığı kalır.
 */

/** Noktalama tuşlarının `KeyboardEvent.code` karşılığı; harf ve rakam kalıba göre türetilir. */
const CODES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

export function codeFor(key: string): string | undefined {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return CODES[key];
}

export type Layout = ReadonlyMap<string, string> | null;

/** "CmdOrCtrl+Shift+G" → ["⌘", "⇧", "G"] (macOS) ya da ["Ctrl", "Shift", "G"]. */
export function shortcutKeys(accelerator: string, mac: boolean, layout: Layout): string[] {
  return acceleratorKeys(accelerator, mac).map((key) => {
    const code = codeFor(key);
    const local = code ? layout?.get(code) : undefined;
    return local ? local.toUpperCase() : key;
  });
}

/** Menü ve ipucu metinlerindeki tek satırlık gösterim: macOS "⌘N", diğerlerinde "Ctrl+N". */
export function shortcutHint(accelerator: string, mac: boolean, layout: Layout): string {
  const keys = shortcutKeys(accelerator, mac, layout);
  return mac ? keys.join("") : keys.join("+");
}

/** Electron hızlandırıcısında "+" ayırıcıdır; tuş adı "Plus" olarak yazılır. */
const NAMED_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Escape",
};

function keyNameOf(key: string): string | null {
  if (key === "+") return "Plus";
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toUpperCase() : key;
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  return /^F([1-9]|1[0-2])$/.test(key) ? key : null;
}

/**
 * Tuş olayından Electron hızlandırıcısı üretir ("CmdOrCtrl+Shift+M"). En az bir birincil tuş
 * (macOS'ta ⌘, diğerlerinde Ctrl) ya da Alt şarttır: tek harflik kısayol yazı yazmayı engeller.
 * Yalnız modifier ya da tanınmayan tuşta `null` döner.
 */
export function acceleratorFromEvent(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  mac: boolean,
): string | null {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "AltGraph"].includes(event.key)) {
    return null;
  }
  const primary = mac ? event.metaKey : event.ctrlKey;
  if (!primary && !event.altKey) return null;
  const key = keyNameOf(event.key);
  if (!key) return null;
  const parts: string[] = [];
  if (primary) parts.push("CmdOrCtrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Çakışan komutu bulur: aynı hızlandırıcı başka bir komuta atanmışsa onu döndürür. */
export function findConflict(
  command: string,
  accelerator: string,
  resolved: ReadonlyArray<{ command: string; accelerator: string }>,
): string | undefined {
  return resolved.find((entry) => entry.command !== command && entry.accelerator === accelerator)
    ?.command;
}
