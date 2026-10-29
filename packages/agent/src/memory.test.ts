import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, parseMemoryFile, slugify } from "./memory.js";

let root = "";
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codezal-memory-"));
  store = new MemoryStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("slugify", () => {
  it("Türkçe karakterleri sadeleştirir ve kebab-case üretir", () => {
    expect(slugify("Kişisel Finans: Kira 5'inde ödeniyor")).toBe(
      "kisisel-finans-kira-5-inde-odeniyor",
    );
    expect(slugify("   ")).toBe("bellek");
  });

  it("Windows'un yasak dosya adlarını kaçırır", () => {
    expect(slugify("NUL")).toBe("nul-");
    expect(slugify("com1")).toBe("com1-");
    expect(slugify("LPT9")).toBe("lpt9-");
    expect(slugify("konsol")).toBe("konsol");
  });
});

describe("parseMemoryFile", () => {
  it("ön bilgiyi ve gövdeyi ayırır", () => {
    const e = parseMemoryFile(
      "kira.md",
      "---\nname: kira\ndescription: Kira her ayın 5'inde\ntype: proje\n---\n\nKira 5'inde.\n\n**Neden:** bütçe.\n",
      1,
    );
    expect(e).toMatchObject({ name: "kira", description: "Kira her ayın 5'inde", type: "proje" });
    expect(e.body).toBe("Kira 5'inde.\n\n**Neden:** bütçe.");
  });
  it("ön bilgi yoksa dosya adı ve ilk satırı kullanır, bilinmeyen türü kullanici sayar", () => {
    const e = parseMemoryFile("not.md", "Sadece bir not\nikinci satır", 1);
    expect(e).toMatchObject({ name: "not", description: "Sadece bir not", type: "kullanici" });
    const f = parseMemoryFile("x.md", "---\nname: x\ndescription: d\ntype: acayip\n---\ngövde", 1);
    expect(f.type).toBe("kullanici");
  });
});

describe("MemoryStore", () => {
  it("kapsam klasörlerini ayırır", () => {
    expect(store.dirFor({ kind: "genel" })).toBe(join(root, "genel"));
    expect(store.dirFor({ kind: "proje", cwd: "/Users/a/Codezal" })).toBe(
      join(root, "proje", "-Users-a-Codezal"),
    );
    expect(store.dirFor({ kind: "asistan", projectId: "p1" })).toBe(join(root, "asistan", "p1"));
  });

  it("kaydeder, dizini üretir, listeler ve siler", () => {
    const scope = { kind: "asistan", projectId: "p1" } as const;
    const saved = store.save(scope, {
      description: "Kira her ayın 5'inde ödeniyor",
      type: "proje",
      body: "",
    });
    expect(saved.name).toBe("kira-her-ayin-5-inde-odeniyor");
    expect(saved.body).toBe("Kira her ayın 5'inde ödeniyor");
    const index = readFileSync(join(store.dirFor(scope), "MEMORY.md"), "utf8");
    expect(index).toContain(
      "- [kira-her-ayin-5-inde-odeniyor](kira-her-ayin-5-inde-odeniyor.md) — Kira her ayın 5'inde ödeniyor",
    );
    expect(store.list(scope)).toHaveLength(1);
    store.remove(scope, saved.name);
    expect(store.list(scope)).toHaveLength(0);
    expect(readFileSync(join(store.dirFor(scope), "MEMORY.md"), "utf8").trim()).toBe("");
  });

  it("ajanın elle yazdığı dosyayı da listeler ve dizin yeniden kurulunca kapsar", () => {
    const scope = { kind: "genel" } as const;
    const dir = store.ensure(scope);
    writeFileSync(
      join(dir, "erhan.md"),
      "---\nname: erhan\ndescription: Kullanıcı Türkçe yanıt ister\ntype: kullanici\n---\nTürkçe.\n",
    );
    expect(store.list(scope)[0]?.description).toBe("Kullanıcı Türkçe yanıt ister");
    store.rebuildIndex(scope);
    expect(store.index(scope)).toContain("[erhan](erhan.md)");
  });

  it("sistem istemi kuralları ve her kapsamın dizinini içerir, klasörleri hazırlar", () => {
    store.save({ kind: "genel" }, { description: "Yanıtlar Türkçe", type: "kullanici", body: "" });
    const text = store.systemPrompt([{ kind: "genel" }, { kind: "proje", cwd: "/tmp/x" }]);
    expect(text).toContain("# Bellek");
    expect(text).toContain("## Genel bellek");
    expect(text).toContain("Yanıtlar Türkçe");
    expect(text).toContain("## Proje belleği");
    expect(text).toContain("(henüz bellek yok)");
    expect(existsSync(join(root, "proje", "-tmp-x", "MEMORY.md"))).toBe(true);
  });
});
