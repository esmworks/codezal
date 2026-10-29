import {
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from "lexical";
import { ICONS, type IconName } from "../../icons";

/**
 * Yazma kutusundaki tek birimlik etiketler (ZCode'un `PromptMentionNode`'u gibi): komut,
 * beceri, dosya bahsi ve uzun yapıştırma. Ekranda kısa ad görünür (`Plan`,
 * `tdd-mastery`, `a.ts`), taslağa ve modele `value` gider (`/plan`, `/skill:tdd-mastery`,
 * `@/yol/a.ts`, yapıştırma yer tutucusu). "token" kipinde olduğu için tek Backspace ile silinir,
 * imleç içine giremez.
 */
export type TokenKind = "command" | "skill" | "file" | "paste";

const ICON_OF: Record<TokenKind, IconName> = {
  command: "terminal",
  skill: "sparkle",
  file: "file",
  paste: "clip",
};

/** Komutlara özel simgeler: kısayolun kataloğundaki simgesi etikette de görünsün. */
const COMMAND_ICONS: Record<string, IconName> = {
  "/plan": "list",
  "/ask": "question",
  "/debug": "bug",
  "/audit": "shield",
  "/goal": "loop",
  "/init": "docs",
  "/compact": "collapse",
};

function iconFor(kind: TokenKind, value: string): IconName {
  return (kind === "command" ? COMMAND_ICONS[value] : undefined) ?? ICON_OF[kind];
}

/**
 * Simge CSS maskesi olarak çizilir: TextNode'un DOM'unda ilk çocuk metin olmalı (Lexical seçimi
 * oradan okur), araya eleman eklenirse imleç bozulur. Aynı yol ZCode'da da seçilmiş.
 */
const maskCache = new Map<IconName, string>();
function iconMask(name: IconName): string {
  const cached = maskCache.get(name);
  if (cached) return cached;
  const shapes = ICONS[name]
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs).map(([k, v]) => `${k}="${String(v)}"`);
      return `<${tag} ${pairs.join(" ")}/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  maskCache.set(name, url);
  return url;
}

/** Etikette görünen kısa ad. */
export function tokenLabel(kind: TokenKind, value: string): string {
  if (kind === "command") return value.replace(/^\/+/, "");
  if (kind === "skill") return value.replace(/^\/skill:/, "");
  if (kind === "file") {
    const path = value.replace(/^@"?|"$/g, "").replace(/\/+$/, "");
    return path.slice(path.lastIndexOf("/") + 1) || path;
  }
  // Yapıştırma yer tutucusu köşeli parantezle gelir; etikette parantez gürültü.
  return value.replace(/^\[|\]$/g, "");
}

type SerializedTokenNode = Spread<{ kind: TokenKind; value: string }, SerializedTextNode>;

export class TokenNode extends TextNode {
  __kind: TokenKind;
  __value: string;

  static override getType(): string {
    return "codezal-token";
  }

  static override clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__kind, node.__value, node.__text, node.__key);
  }

  static override importJSON(json: SerializedTokenNode): TokenNode {
    return $createTokenNode(json.kind, json.value);
  }

  constructor(kind: TokenKind, value: string, label?: string, key?: NodeKey) {
    super(label ?? tokenLabel(kind, value), key);
    this.__kind = kind;
    this.__value = value;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    decorate(dom, this.__kind, this.__value);
    return dom;
  }

  override updateDOM(prev: this, dom: HTMLElement, config: EditorConfig): boolean {
    const changed = super.updateDOM(prev, dom, config);
    if (prev.__kind !== this.__kind || prev.__value !== this.__value)
      decorate(dom, this.__kind, this.__value);
    return changed;
  }

  override exportJSON(): SerializedTokenNode {
    return { ...super.exportJSON(), type: "codezal-token", kind: this.__kind, value: this.__value };
  }

  /** Taslağa ve modele giden metin. */
  getValue(): string {
    return this.getLatest().__value;
  }

  getKind(): TokenKind {
    return this.getLatest().__kind;
  }

  override isTextEntity(): true {
    return true;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }
}

/** Etiketin simge maskesi (`--cz-token-icon`); sohbet balonundaki etiketler de aynısını çizer. */
export function tokenIcon(kind: TokenKind, value: string): string {
  return iconMask(iconFor(kind, value));
}

function decorate(dom: HTMLElement, kind: TokenKind, value: string): void {
  dom.className = "cz-token";
  dom.dataset.token = kind;
  dom.spellcheck = false;
  dom.title = value;
  dom.style.setProperty("--cz-token-icon", tokenIcon(kind, value));
}

export function $createTokenNode(kind: TokenKind, value: string): TokenNode {
  const node = new TokenNode(kind, value);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isTokenNode(node: LexicalNode | null | undefined): node is TokenNode {
  return node instanceof TokenNode;
}
