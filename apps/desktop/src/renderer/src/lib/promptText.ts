import {
  collapsePromptMarkup,
  PROMPT_COMMAND_TAG,
  PROMPT_FILES_TAG,
  quoteBlock,
  stripPromptQuotes,
} from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { parseSlashCommand } from "./slashCommands";

/**
 * Kullanıcının yazdığı metin ile modele giden metin arasındaki köprü. Kısayol komutları
 * (`/plan`, `/interview`, `/ask`, `/debug`, `/audit`, `/init`) talimata, `@dosya` bahisleri okuma listesine
 * genişler; genişleyen kısım etiketli bir bloğa yazılır ki balon, kopyala ve geri sar onu
 * çözüp kullanıcının yazdığını gösterebilsin (ZCode da balonda talimatı değil komut etiketini
 * çizer). Etiketsiz eski kayıtlar da sözlükteki talimat metninden tanınır.
 *
 * Yerleşikler Pi şablonu yapılmadı: Pi `$@` argümanlarını boşlukta bölüp tırnakları soyduğu için
 * çok satırlı istek düzleşirdi; renderer'da genişletmek metni korur.
 */

/** Talimata genişleyen kısayollar: kanonik ad → sözlük anahtarı. */
const SHORTCUT_RULES = {
  plan: "plan",
  interview: "interview",
  ask: "ask",
  debug: "debug",
  audit: "auditStart",
  init: "init",
} as const;

type ShortcutName = keyof typeof SHORTCUT_RULES;

function isShortcut(name: string): name is ShortcutName {
  return Object.hasOwn(SHORTCUT_RULES, name);
}

function ruleText(name: ShortcutName, lang: Locale): string {
  return dict(lang).prompt[SHORTCUT_RULES[name]];
}

/**
 * `@/mutlak/yol` ve `@~/yol` biçimindeki dosya bahisleri; e-posta gibi `@` kullanımları dışarıda
 * kalır. Boşluklu yol tırnakla yazılır (`@"/a/b c.ts"`): tırnaksız bahis ilk boşlukta biter.
 */
const MENTION = /(?:^|\s)@(?:"((?:\/|~\/)[^"\n]+)"|((?:\/|~\/)[^\s]+))/g;

function mentionPath(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? "";
}

/** Yolu bahis yazımına çevirir; boşluk içeren yol tırnaklanır ki tek bahis olarak okunsun. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** Metindeki dosya bahislerinin yolları, geçtikleri sırayla ve tekrarsız. */
export function mentionedPaths(text: string): string[] {
  const paths = [...text.matchAll(MENTION)].map(mentionPath).filter(Boolean);
  return [...new Set(paths)];
}

/**
 * Baştaki kısayol. Adın ardından noktalama gelebilir (`/plan: x`, `/plan, x`); noktalamadan sonra
 * boşluk ya da metin sonu şarttır ki `/plan.md` gibi yollar komut sanılmasın.
 */
function leadingShortcut(text: string): { name: ShortcutName; args: string } | null {
  const match = /^\/([\p{L}\p{N}_-]+)[,.;:!?]*(?=\s|$)/u.exec(text);
  if (!match) return null;
  const name = parseSlashCommand(`/${match[1] ?? ""}`)?.command.name;
  if (!name || !isShortcut(name)) return null;
  return { name, args: text.slice(match[0].length).trim() };
}

/**
 * Okuma listesi eklenebilir mi. Yerel komutun (`/goal hedef`) argümanı metnin geri kalanının
 * tamamıdır; liste eklenseydi argümana karışırdı. Beceri gövdesi argümanı olduğu gibi sona ekler,
 * orada liste zararsızdır.
 */
function takesFileList(text: string): boolean {
  return !parseSlashCommand(text)?.command.action;
}

/**
 * Gönderim metni. Baştaki kısayol talimat bloğuna, bahisler okuma listesine genişler; bahisler
 * metinde de kalır (model hangi dosyanın nerede anıldığını görür, balon onları etiket çizer).
 * Beceri komutu (`/skill:ad`) olduğu gibi geçer; Pi oturum içinde genişletir.
 */
export function expandPrompt(raw: string, lang: Locale = "tr"): string {
  let text = raw.trim();
  const shortcut = leadingShortcut(text);
  if (shortcut) {
    const { name, args } = shortcut;
    const block = `<${PROMPT_COMMAND_TAG} name="${name}">\n${ruleText(name, lang)}\n</${PROMPT_COMMAND_TAG}>`;
    text = args ? `${block}\n\n${args}` : block;
  } else if (!takesFileList(text)) {
    return text;
  }
  // Alıntıdaki `@yol` kullanıcının bahsi değildir; okuma listesine girmez.
  const files = mentionedPaths(stripPromptQuotes(text));
  if (files.length > 0) {
    const list = files.map((f) => `- ${f}`).join("\n");
    const head = dict(lang).prompt.readFirst;
    text = `${text}\n\n<${PROMPT_FILES_TAG}>\n${head}\n${list}\n</${PROMPT_FILES_TAG}>`;
  }
  return text;
}

/**
 * "Yanıtla" alıntılarını metnin sonuna etiketli blok olarak ekler. Yerel komut (`/model`,
 * `/goal hedef`) alıntı almaz: argümanı metnin geri kalanıdır, blok argümana karışırdı.
 */
