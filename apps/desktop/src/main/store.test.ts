import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { corruptBackupPath, JsonStore, salvage } from "./store";

const root = mkdtempSync(join(tmpdir(), "cz-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Her test kendi klasöründe: yedek dosyaları birbirine karışmasın. */
const fresh = (): string => mkdtempSync(join(root, "t-"));

const Task = z.object({ id: z.string(), every: z.number() });
const Schema = z.object({
  theme: z.enum(["koyu", "açık"]).default("koyu"),
  fontSize: z.number().default(14),
  tasks: z.array(Task).default([]),
});

const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".corrupt-"));

describe("JsonStore", () => {
  it("dosya yoksa varsayılanla açılır, yedek almaz ve dosya yazmaz", () => {
    const dir = fresh();
    const st = new JsonStore(join(dir, "ayar.json"), Schema);
    expect(st.created).toBe(true);
    expect(st.get()).toEqual({ theme: "koyu", fontSize: 14, tasks: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("tek geçersiz alanda yalnız o alanı varsayılana çeker, diğerlerini korur ve yedek alır", () => {
    const dir = fresh();
    const path = join(dir, "ayar.json");
    const original = JSON.stringify({ theme: "mor", fontSize: 18, tasks: [{ id: "a", every: 5 }] });
    writeFileSync(path, original);
    const st = new JsonStore(path, Schema);
    expect(st.created).toBe(false);
    expect(st.get()).toEqual({ theme: "koyu", fontSize: 18, tasks: [{ id: "a", every: 5 }] });
    // Orijinal içerik bayt bayt yedekte durur.
    const [backup] = backups(dir);
    expect(backup).toMatch(/^ayar\.corrupt-\d+\.json$/);
    expect(readFileSync(join(dir, backup ?? ""), "utf8")).toBe(original);
    // Kurtarılan değer asıl dosyaya yazıldı: sonraki açılış yeni yedek bırakmaz.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(st.get());
    new JsonStore(path, Schema);
    expect(backups(dir)).toHaveLength(1);
  });

  it("dizi alanında yalnız bozuk öğeleri düşürür", () => {
    const dir = fresh();
    const path = join(dir, "gorev.json");
    writeFileSync(
      path,
      JSON.stringify({ tasks: [{ id: "a", every: 5 }, { id: "b" }, { id: "c", every: 1 }] }),
    );
    const st = new JsonStore(path, Schema);
    expect(st.get().tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(backups(dir)).toHaveLength(1);
  });

  it("JSON olmayan dosyayı yedekler ve varsayılana döner", () => {
    const dir = fresh();
    const path = join(dir, "ayar.json");
    writeFileSync(path, "{bozuk");
    const st = new JsonStore(path, Schema);
    expect(st.created).toBe(true);
    expect(st.get().fontSize).toBe(14);
    const [backup] = backups(dir);
    expect(readFileSync(join(dir, backup ?? ""), "utf8")).toBe("{bozuk");
  });

  it("yazım atomiktir: geçici dosya kalmaz, içerik tamdır", () => {
    const dir = fresh();
    const path = join(dir, "ayar.json");
    const st = new JsonStore(path, Schema);
    st.update({ fontSize: 20 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readdirSync(dir)).toEqual(["ayar.json"]);
    expect(JSON.parse(readFileSync(path, "utf8")).fontSize).toBe(20);
  });
});

describe("salvage", () => {
  it("nesne olmayan şemada kurtarmaz", () => {
    const S = z.record(z.string(), z.number());
    expect(salvage(S, { a: "x" })).toBeUndefined();
  });

  it("nesne olmayan ham değerde kurtarmaz", () => {
    expect(salvage(Schema, [1, 2])).toBeUndefined();
    expect(salvage(Schema, "metin")).toBeUndefined();
  });
});

describe("corruptBackupPath", () => {
  it("adı zaman damgasıyla ve aynı klasörde üretir", () => {
    expect(corruptBackupPath("/a/b/settings.json", 42)).toBe("/a/b/settings.corrupt-42.json");
  });
});
