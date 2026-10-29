import { describe, expect, it } from "vitest";
import {
  type DiffLine,
  dedentRows,
  foldHunks,
  highlightPair,
  lineNumberOf,
  type PatchRow,
  parseToolDiff,
  parseUnifiedDiff,
  plainRows,
} from "./diff";

const PATCH = `diff --git a/src/panel.ts b/src/panel.ts
index f7ea787..0d87de2 100644
--- a/src/panel.ts
+++ b/src/panel.ts
@@ -1,4 +1,5 @@
 satır 1
-satır 2
+satır iki
+satır 3
 satır 4
 satır 5
@@ -20,3 +21,4 @@ export function panel() {
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

const line = (over: Partial<DiffLine> = {}): DiffLine => ({
  kind: "ctx",
  oldNo: 1,
  newNo: 1,
  text: "",
  highlight: null,
  ...over,
});

describe("unified diff ayrıştırma", () => {
  it("dosyayı, hunk'ları ve satır numaralarını çıkarır", () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/panel.ts");
    expect(files[0]?.hunks).toHaveLength(2);
    const first = files[0]?.hunks[0];
    expect(first?.oldStart).toBe(1);
    expect(first?.newStart).toBe(1);
    expect(first?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
      ["ctx", 4, 5],
    ]);
  });

  it("başlık satırlarını (diff --git, index, ---, +++) içeriğe katmaz", () => {
    const files = parseUnifiedDiff(PATCH);
    const all = files[0]?.hunks.flatMap((h) => h.lines.map((l) => l.text)) ?? [];
    expect(all.some((t) => t.startsWith("index "))).toBe(false);
    expect(all.some((t) => t.includes("--- a/"))).toBe(false);
    expect(all.some((t) => t.includes("+++ b/"))).toBe(false);
  });

  it("silinen dosyayı işaretler", () => {
    const files = parseUnifiedDiff(
      "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
    );
    expect(files[0]?.deleted).toBe(true);
    expect(files[0]?.path).toBe("a.ts");
  });

  it("boş yamada liste döner", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\nindex 1..2\n")).toEqual([]);
  });
});

describe("değişen parça vurgusu", () => {
  it("ortak baş ve sonu kırpıp ortadaki farkı işaretler", () => {
    const del = line({ kind: "del", text: 'test("eski başlık", async () => {' });
    const add = line({ kind: "add", text: 'test("yeni başlık", async () => {' });
    highlightPair(del, add);
    // Vurgu kelime sınırına genişler: yarım sözcük ("esk"/"yen") boyanmaz.
    expect(del.highlight && del.text.slice(...del.highlight)).toBe("eski");
    expect(add.highlight && add.text.slice(...add.highlight)).toBe("yeni");
  });

  it("tamamen farklı satırları vurgulamaz", () => {
    const del = line({ kind: "del", text: "abc" });
    const add = line({ kind: "add", text: "xyz" });
    highlightPair(del, add);
    expect(del.highlight).toBeNull();
    expect(add.highlight).toBeNull();
  });

  it("saf eklemede yalnız eklenen parçayı vurgular", () => {
    const del = line({ kind: "del", text: "satır 1" });
    const add = line({ kind: "add", text: "satır 1 ve devamı" });
    highlightPair(del, add);
    expect(del.highlight).toBeNull();
    // Kelime sınırı: eklenen parça, bağlı olduğu sözcükle birlikte vurgulanır.
    expect(add.highlight && add.text.slice(...add.highlight)).toBe("1 ve devamı");
  });

  it("satır sonuna eklenen karakteri vurgular", () => {
    const del = line({ kind: "del", text: "const a = 2;" });
    const add = line({ kind: "add", text: "const a = 22;" });
    highlightPair(del, add);
    expect(del.highlight).toBeNull();
    // Sayı tek bir sözcüktür: eklenen basamak tüm sayıyla birlikte vurgulanır.
    expect(add.highlight && add.text.slice(...add.highlight)).toBe("22");
  });

  it("kelime ortasındaki farkı tam sözcüğe genişletir", () => {
    const del = line({ kind: "del", text: "const files = listFiles(dir);" });
    const add = line({ kind: "add", text: "const files = readFiles(dir);" });
    highlightPair(del, add);
    expect(del.highlight && del.text.slice(...del.highlight)).toBe("listFiles");
    expect(add.highlight && add.text.slice(...add.highlight)).toBe("readFiles");
  });

  it("tüm satırı kaplayan vurgu yapmaz", () => {
    const del = line({ kind: "del", text: "eskiDeger" });
    const add = line({ kind: "add", text: "yeniDeger" });
    highlightPair(del, add);
    // Baş ve son ortak değil ama genişletme satırın tamamına yayılırdı: daraltılmış aralık kalır.
    expect(del.highlight?.[0]).toBe(0);
    expect(del.highlight?.[1]).toBeLessThan(del.text.length);
  });

  it("tek karakterlik farkı da vurgular", () => {
    const del = line({ kind: "del", text: "a = 1;" });
    const add = line({ kind: "add", text: "a = 2;" });
    highlightPair(del, add);
    expect(del.highlight && del.text.slice(...del.highlight)).toBe("1");
    expect(add.highlight && add.text.slice(...add.highlight)).toBe("2");
  });
});

describe("hunk katlama", () => {
  it("aradaki değişmeyen bloğu tek satıra indirir", () => {
    const files = parseUnifiedDiff(PATCH);
    const rows = foldHunks(files[0]?.hunks ?? []);
    expect(rows.map((r) => r.type)).toEqual(["lines", "gap", "lines"]);
    const gap = rows[1];
    // İlk hunk eski dosyada 1-4 arasını kaplar (bağlam + silinen); ikinci hunk 20'de başlar
    // → arada 5..19, yani 15 satır vardır.
    expect(gap).toEqual({ type: "gap", count: 15 });
  });

  it("tek hunk'ta ayraç üretmez", () => {
    const first = parseUnifiedDiff(PATCH)[0]?.hunks[0];
    expect(first).toBeDefined();
    expect(foldHunks(first ? [first] : []).map((r) => r.type)).toEqual(["lines"]);
  });
});

/**
 * Pi'nin araç diff'i: her satırda tek numara (eklenende yeni, silinende ve bağlamda eski dosyanın),
 * atlanan bağlam ` ...` satırı. Kart bunu tek sütunlu cetvelle çizer.
 */
const TOOL_DIFF = [
  "   1 import a;",
  "     ...",
  "  98 const x = 1;",
  "- 99   return old;",
  "+ 99   return yeni;",
  "+100   log();",
  " 100 }",
  "     ...",
  " 140 export {};",
  "-141 const z = 3;",
  "+142 const z = 4;",
  "     ...",
].join("\n");

const lines = (rows: PatchRow[]) => rows.flatMap((r) => (r.type === "line" ? [r.line] : []));

describe("Pi araç diff'i", () => {
  it("satır türlerini ve numaraları çıkarır; bağlamın yeni numarasını farktan bulur", () => {
    const rows = parseToolDiff(TOOL_DIFF);
    expect(lines(rows).map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["ctx", 1, 1, "import a;"],
      ["ctx", 98, 98, "const x = 1;"],
      ["del", 99, null, "  return old;"],
      ["add", null, 99, "  return yeni;"],
      ["add", null, 100, "  log();"],
      // Bir silme + iki ekleme: eski 100. satır yeni dosyada 101'dir.
      ["ctx", 100, 101, "}"],
      ["ctx", 140, 141, "export {};"],
      ["del", 141, null, "const z = 3;"],
      ["add", null, 142, "const z = 4;"],
    ]);
  });

  it("cetvel tek numara yazar: silinende eski, diğerlerinde yeni dosyanınki", () => {
    const shown = lines(parseToolDiff(TOOL_DIFF)).map(lineNumberOf);
    expect(shown).toEqual([1, 98, 99, 99, 100, 101, 141, 141, 142]);
  });

  it("aradaki `...` satırını değişmeyen blok sayısına çevirir, sondakini yazmaz", () => {
    const rows = parseToolDiff(TOOL_DIFF);
    expect(rows.filter((r) => r.type === "gap")).toEqual([
      { type: "gap", count: 96 },
      { type: "gap", count: 39 },
    ]);
    expect(rows.at(-1)?.type).toBe("line");
  });

  it("baştaki `...` satırını yazmaz", () => {
    const rows = parseToolDiff("     ...\n 50 a\n-51 b\n+51 c");
    expect(rows[0]?.type).toBe("line");
    expect(rows.some((r) => r.type === "gap")).toBe(false);
  });

  it("silme + ekleme çiftinde değişen parçayı vurgular", () => {
    const [, , del, add] = lines(parseToolDiff(TOOL_DIFF));
    expect(del?.highlight && del.text.slice(...del.highlight)).toBe("old");
    expect(add?.highlight && add.text.slice(...add.highlight)).toBe("yeni");
  });

  it("metnin baştaki girintisini korur (numaradan sonra yalnız tek boşluk ayraçtır)", () => {
    const [line] = lines(parseToolDiff("+12     <div>"));
    expect(line?.text).toBe("    <div>");
  });

  it("diff biçiminde olmayan satırı numarasız yazar", () => {
    const [line] = lines(parseToolDiff("Could not find the exact text"));
    expect(line).toMatchObject({ kind: "ctx", oldNo: null, newNo: null });
    expect(line?.text).toBe("Could not find the exact text");
  });

  it("düz çıktıyı sırayla numaralar, sondaki satır sonunu satır saymaz", () => {
    expect(lines(plainRows("a\nb\n")).map((l) => [l.oldNo, l.text])).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });
});

describe("ortak girintiyi atma", () => {
  it("tüm satırlarda ortak olan girintiyi atar, göreli girintiyi korur", () => {
    const rows = dedentRows(
      parseToolDiff("  10       <a>\n  11         <b />\n  12\n  13       </a>"),
    );
    expect(lines(rows).map((l) => l.text)).toEqual(["<a>", "  <b />", "", "</a>"]);
  });

  it("vurgu aralığını atılan girinti kadar kaydırır", () => {
    const rows = dedentRows(parseToolDiff("-  5     return old;\n+  5     return yeni;"));
    const [del, add] = lines(rows);
    expect(del?.highlight && del.text.slice(...del.highlight)).toBe("old");
    expect(add?.highlight && add.text.slice(...add.highlight)).toBe("yeni");
  });

  it("girintisiz satır varsa hiçbir şeyi değiştirmez", () => {
    const rows = parseToolDiff(" 1 a\n 2   b");
    expect(dedentRows(rows)).toBe(rows);
  });
});
