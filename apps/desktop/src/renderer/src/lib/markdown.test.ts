import { describe, expect, it } from "vitest";
import { blocksText, type Inline, parseInline, parseMarkdown } from "./markdown";

const text = (nodes: readonly Inline[]): string =>
  nodes
    .map((n) => {
      if (n.kind === "text" || n.kind === "code") return n.text;
      if (n.kind === "br") return "\n";
      return text(n.children);
    })
    .join("");

describe("parseInline", () => {
  it("Word önizlemesindeki izli değişiklik ve yorum işaretlerini ayırır", () => {
    const nodes = parseInline(
      "Fiyat {--100--}{++120 **TL**++} ve {==vade==}{>>Ayşe: 30 gün<<} ile {>>Ali: not<<}",
    );
    expect(nodes.map((n) => n.kind)).toEqual([
      "text",
      "removed",
      "ins",
      "text",
      "comment",
      "text",
      "comment",
    ]);
    const ins = nodes[2];
    expect(ins?.kind === "ins" && ins.children.some((c) => c.kind === "bold")).toBe(true);
    const comment = nodes[4];
    expect(comment?.kind === "comment" && comment.note).toBe("Ayşe: 30 gün");
    expect(text(nodes)).toBe("Fiyat 100120 TL ve vade ile ");
    // Kod içindeki işaretler dokunulmadan kalır.
    expect(parseInline("`{++x++}`").map((n) => n.kind)).toEqual(["code"]);
  });

  it("kod, kalın, eğik, üstü çizili ve bağlantıyı ayırır; kod içindeki yıldızlara dokunmaz", () => {
    const nodes = parseInline("a `x**y**` **kalın _iç_** ~~sil~~ [Pi](https://pi.dev) *e*");
    expect(nodes.map((n) => n.kind)).toEqual([
      "text",
      "code",
      "text",
      "bold",
      "text",
      "del",
      "text",
      "link",
      "text",
      "em",
    ]);
    const bold = nodes[3];
    expect(bold?.kind === "bold" && bold.children.some((c) => c.kind === "em")).toBe(true);
    const link = nodes[7];
    expect(link?.kind === "link" ? link.href : "").toBe("https://pi.dev");
  });

  it("snake_case ve çarpma işaretlerini eğik sanmaz, çıplak URL'yi bağlantı yapar", () => {
    expect(parseInline("api_key_name 2*3*4").every((n) => n.kind === "text")).toBe(true);
    const nodes = parseInline("bkz https://example.com/a?b=1.");
    expect(nodes[1]).toMatchObject({ kind: "link", href: "https://example.com/a?b=1" });
    expect(nodes[2]).toMatchObject({ kind: "text", text: "." });
  });
});

describe("parseMarkdown", () => {
  it("tabloyu hizalamayla ayrıştırır, eksik hücreyi doldurur, boru kaçışını tanır", () => {
    const [t] = parseMarkdown(
      "| Servis | Port | Rol |\n|---|:---:|---:|\n| `api` | 4000 | a \\| b |\n| auth | 4001 |",
    );
    expect(t?.kind).toBe("table");
    if (t?.kind !== "table") return;
    expect(t.align).toEqual(["left", "center", "right"]);
    expect(t.head.map(text)).toEqual(["Servis", "Port", "Rol"]);
    expect(t.rows.map((r) => r.map(text))).toEqual([
      ["api", "4000", "a | b"],
      ["auth", "4001", ""],
    ]);
    expect(t.rows[0]?.[0]?.[0]?.kind).toBe("code");
  });

  it("iç içe ve numaralı listeleri, görev kutularını kurar", () => {
    const [l] = parseMarkdown("1. bir\n   - alt a\n   - [x] alt b\n2. iki\n   devam\n3. üç");
    expect(l?.kind).toBe("list");
    if (l?.kind !== "list") return;
    expect(l.ordered).toBe(true);
    expect(l.items.map((i) => text(i.content))).toEqual(["bir", "iki devam", "üç"]);
    const sub = l.items[0]?.children[0];
    expect(sub?.kind).toBe("list");
    if (sub?.kind !== "list") return;
    expect(sub.items.map((i) => [text(i.content), i.checked])).toEqual([
      ["alt a", undefined],
      ["alt b", true],
    ]);
  });

  it("başlık, alıntı, çizgi, kod bloğu ve yumuşak/sert satır kırılımını ayırır", () => {
    const blocks = parseMarkdown(
      "## Başlık ##\n\n> alıntı\n> devam\n\n---\n\n```ts\nconst a = 1;\n```\n\nsatır bir\nsatır iki  \nsatır üç",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["h", "quote", "hr", "code", "p"]);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(blocks[3]).toMatchObject({ lang: "ts", text: "const a = 1;" });
    const p = blocks[4];
    expect(p?.kind === "p" ? text(p.children) : "").toBe("satır bir satır iki\nsatır üç");
  });

  it("boş satırsız yazılan liste ve tablo paragrafı böler", () => {
    const blocks = parseMarkdown("Özet:\n- a\n- b\nSon | x\n---|---\n1 | 2");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "list", "table"]);
  });
});

describe("blocksText", () => {
  it("alıntıyı işaretsiz düz metne çevirir", () => {
    const blocks = parseMarkdown(
      "> I rebuilt **Codezal** on the `Pi` engine.\n>\n> Plan mode, [docs](https://x.dev).",
    );
    expect(blocksText(blocks)).toBe("I rebuilt Codezal on the Pi engine.\n\nPlan mode, docs.");
  });

  it("liste maddelerini satır satır yazar", () => {
    expect(blocksText(parseMarkdown("- bir\n- **iki**"))).toBe("- bir\n- iki");
  });
});
