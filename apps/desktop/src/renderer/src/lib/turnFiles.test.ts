import type { ToolCallItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { docCards, docKind, turnFiles } from "./turnFiles";

function tool(over: Partial<ToolCallItem>): ToolCallItem {
  return {
    type: "tool",
    id: "t",
    toolName: "edit",
    kind: "edit",
    status: "done",
    title: "Düzenlendi",
    startedAt: 1,
    ...over,
  };
}

describe("turnFiles", () => {
  it("dosya başına tek satır, sayaçlar toplanır, oluşturulanlar ayrıca listelenir", () => {
    const r = turnFiles(
      [
        tool({ id: "a", kind: "create", target: "/p/rapor.md", output: "+a\n+b\n" }),
        tool({ id: "b", kind: "edit", target: "/p/rapor.md", output: "+c\n-a\n" }),
        tool({ id: "c", kind: "edit", target: "src/x.ts", output: "+1\n" }),
        tool({ id: "d", kind: "read", target: "/p/y.ts", output: "x" }),
        tool({ id: "e", kind: "edit", target: "/p/z.ts", status: "error", output: "+1\n" }),
        tool({ id: "f", kind: "edit", target: "/p/w.ts", status: "running" }),
      ],
      "/cwd",
    );
    expect(r.changed.map((f) => [f.path, f.kind, f.add, f.del])).toEqual([
      ["/p/rapor.md", "edit", 3, 1],
      ["/cwd/src/x.ts", "edit", 1, 0],
    ]);
    expect(r.created.map((f) => f.name)).toEqual(["rapor.md"]);
    expect(r.changed[0]?.output).toBe("+a\n+b\n\n+c\n-a\n");
  });

  it("terminal/alt ajan kartının changedFiles listesi de satır olur; hata koduyla biten komut sayılır", () => {
    const r = turnFiles(
      [
        tool({
          id: "a",
          toolName: "bash",
          kind: "terminal",
          status: "error",
          changedFiles: [
            { path: "/cwd/rapor.md", kind: "create" },
            { path: "/cwd/eski.txt", kind: "delete" },
          ],
        }),
        tool({
          id: "b",
          toolName: "agent",
          kind: "other",
          changedFiles: [{ path: "src/x.ts", kind: "edit" }],
        }),
        tool({
          id: "c",
          toolName: "bash",
          kind: "terminal",
          status: "running",
          changedFiles: [{ path: "/cwd/sure.txt", kind: "edit" }],
        }),
      ],
      "/cwd",
    );
    expect(r.changed.map((f) => [f.path, f.kind])).toEqual([
      ["/cwd/rapor.md", "create"],
      ["/cwd/eski.txt", "delete"],
      ["/cwd/src/x.ts", "edit"],
    ]);
    expect(r.created.map((f) => f.name)).toEqual(["rapor.md"]);
  });

  it("silinen dosya belge kartı olmaz", () => {
    const r = turnFiles(
      [
        tool({ id: "a", kind: "create", target: "/p/gecici.md", output: "+a\n" }),
        tool({ id: "b", kind: "delete", target: "/p/gecici.md", toolName: "bash" }),
      ],
      "/cwd",
    );
    expect(r.created).toEqual([]);
    expect(r.changed.map((f) => f.kind)).toEqual(["delete"]);
  });
});

describe("shortPath", () => {
  it("cwd altını göreli, iCloud Drive'ı iCloud/, ev dizinini ~ yapar", async () => {
    const { shortPath } = await import("./turnFiles");
    const home = "/Users/e";
    expect(shortPath("/cwd/a/b.md", "/cwd", home)).toBe("a/b.md");
    expect(
      shortPath("/Users/e/Library/Mobile Documents/com~apple~CloudDocs/Finans/r.md", "/cwd", home),
    ).toBe("iCloud/Finans/r.md");
    expect(shortPath("/Users/e/Documents/x.md", "/cwd", home)).toBe("~/Documents/x.md");
    expect(shortPath("/opt/x.md", "/cwd", home)).toBe("/opt/x.md");
  });

  it("belge kartları: oluşturulan belge her zaman, düzenlenen yalnız metinde anılırsa", () => {
    const files = turnFiles(
      [
        tool({ id: "a", kind: "create", target: "/p/rapor.md", output: "+a\n" }),
        tool({ id: "b", kind: "edit", target: "/p/README.md", output: "+a\n" }),
        tool({ id: "c", kind: "edit", target: "/p/notlar.md", output: "+a\n" }),
        tool({ id: "d", kind: "create", target: "/p/src/a.ts", output: "+a\n" }),
        tool({ id: "e", kind: "create", target: "/p/tablo.xlsx" }),
      ],
      "/cwd",
    );
    const cards = docCards(files, "Raporu hazırladım, `notlar.md` de güncellendi.");
    expect(cards.map((f) => f.name)).toEqual(["rapor.md", "notlar.md", "tablo.xlsx"]);
  });

  it("belge türü etiketi uzantıdan gelir, kod dosyası belge sayılmaz", () => {
    expect(docKind("rapor.MD")).toEqual({ key: "turnFiles.doc", ext: "MD" });
    expect(docKind("sunum.pptx")).toEqual({ key: "turnFiles.slides", ext: "PPTX" });
    expect(docKind("a.ts")).toBeUndefined();
    expect(docKind("md")).toBeUndefined();
  });
});
