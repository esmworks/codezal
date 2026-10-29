import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
  type PointType,
} from "lexical";
import { promptParts } from "../../lib/promptText";
import type { PastePart } from "../composerParts";
import { $createTokenNode, $isTokenNode, type TokenKind } from "./tokenNode";

/**
 * Editör içeriği ↔ taslak metni. Taslak (`ComposerDraft.text`) düz metindir: etiketler kendi
 * `value`'larını yazar (`/plan`, `@/yol`, yapıştırma yer tutucusu), satır sonları `\n`. Böylece
 * Composer'ın geri kalanı (yapıştırma parçaları, geçmiş, oturum taslağı) textarea günlerindeki
 * metin modeliyle çalışmaya devam eder.
 */

/** Düğümün taslaktaki metni. */
function nodeText(node: LexicalNode): string {
  if ($isTokenNode(node)) return node.getValue();
  if ($isLineBreakNode(node)) return "\n";
  if ($isTextNode(node)) return node.getTextContent();
  if ($isElementNode(node)) return node.getChildren().map(nodeText).join("");
  return node.getTextContent();
}

/** Kök içeriğinin taslak metni; paragraflar (düz metin eklentisi tek paragraf tutar) `\n` ile birleşir. */
export function $draftText(): string {
  return $getRoot().getChildren().map(nodeText).join("\n");
}

/** Her yaprak düğümün taslak metnindeki aralığı; imleç noktasını metin konumuna çevirmek için. */
function leafSpans(): Map<string, { start: number; end: number; node: LexicalNode }> {
  const spans = new Map<string, { start: number; end: number; node: LexicalNode }>();
  let at = 0;
  $getRoot()
    .getChildren()
    .forEach((block, i) => {
      if (i > 0) at += 1;
      const start = at;
      const walk = (node: LexicalNode) => {
        if ($isElementNode(node) && !$isTokenNode(node)) {
          for (const child of node.getChildren()) walk(child);
          return;
        }
        const len = nodeText(node).length;
        spans.set(node.getKey(), { start: at, end: at + len, node });
        at += len;
      };
      walk(block);
      spans.set(block.getKey(), { start, end: at, node: block });
    });
  return spans;
}

function pointOffset(point: PointType, spans: ReturnType<typeof leafSpans>): number | null {
  const span = spans.get(point.key);
  if (!span) return null;
  if (point.type === "text") {
    // Etiketin içi yoktur: imleç ya önünde ya arkasında sayılır.
    if ($isTokenNode(span.node)) return point.offset > 0 ? span.end : span.start;
    return span.start + point.offset;
  }
  // Eleman noktası: `offset` kaçıncı çocuğun önünde durduğunu söyler.
  const node = span.node;
  if (!$isElementNode(node)) return span.start;
  const children = node.getChildren();
  if (point.offset >= children.length) return span.end;
  const child = children[point.offset];
  return child ? (spans.get(child.getKey())?.start ?? span.start) : span.start;
}

/** Seçimin taslak metnindeki aralığı (geçmiş gezinmesi ve yapıştırma konumu); seçim yoksa null. */
export function $draftSelection(): { start: number; end: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const spans = leafSpans();
  const a = pointOffset(selection.anchor, spans);
  const f = pointOffset(selection.focus, spans);
  if (a === null || f === null) return null;
  return { start: Math.min(a, f), end: Math.max(a, f) };
}

/** Düz metni satır sonlarıyla düğümlere çevirir. */
function textNodes(text: string): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push($createLineBreakNode());
    if (line) nodes.push($createTextNode(line));
  });
  return nodes;
}

const KIND_OF: Record<string, TokenKind> = {
  command: "command",
  skill: "skill",
  file: "file",
};

/** Metin parçasını etiket + metin düğümlerine çevirir; baştaki komut yalnız `head` açıkken tanınır. */
function segmentNodes(text: string, head: boolean): LexicalNode[] {
  // Parçanın başı mesajın başı değilse (önünde yapıştırma var) komut tanınmaz: komut yalnız
  // mesajın başında çalışır, ortada etiket olursa kullanıcıyı yanıltır.
  const nodes: LexicalNode[] = [];
  for (const part of promptParts(text, { head })) {
    if (part.kind === "text") {
      nodes.push(...textNodes(part.text));
      continue;
    }
    const kind = KIND_OF[part.kind];
    if (kind) nodes.push($createTokenNode(kind, part.value));
  }
  return nodes;
}

/**
 * Taslağı editöre yazar: yapıştırma yer tutucuları, baştaki komut/beceri ve `@dosya` bahisleri
 * etikete döner, kalanı düz metin olur. İmleç sona konur.
 */
export function $writeDraft(text: string, pastes: readonly PastePart[] = []): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  // Yalnız yeri tutan parçalar etiket olur; kaymış parça metin olarak kalır (syncDraft düşürür).
  const valid = [...pastes]
    .filter((p) => text.slice(p.start, p.end) === p.placeholder)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const part of valid) {
    if (part.start < cursor) continue;
    if (part.start > cursor)
      paragraph.append(...segmentNodes(text.slice(cursor, part.start), cursor === 0));
    paragraph.append($createTokenNode("paste", part.placeholder));
    cursor = part.end;
  }
  if (cursor < text.length) paragraph.append(...segmentNodes(text.slice(cursor), cursor === 0));
  root.append(paragraph);
  paragraph.selectEnd();
}
