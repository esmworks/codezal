import { $getRoot, createEditor, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import type { PastePart } from "../composerParts";
import { $draftSelection, $draftText, $writeDraft } from "./draftText";
import { $isTokenNode, TokenNode, tokenLabel } from "./tokenNode";

/** DOM'suz editör: düğüm ağacı ve seçim yine çalışır, yalnız çizim yoktur. */
function editor(): LexicalEditor {
  return createEditor({
    namespace: "test",
    nodes: [TokenNode],
    onError: (error) => {
      throw error;
    },
  });
}

function write(ed: LexicalEditor, text: string, pastes: readonly PastePart[] = []) {
  ed.update(() => $writeDraft(text, pastes), { discrete: true });
}

/** Paragraftaki düğümler: etiketler `[tür:değer]`, metin olduğu gibi. */
function shape(ed: LexicalEditor): string[] {
  return ed.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .map((n) => ($isTokenNode(n) ? `[${n.getKind()}:${n.getValue()}]` : n.getTextContent())),
  );
}

describe("taslak ↔ editör", () => {
  it("baştaki komut ve bahisler etikete döner, metin değerlerle geri okunur", () => {
    const ed = editor();
    const text = "/plan şunu @/a/b.ts ile yap";
    write(ed, text);
    expect(shape(ed)).toEqual(["[command:/plan]", " şunu ", "[file:@/a/b.ts]", " ile yap"]);
    expect(ed.getEditorState().read($draftText)).toBe(text);
  });

  it("satır sonları korunur", () => {
    const ed = editor();
    write(ed, "bir\n\niki");
    expect(ed.getEditorState().read($draftText)).toBe("bir\n\niki");
  });

  it("yapıştırma yer tutucusu etiket olur; önündeki yapıştırmadan sonra komut tanınmaz", () => {
    const ed = editor();
    const placeholder = "Yapıştırıldı ~12 satır";
    const text = `${placeholder} /plan`;
    write(ed, text, [{ id: "p1", start: 0, end: placeholder.length, placeholder, text: "x" }]);
    expect(shape(ed)).toEqual([`[paste:${placeholder}]`, " /plan"]);
    expect(ed.getEditorState().read($draftText)).toBe(text);
  });

  it("imleç sona konur; seçim taslak metnindeki konumdur", () => {
    const ed = editor();
    write(ed, "/ask neden");
    const range = ed.getEditorState().read($draftSelection);
    expect(range).toEqual({ start: 10, end: 10 });
  });

  it("etiketin görünen adı kısadır", () => {
    expect(tokenLabel("command", "/plan")).toBe("plan");
    expect(tokenLabel("skill", "/skill:tdd")).toBe("tdd");
    expect(tokenLabel("file", "@/a/b/c.ts")).toBe("c.ts");
    expect(tokenLabel("file", "@/a/klasor/")).toBe("klasor");
    expect(tokenLabel("file", '@"/a/My Project/b c.ts"')).toBe("b c.ts");
    expect(tokenLabel("paste", "[Yapıştırıldı ~3 satır]")).toBe("Yapıştırıldı ~3 satır");
  });
});
