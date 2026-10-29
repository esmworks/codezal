import {
  type ModelRef,
  type PermissionMode,
  parseModelLabel,
  type ThinkingLevel,
} from "@codezal/contracts";
import { dict, type TranslationKey } from "@codezal/i18n";
import type { TFunction } from "i18next";
import type { IconName } from "../icons";
import type { SlashSuggestion } from "./slashSearch";

/**
 * Yerel komut kataloğu (ZCode'un yerleşik slash komutları). Panel, komut ekranı ve çalıştırma
 * kapısı hep buradan okur: bir komut eklemek için tek yer değişir, üç yüzey kendiliğinden uyar.
 *
 * Ad kuralı ZCode'daki gibidir: görünen ve yazılan ad **kanonik ASCII addır** (`/help`,
 * `/effort`); açıklamalar arayüz dilinden gelir. Alışılmış Türkçe yazımlar (`/yardım`,
 * `/düşünme`) sözlükten takma ad olarak okunur: yazılırsa aynı komuta çözülür ama listede
 * görünmez — iki dilin adları yan yana listelenince katalog okunmaz oluyordu.
 */
export interface SlashCommand {
  /** Kanonik ad, "/" olmadan ve küçük harf; dilden bağımsız anahtar. */
  name: string;
  /** ASCII takma adlar (ZCode'un `aliases` alanı gibi); dile göre adlar ayrıca sözlükten eklenir. */
  aliases: readonly string[];
  icon: IconName;
  color: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  /** Sözlükteki Türkçe/İngilizce takma yazım (`commands.name.help` → "yardım"); yalnız çözümleme için. */
  aliasKey?: TranslationKey;
  /** Argüman ipucunun çevrilmemiş (ASCII) hâli: `[low|high|max]`. */
  argHint?: string;
  /** Argüman ipucu çeviri gerektiriyorsa (`sağlayıcı/model`) sözlük anahtarı. */
  argHintKey?: TranslationKey;
  /**
   * Yerel eylem mi (ekran açar, ayar değiştirir; modele hiç gitmez), istem kısayolu mu (taslağa
   * yazılır, gönderimde talimata genişler — ZCode'un `/plan` kısayolu gibi).
   */
  action: boolean;
  /**
   * Komut ancak argümanla anlamlı (ör. `/goal`): `/` panelinde seçilince hemen çalışmaz, komut
   * taslakta kalır ki kullanıcı argümanını yazsın. Argümansız çağrısı da bir şey yapan komutlar
   * (`/model` seçiciyi açar, `/yardım` ekranı açar) bu bayrağı taşımaz.
   */
  takesArgs?: boolean;
  /** Yalnız açık bir oturumda çalışır (hedef, sıkıştırma, yeni görev); giriş ekranında listelenmez. */
  sessionOnly?: boolean;
  /** Yalnız bu modda listelenir; verilmezse her modda görünür. */
  onlyIn?: "kodlama";
}

