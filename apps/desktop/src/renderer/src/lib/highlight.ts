import {
  createHighlighterCore,
  type DynamicImportLanguageRegistration,
  type HighlighterCore,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

/**
 * Shiki sözdizimi vurgulayıcı. Çekirdek + JS regex motoru (WASM yok); diller uzantıya göre
 * tembel yüklenir. Codex ve VS Code ile aynı TextMate gramer ailesi.
 */

/**
 * Kod renkleri One Dark ailesinden: anahtar sözcükler mor, dizeler yeşil, sayılar turuncu,
 * yorumlar gri. `vitesse-*` paleti bilinçli olarak düşük doygunlukluydu; diff panellerinde
 * (ZCode ve MiniMax Code'un Review görünümü gibi) renkler pastel kalıyordu.
 */
export const THEME_LIGHT = "one-light";
export const THEME_DARK = "one-dark-pro";

/** Bu boyutun üstünde vurgulama yapılmaz; düz metin gösterilir. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

export interface Token {
  text: string;
  /** Tema ön rengiyle aynıysa boş bırakılır; metin `--tx2`'den miras alır. */
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  svg: "xml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  prisma: "prisma",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  env: "dotenv",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  dart: "dart",
  zig: "zig",
  tf: "terraform",
  proto: "proto",
  csv: "csv",
};

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".env": "dotenv",
  ".gitignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/** Sohbetteki çit dili için takma adlar (```ts, ```sh vb.). */
const FENCE_ALIAS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  dockerfile: "dockerfile",
  text: "",
  txt: "",
  plain: "",
  plaintext: "",
};

// Anahtarı serbest metin (uzantı/çit) olarak arayabilmek için geniş tipe daralt
const LANGS: Record<string, DynamicImportLanguageRegistration> = bundledLanguages;

function isBundled(lang: string): boolean {
  return Object.hasOwn(LANGS, lang);
}

/** Dosya yolundan Shiki dil kimliği; bilinmiyorsa null. */
export function langForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = FILENAME_TO_LANG[name];
  if (byName) return byName;
  if (name.startsWith(".env")) return "dotenv";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const lang = EXT_TO_LANG[name.slice(dot + 1)];
  return lang && isBundled(lang) ? lang : null;
}

/** Markdown çit dilinden Shiki dil kimliği; bilinmiyorsa null. */
export function langForFence(fence: string): string | null {
  const key = fence.trim().toLowerCase();
  if (!key) return null;
  const alias = FENCE_ALIAS[key];
  if (alias === "") return null;
  const lang = alias ?? key;
  return isBundled(lang) ? lang : null;
}

let corePromise: Promise<HighlighterCore> | null = null;
const langLoads = new Map<string, Promise<void>>();

function core(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = createHighlighterCore({
      themes: [bundledThemes[THEME_LIGHT], bundledThemes[THEME_DARK]],
      langs: [],
      // forgiving: JS motorunun desteklemediği nadir regex'lerde hata yerine düz eşleşme
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return corePromise;
}

async function ensureLang(hl: HighlighterCore, lang: string): Promise<void> {
  if (hl.getLoadedLanguages().includes(lang)) return;
  const reg = LANGS[lang];
  if (!reg) throw new Error(`bilinmeyen dil: ${lang}`);
  let p = langLoads.get(lang);
  if (!p) {
    p = hl.loadLanguage(reg).finally(() => langLoads.delete(lang));
    langLoads.set(lang, p);
  }
  await p;
}

// Shiki FontStyle bit maskesi: Italic=1, Bold=2
const ITALIC = 1;
const BOLD = 2;

function toTokens(lines: ThemedToken[][], fg: string): Token[][] {
  const fgLower = fg.toLowerCase();
  return lines.map((line) =>
    line.map((t) => {
      const style = typeof t.fontStyle === "number" ? t.fontStyle : 0;
      const tok: Token = { text: t.content };
      if (t.color && t.color.toLowerCase() !== fgLower) tok.color = t.color;
      if (style & ITALIC) tok.italic = true;
      if (style & BOLD) tok.bold = true;
      return tok;
    }),
  );
}

/** Kodu satır satır belirteçlere ayır. Dil yüklenemezse veya kod çok büyükse null. */
export async function highlight(
  code: string,
  lang: string,
  light: boolean,
): Promise<Token[][] | null> {
  if (code.length > HIGHLIGHT_MAX_CHARS) return null;
  try {
    const hl = await core();
    await ensureLang(hl, lang);
    const theme = light ? THEME_LIGHT : THEME_DARK;
    const fg = hl.getTheme(theme).fg;
    return toTokens(hl.codeToTokensBase(code, { lang, theme }), fg);
  } catch {
    return null;
  }
}
