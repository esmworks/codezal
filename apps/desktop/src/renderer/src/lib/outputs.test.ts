import type { TranscriptItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { mergeDiskOutputs, taskOutputs } from "./outputs";

const OUT = "/Users/e/Documents/Codezal Asistan/Kişisel Finans/Çıktılar";
const CWD = "/Users/e/Library/Application Support/Codezal/asistan/p1";

function tool(over: Partial<Extract<TranscriptItem, { type: "tool" }>>): TranscriptItem {
  return {
    type: "tool",
    id: "t",
    toolName: "write",
    kind: "create",
    status: "done",
    title: "Oluşturuldu",
    startedAt: 1,
    ...over,
  };
}

describe("taskOutputs", () => {
  it("yazılan her dosyayı son yazımı esas alarak listeler; okuma ve hatalı yazım sayılmaz", () => {
    const outs = taskOutputs(
      [
        tool({ id: "a", target: `${OUT}/taksit-plani.md`, startedAt: 1 }),
        tool({ id: "b", target: "/Users/e/iCloud/Finans/rapor.md", startedAt: 2 }),
        tool({ id: "c", kind: "read", toolName: "read", target: `${OUT}/eski.md`, startedAt: 3 }),
        tool({ id: "d", target: `${OUT}/nakit-akisi.md`, status: "error", startedAt: 4 }),
        tool({ id: "e", target: `${OUT}/taksit-plani.md`, status: "running", startedAt: 5 }),
      ],
      CWD,
    );
    expect(outs).toEqual([
      { path: "/Users/e/iCloud/Finans/rapor.md", name: "rapor.md", at: 2, running: false },
      { path: `${OUT}/taksit-plani.md`, name: "taksit-plani.md", at: 5, running: true },
    ]);
  });

  it("göreli yolu çalışma klasörüne göre çözer", () => {
    expect(taskOutputs([tool({ target: "rapor.md" })], CWD)).toEqual([
      { path: `${CWD}/rapor.md`, name: "rapor.md", at: 1, running: false },
    ]);
  });

  it("Windows yollarını mutlak sayar, göreli yolu ters bölüyle ekler", () => {
    const win = "C:\\Users\\e\\AppData\\Roaming\\Codezal\\asistan\\p1";
    expect(taskOutputs([tool({ target: "C:\\Users\\e\\Documents\\rapor.md" })], win)).toEqual([
      { path: "C:\\Users\\e\\Documents\\rapor.md", name: "rapor.md", at: 1, running: false },
    ]);
    expect(taskOutputs([tool({ target: "gecici.md" })], win)).toEqual([
      { path: `${win}\\gecici.md`, name: "gecici.md", at: 1, running: false },
    ]);
  });
});

describe("mergeDiskOutputs", () => {
  it("görev başladıktan sonra değişen disk dosyalarını ekler, bilinenleri ve eskileri atlar", () => {
    const known = { path: `${OUT}/rapor.md`, name: "rapor.md", at: 30, running: true };
    const merged = mergeDiskOutputs(
      [known],
      [
        { name: "rapor.md", path: `${OUT}/rapor.md`, kind: "file", modifiedAt: 40 },
        { name: "proje.pdf", path: `${OUT}/proje.pdf`, kind: "file", modifiedAt: 25 },
        { name: "eski.pdf", path: `${OUT}/eski.pdf`, kind: "file", modifiedAt: 5 },
        { name: ".DS_Store", path: `${OUT}/.DS_Store`, kind: "file", modifiedAt: 50 },
        { name: "alt", path: `${OUT}/alt`, kind: "dir" },
        { name: "zamansiz.pdf", path: `${OUT}/zamansiz.pdf`, kind: "file" },
      ],
      10,
    );
    expect(merged).toEqual([
      { path: `${OUT}/proje.pdf`, name: "proje.pdf", at: 25, running: false },
      known,
    ]);
  });

  it("duran görevde son etkinlikten sonraki dosyalar başka göreve aittir", () => {
    // Çıktılar klasörü projenin bütün görevlerince paylaşılır.
    const merged = mergeDiskOutputs(
      [],
      [
        { name: "bizim.pdf", path: `${OUT}/bizim.pdf`, kind: "file", modifiedAt: 20 },
        { name: "sonraki.pdf", path: `${OUT}/sonraki.pdf`, kind: "file", modifiedAt: 90 },
      ],
      10,
      30,
    );
    expect(merged).toEqual([
      { path: `${OUT}/bizim.pdf`, name: "bizim.pdf", at: 20, running: false },
    ]);
  });
});