/**
 * Sıra kullanıcının gördüğü sıradır: önce sohbeti başlatan kısayollar, sonra oturumu yöneten
 * eylemler (ZCode da kataloğu bu mantıkla dizer). Metinler sözlükten gelir; burada yalnız anahtar.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "plan",
    aliases: [],
    icon: "list",
    color: "text-tx2",
    labelKey: "chips.planLabel",
    descKey: "chips.planDesc",
    argHintKey: "commands.argHint.task",
    action: false,
  },
  {
    name: "interview",
    aliases: [],
    aliasKey: "commands.name.interview",
    icon: "chat",
    color: "text-tx2",
    labelKey: "chips.interviewLabel",
    descKey: "chips.interviewDesc",
    argHintKey: "commands.argHint.task",
    action: false,
  },
  {
    name: "ask",
    aliases: [],
    aliasKey: "commands.name.ask",
    icon: "question",
    color: "text-green",
    labelKey: "chips.askLabel",
    descKey: "chips.askDesc",
    argHintKey: "commands.argHint.question",
    action: false,
  },
  {
    name: "debug",
    aliases: [],
    icon: "bug",
    color: "text-red",
    labelKey: "chips.debugLabel",
    descKey: "chips.debugDesc",
    argHintKey: "commands.argHint.problem",
    action: false,
    onlyIn: "kodlama",
  },
  {
    name: "audit",
    aliases: [],
    aliasKey: "commands.name.audit",
    icon: "shield",
    color: "text-tx2",
    labelKey: "chips.auditLabel",
    descKey: "chips.auditDesc",
    argHintKey: "commands.argHint.scope",
    action: false,
    onlyIn: "kodlama",
  },
  {
    name: "goal",
    aliases: [],
    icon: "loop",
    color: "text-amber",
    labelKey: "chips.goalLabel",
    descKey: "chips.goalDesc",
    argHintKey: "commands.argHint.goal",
    action: true,
    takesArgs: true,
    sessionOnly: true,
  },
  {
    name: "init",
    // Eski gönderim `/talimat`'ı da init talimatına genişletiyordu; yazan kullanıcı kırılmasın.
    aliases: ["talimat"],
    icon: "docs",
    color: "text-tx2",
    labelKey: "commands.initLabel",
    descKey: "commands.initDesc",
    argHintKey: "commands.argHint.note",
    action: false,
  },
  {
    name: "help",
    aliases: [],
    aliasKey: "commands.name.help",
    icon: "info",
    color: "text-tx2",
    labelKey: "commands.helpLabel",
    descKey: "commands.helpDesc",
    argHintKey: "commands.argHint.command",
    action: true,
  },
  {
    name: "model",
    aliases: [],
    icon: "code",
    color: "text-tx2",
    labelKey: "commands.modelLabel",
    descKey: "commands.modelDesc",
    argHintKey: "commands.argHint.model",
    action: true,
  },
  {
    name: "mode",
    aliases: [],
    aliasKey: "commands.name.mode",
    icon: "permAsk",
    color: "text-tx2",
    labelKey: "commands.modeLabel",
    descKey: "commands.modeDesc",
    argHint: "[ask|auto-edit|plan|full]",
    action: true,
  },
  {
    name: "effort",
    aliases: [],
    aliasKey: "commands.name.effort",
    icon: "brain",
    color: "text-tx2",
    labelKey: "commands.effortLabel",
    descKey: "commands.effortDesc",
    argHint: "[low|high|max]",
    action: true,
  },
  {
    name: "compact",
    aliases: [],
    icon: "collapse",
    color: "text-tx2",
    labelKey: "chips.compactLabel",
    descKey: "chips.compactDesc",
    action: true,
    sessionOnly: true,
  },
  {
    name: "skill",
    aliases: [],
    aliasKey: "commands.name.skill",
    icon: "sparkle",
    color: "text-tx2",
    labelKey: "commands.skillLabel",
    descKey: "commands.skillDesc",
    action: true,
  },
  {
    name: "mcp",
    aliases: [],
    icon: "mcp",
    color: "text-tx2",
    labelKey: "commands.mcpLabel",
    descKey: "commands.mcpDesc",
    action: true,
  },
  {
    name: "new",
    aliases: [],
    aliasKey: "commands.name.new",
    icon: "plusCircle",
    color: "text-tx2",
    labelKey: "commands.newLabel",
    descKey: "commands.newDesc",
    action: true,
    sessionOnly: true,
  },
  {
    name: "resume",
    aliases: [],
    aliasKey: "commands.name.resume",
    icon: "clock",
    color: "text-tx2",
    labelKey: "commands.resumeLabel",
    descKey: "commands.resumeDesc",
    action: true,
  },
];

/**
 * Karşılaştırma için katlanmış adaylar. İki katlama birlikte denenir çünkü komut adları iki
 * alfabeyle yazılabilir: `toLowerCase()` "YARDIM"ı "yardim" yapar (dokunulmamış I), Türkçe
 * küçültme ise "INIT"i "ınıt" yapar. İkisini birden denemek her iki yazımı da yakalar.
 */
function foldVariants(value: string): string[] {
  const trimmed = value.trim();
  const ascii = trimmed.toLowerCase();
  const turkish = trimmed.toLocaleLowerCase("tr");
  return ascii === turkish ? [ascii] : [ascii, turkish];
}

