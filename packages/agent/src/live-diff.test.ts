import { describe, expect, it } from "vitest";
import {
  computeLineChangeStat,
  editChangeStat,
  liveChangeStat,
  writeChangeStat,
} from "./live-diff.js";

describe("computeLineChangeStat", () => {
  it("yeni dosyada bütün satırlar eklenmiştir", () => {
    expect(computeLineChangeStat("", "a\nb\nc")).toEqual({ added: 3, removed: 0 });
  });

  it("sondaki boş satırı (dosya sonu yeni satırı) saymaz", () => {
    expect(computeLineChangeStat("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
  });

  it("değişen satırı ekleme ve silme olarak sayar", () => {
    expect(computeLineChangeStat("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("ortadaki bloğu değiştirirken ortak satırları korur", () => {
    const before = "bir\niki\nüç\ndört\nbeş";
    const after = "bir\niki\nÜÇ\ndört\nbeş";
    expect(computeLineChangeStat(before, after)).toEqual({ added: 1, removed: 1 });
  });

  it("yalnız ekleme ve yalnız silmeyi ayırır", () => {
    expect(computeLineChangeStat("a\nc", "a\nb\nc")).toEqual({ added: 1, removed: 0 });
    expect(computeLineChangeStat("a\nb\nc", "a\nc")).toEqual({ added: 0, removed: 1 });
  });

  it("aynı satır birden çok kez geçse de LCS ile doğru sayar", () => {
    expect(computeLineChangeStat("x\nx\nx", "x\nx")).toEqual({ added: 0, removed: 1 });
  });
});

describe("writeChangeStat", () => {
  it("akan içeriğin satır sayısını verir", () => {
    expect(writeChangeStat({ path: "a.ts", content: "bir\niki" })).toEqual({
      added: 2,
      removed: 0,
    });
  });

  it("içerik henüz akmadıysa ölçü yok", () => {
    expect(writeChangeStat({ path: "a.ts" })).toBeUndefined();
    expect(writeChangeStat({ content: "" })).toBeUndefined();
  });
});

describe("editChangeStat", () => {
  it("Pi'nin edits dizisini okur", () => {
    expect(editChangeStat({ edits: [{ oldText: "a\nb", newText: "a" }] })).toEqual({
      added: 0,
      removed: 1,
    });
  });

  it("birden çok bloğu toplar", () => {
    expect(
      editChangeStat({
        edits: [
          { oldText: "a", newText: "a\nb" },
          { oldText: "c", newText: "c\nd" },
        ],
      }),
    ).toEqual({ added: 2, removed: 0 });
  });

  it("tek nesne ve eski alan adlarını da kabul eder", () => {
    expect(editChangeStat({ edits: { oldText: "a", newText: "b" } })).toEqual({
      added: 1,
      removed: 1,
    });
    expect(editChangeStat({ old_string: "a", new_string: "a\nb" })).toEqual({
      added: 1,
      removed: 0,
    });
  });

  it("JSON dizesi olarak gelen edits alanını çözer", () => {
    expect(editChangeStat({ edits: '[{"oldText":"a","newText":"a\\nb"}]' })).toEqual({
      added: 1,
      removed: 0,
    });
  });

  it("kısmi akışta yeni metin gelmemişse silinen satırları sayar", () => {
    expect(editChangeStat({ edits: [{ oldText: "a\nb\nc" }] })).toEqual({ added: 0, removed: 3 });
  });

  it("henüz düzenleme bloğu yoksa ölçü yok", () => {
    expect(editChangeStat({ path: "a.ts" })).toBeUndefined();
    expect(editChangeStat({ edits: [] })).toBeUndefined();
  });
});

describe("liveChangeStat", () => {
  it("yalnız sayaç gösterilen araçlarda ölçü üretir", () => {
    expect(liveChangeStat("write", { content: "a" })).toEqual({ added: 1, removed: 0 });
    expect(liveChangeStat("edit", { edits: [{ oldText: "a", newText: "a\nb" }] })).toEqual({
      added: 1,
      removed: 0,
    });
    expect(liveChangeStat("read", { path: "a.ts" })).toBeUndefined();
    expect(liveChangeStat("bash", { command: "ls" })).toBeUndefined();
  });
});