export function withQuotes(text: string, quotes: readonly string[], lang: Locale = "tr"): string {
  if (quotes.length === 0 || !takesFileList(text)) return text;
  const block = quoteBlock(quotes, dict(lang).prompt.quoteHead);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LOCALES: readonly Locale[] = ["tr", "en"];

/**
 * Etiketsiz eski okuma listesini düşürür: eski biçim bahisleri metinden söküp listeye taşıyordu,
 * yollar geri bahse çevrilir. Etiketli liste `collapsePromptMarkup`'ta düşer.
 */
function stripLegacyFiles(text: string): { text: string; legacy: string[] } {
  for (const lang of LOCALES) {
    const head = escapeRe(dict(lang).prompt.readFirst);
    const legacy = new RegExp(`(?:^|\\n\\n)${head}\\n((?:- [^\\n]+\\n?)+)$`);
    const match = legacy.exec(text);
    if (!match) continue;
    const paths = (match[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^- /, "").trim())
      .filter(Boolean);
    return { text: text.slice(0, match.index), legacy: paths };
  }
  return { text, legacy: [] };
}

/** Etiketsiz eski talimat önekini (sözlükteki kural metni) komut yazımına çevirir. */
function collapseLegacyHead(text: string): string {
  for (const name of Object.keys(SHORTCUT_RULES) as ShortcutName[]) {
    for (const lang of LOCALES) {
      const rule = ruleText(name, lang);
      if (text === rule) return `/${name}`;
      if (text.startsWith(`${rule}\n\n`)) return joinHead(`/${name}`, text.slice(rule.length + 2));
    }
  }
  return text;
}

function joinHead(head: string, rest: string): string {
  const body = rest.trim();
  return body ? `${head} ${body}` : head;
}

/**
 * Modele giden metinden kullanıcının yazdığını geri kurar: balon, kopyala ve geri sar bunu
 * kullanır. `expandPrompt`'un tersidir; tanınmayan metin olduğu gibi döner.
 */
export function collapsePrompt(text: string): string {
  const { text: body, legacy } = stripLegacyFiles(text);
  const head = collapseLegacyHead(collapsePromptMarkup(body).trim());
  if (legacy.length === 0) return head;
  const mentions = legacy.map(mentionText).join(" ");
  return head ? `${head} ${mentions}` : mentions;
}

/** Kullanıcı metninin parçası: düz metin ya da tek birim olarak çizilen etiket. */
export type PromptPart =
  | { kind: "text"; text: string }
  /** Katalog komutu; `value` kanonik yazım (`/plan`). */
  | { kind: "command"; value: string }
  /** Pi becerisi; `value` `/skill:ad`. */
  | { kind: "skill"; name: string; value: string }
  /** Dosya bahsi; `value` yazıldığı gibi (`@yol` ya da boşluklu yolda `@"yol"`). */
  | { kind: "file"; path: string; value: string };

export interface PromptPartsOptions {
  /** Metin mesajın başı mı; değilse (önünde yapıştırma var) baştaki komut aranmaz. Varsayılan açık. */
  head?: boolean;
}

/**
 * Yazılmış metni etiket ve düz metin parçalarına böler. Komut yalnız **mesajın başında**
 * anlamlıdır (çalıştırma kapısı ve Pi ikisi de baştaki komutu okur); bahisler her yerde tanınır.
 */
export function promptParts(raw: string, options: PromptPartsOptions = {}): PromptPart[] {
  const { head = true } = options;
  const parts: PromptPart[] = [];
  let rest = raw;
  const lead = head ? /^(\s*)(\/[^\s]+)/.exec(raw) : null;
  if (lead) {
    const token = lead[2] ?? "";
    const first = headPart(token);
    if (first) {
      if (lead[1]) parts.push({ kind: "text", text: lead[1] });
      parts.push(first);
      rest = raw.slice(lead[0].length);
    }
  }
  let cursor = 0;
  for (const match of rest.matchAll(MENTION)) {
    // Eşleşme baştaki boşluğu da içerebilir; bahis `@` işaretinden başlar (tırnaklıysa tırnak dahil).
    const value = match[0].slice(match[0].indexOf("@"));
    const at = (match.index ?? 0) + match[0].length - value.length;
    if (at > cursor) parts.push({ kind: "text", text: rest.slice(cursor, at) });
    parts.push({ kind: "file", path: mentionPath(match), value });
    cursor = at + value.length;
  }
  if (cursor < rest.length) parts.push({ kind: "text", text: rest.slice(cursor) });
  return parts;
}

/**
 * Metnin ilk `limit` karakterine düşen parçalar (katlanmış önizleme). Düz metin sınırda kesilir,
 * etiket bölünmez: önizleme kesik metinden yeniden ayrıştırılsaydı sınırdaki bahis yarım yolla
 * (`@/a/Butt`) var olmayan dosyayı gösteren etikete dönerdi.
 */
export function clipParts(parts: readonly PromptPart[], limit: number): PromptPart[] {
  const out: PromptPart[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= limit) break;
    const length = part.kind === "text" ? part.text.length : part.value.length;
    if (part.kind === "text" && used + length > limit) {
      out.push({ kind: "text", text: part.text.slice(0, limit - used) });
    } else {
      out.push(part);
    }
    used += length;
  }
  return out;
}

function headPart(token: string): PromptPart | null {
  if (token.startsWith("/skill:")) {
    const name = token.slice("/skill:".length);
    return name ? { kind: "skill", name, value: token } : null;
  }
  const parsed = parseSlashCommand(token);
  if (parsed) return { kind: "command", value: `/${parsed.command.name}` };
  return null;
}