/** İki yazım katlamadan sonra aynı mı (büyük/küçük harf ve Türkçe "I/ı" ayrımı gözetilmez). */
function sameFold(a: string, b: string): boolean {
  return foldVariants(a).some((variant) => foldVariants(b).includes(variant));
}

/**
 * Ad indeksi: kanonik adlar, ASCII takma adlar ve **iki dilin** takma yazımları (sözlükten).
 * Takma yazımlar indekse girer ki alışılmış komut çalışmaya devam etsin (`/yardım` ve `/help`
 * her zaman aynı komuta çözülür).
 */
function commandIndex(): Map<string, SlashCommand> {
  const index = new Map<string, SlashCommand>();
  const tr = dict("tr").commands.name;
  const en = dict("en").commands.name;
  const add = (spelling: string, command: SlashCommand) => {
    for (const variant of foldVariants(spelling)) index.set(variant, command);
  };
  for (const command of SLASH_COMMANDS) {
    add(command.name, command);
    for (const alias of command.aliases) add(alias, command);
    if (!command.aliasKey) continue;
    const key = command.aliasKey.split(".").pop() ?? "";
    const names = [tr[key as keyof typeof tr], en[key as keyof typeof en]];
    for (const spelling of names) if (spelling) add(spelling, command);
  }
  return index;
}

const BY_NAME = commandIndex();

export interface ParsedSlash {
  command: SlashCommand;
  /** Kullanıcının yazdığı ad (takma ad çözülmemiş hâli). */
  typed: string;
  /** Komuttan sonraki metin, kırpılmış; argüman yoksa boş dize. */
  args: string;
}

/** Yazımı komuta çözer; hiçbir katlama eşleşmezse `null`. */
function lookup(typed: string): SlashCommand | null {
  for (const variant of foldVariants(typed)) {
    const command = BY_NAME.get(variant);
    if (command) return command;
  }
  return null;
}

/**
 * Metni komuta çözer. Yalnız **tamamı** `/ad [argüman]` biçiminde olan metin komuttur: cümle
 * içinde geçen eğik çizgi (ör. "şu /yolu oku") istem metnidir ve modele gider. Bilinmeyen ad
 * `null` döner; çağıran onu normal istem olarak teslim eder (Pi `/skill:ad` gibi kendi
 * komutlarını oturum içinde genişletir).
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const typed = match[1] ?? "";
  const command = lookup(typed);
  if (!command) return null;
  return { command, typed, args: (match[2] ?? "").trim() };
}

/**
 * `/` panelinde seçilince komut hemen mi çalışır? Yerel eylemler ve argüman istemeyenler evet:
 * ZCode da kataloğundaki yerel komutları seçimde çalıştırır, taslağa yazmaz. Argüman isteyenler
 * (`/goal`, `/model`) ve istem kısayolları taslakta kalır — kullanıcı argümanını yazacak.
 */
export function runOnPick(command: SlashCommand): boolean {
  return command.action && !command.takesArgs;
}

/** İzin modu argümanı: Codezal kimlikleri, ZCode'un adları (build/edit/yolo) ve iki dilin görünen adı. */
const ZCODE_MODE_ARGS: Record<string, PermissionMode> = {
  build: "ask",
  edit: "auto-edit",
  yolo: "full",
};

const MODE_IDS: readonly PermissionMode[] = ["ask", "auto-edit", "plan", "full"];
const THINKING_IDS: readonly ThinkingLevel[] = ["low", "high", "max"];

/**
 * Argümanı seçenek kimliğine çözer. Kabul edilen yazımlar: kimliğin kendisi (`plan`, `high`),
 * ZCode'un adı (`build`, `yolo`) ve **arayüzde görünen ad** — çipte "Yüksek" okuyan kullanıcı
 * `/effort Yüksek` yazabilir. Görünen adlar sözlükten okunur, kodda çevrilmiş metin durmaz.
 */
function resolveArg<T extends string>(
  arg: string,
  ids: readonly T[],
  /** Kimliğin iki dildeki görünen adı (sözlükten). */
  shown: (id: T) => [string, string],
  /** Kimlik dışında kabul edilen ASCII yazımlar (ZCode'un adları). */
  extra: Record<string, T> = {},
): T | null {
  const needle = arg.trim();
  if (!needle) return null;
  for (const [spelling, value] of Object.entries(extra)) {
    if (sameFold(needle, spelling)) return value;
  }
  for (const id of ids) {
    if (sameFold(needle, id)) return id;
    const [tr, en] = shown(id);
    if (sameFold(tr, needle) || sameFold(en, needle)) return id;
  }
  return null;
}

export function permissionArg(arg: string): PermissionMode | null {
  return resolveArg(
    arg,
    MODE_IDS,
    (id) => [dict("tr").permissionMode[id], dict("en").permissionMode[id]],
    ZCODE_MODE_ARGS,
  );
}

export function thinkingArg(arg: string): ThinkingLevel | null {
  return resolveArg(arg, THINKING_IDS, (id) => [
    dict("tr").thinkingLevel[id],
    dict("en").thinkingLevel[id],
  ]);
}

/** Model argümanı: "sağlayıcı/kimlik"; ayraç yoksa çözülemez (katalogda aranacak ad değil). */
export function modelArg(arg: string): ModelRef | null {
  const ref = parseModelLabel(arg.trim());
  return ref ? { provider: ref.provider, id: ref.id } : null;
}

/** Komutun kullanıcıya görünen adı: her dilde kanonik ad (ZCode gibi `/effort`, `/help`). */
export function commandName(command: SlashCommand): string {
  return command.name;
}

/** Kullanım satırı: görünen ad + argüman ipucu (ZCode'un `inputHint` alanı). */
export function usageOf(command: SlashCommand, t: TFunction): string {
  const name = `/${commandName(command)}`;
  const hint = command.argHintKey ? t(command.argHintKey) : command.argHint;
  return hint ? `${name} ${hint}` : name;
}

/**
 * Argüman alan komutların geçerli değerleri (kullanıcının yazacağı kimlikler). Komut ekranı
 * bunları listeler; kabul edilen takma adlar (`build`, `yolo`, görünen adlar) ekranda yazılmaz —
 * aksi hâlde satır okunmaz hâle geliyordu.
 */
export function allowedArgs(command: SlashCommand): string[] {
  if (command.name === "mode") return [...MODE_IDS];
  if (command.name === "effort") return [...THINKING_IDS];
  return [];
}

/** Komutun kullanım satırı + geçerli değerleri (komut ekranındaki satır). */
export function usageLine(command: SlashCommand, t: TFunction): string {
  const values = allowedArgs(command);
  const usage = usageOf(command, t);
  return values.length > 0 ? `${usage}  ·  ${values.join(" | ")}` : usage;
}

/** Komutun takma yazımları: ASCII takma adlar + iki dilin sözlükteki yazımı (`yardım`, `help`). */
function aliasSpellings(command: SlashCommand): string[] {
  const spellings = [...command.aliases];
  if (command.aliasKey) {
    const key = command.aliasKey.split(".").pop() ?? "";
    const tr = dict("tr").commands.name;
    const en = dict("en").commands.name;
    for (const spelling of [tr[key as keyof typeof tr], en[key as keyof typeof en]]) {
      if (spelling && spelling !== command.name) spellings.push(spelling);
    }
  }
  return spellings;
}

/**
 * Katalogdan `/` paneli satırları. `mode` kapısı yalnız kod odaklı komutları süzer (debug,
 * audit); `hasSession` kapalıyken (giriş ekranları) oturum isteyen komutlar düşer — hedef,
 * sıkıştırma ve yeni görev orada çalışamaz. Satırda ZCode'daki gibi yalnız `/ad` ve açıklama
 * görünür; eski Türkçe etiket ("Planla") ve takma adlar aramaya anahtar kelime olarak girer.
 */
export function commandSuggestions(
  t: TFunction,
  mode: string,
  hasSession: boolean,
): SlashSuggestion[] {
  return SLASH_COMMANDS.filter(
    (c) => (!c.onlyIn || c.onlyIn === mode) && (!c.sessionOnly || hasSession),
  ).map((c) => ({
    id: `command:${c.name}`,
    kind: "command",
    value: `/${c.name}`,
    label: `/${c.name}`,
    description: t(c.descKey),
    keywords: [t(c.labelKey), ...aliasSpellings(c)],
    icon: c.icon,
    runOnPick: runOnPick(c),
  }));
}
