import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantProject } from "@codezal/contracts";
import { localeOf } from "@codezal/i18n";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonStore } from "./store";
import { AppStores } from "./stores";

const dir = mkdtempSync(join(tmpdir(), "cz-stores-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("JsonStore", () => {
  const Schema = z.object({ a: z.number().default(1), b: z.string().default("x") });
  it("bozuk dosyada varsayılana döner ve update yazar", () => {
    const p = join(dir, "s.json");
    writeFileSync(p, "{bozuk");
    const st = new JsonStore(p, Schema);
    expect(st.get()).toEqual({ a: 1, b: "x" });
    st.update({ a: 5, b: undefined });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 5, b: "x" });
  });
});

describe("AppStores — asistan projeleri", () => {
  const project = (id: string): AssistantProject => ({
    id,
    name: id,
    description: "",
    instructions: "",
    memory: [],
    context: [],
    createdAt: 1,
  });

  it("yeni proje başa eklenir, var olan kayıt yerinde güncellenir", () => {
    const d = join(dir, "projeler");
    const stores = new AppStores(d);
    for (const id of ["a", "b", "c"]) stores.saveProject(project(id));
    expect(stores.projects().map((p) => p.id)).toEqual(["c", "b", "a"]);
    // Ad değişikliği sırayı bozmaz.
    stores.saveProject({ ...project("a"), name: "A" });
    expect(stores.projects().map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(stores.projects().find((p) => p.id === "a")?.name).toBe("A");
  });

  it("reorderProjects verilen sırayı yazar ve kalıcıdır", () => {
    const d = join(dir, "proje-sira");
    const stores = new AppStores(d);
    for (const id of ["a", "b", "c"]) stores.saveProject(project(id));
    expect(stores.reorderProjects(["a", "c"]).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(new AppStores(d).projects().map((p) => p.id)).toEqual(["a", "c", "b"]);
  });
});

describe("AppStores", () => {
  it("ilk açılışta dil algılanır, dosya oluştuktan sonra seçim korunur", () => {
    // main/index.ts ilk açılışta `settings.created` görünce dili `app.getLocale()`den çözer.
    const d = join(dir, "dil");
    const first = new AppStores(d);
    expect(first.settings.created).toBe(true);
    first.settings.update({ language: localeOf("de-DE") });
    const second = new AppStores(d);
    expect(second.settings.created).toBe(false);
    expect(second.settings.get().language).toBe("en");
    expect(first.settings.created).toBe(true);
  });

  it("kullanımı sağlayıcı/model/gün bazında toplar, maliyeti ekler", () => {
    const stores = new AppStores(join(dir, "u"));
    const d1 = new Date(2026, 8, 11, 23, 30);
    const d2 = new Date(2026, 8, 12, 0, 10);
    stores.addUsage("anthropic", "claude", 100, 20, 0.01, d1);
    stores.addUsage("anthropic", "claude", 50, 10, 0.02, d1);
    stores.addUsage("anthropic", "claude", 7, 1, 0, d2);
    stores.addUsage("openai", "gpt", 1, 1, 0, d1);
    const rows = stores.usageEntries();
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.provider === "anthropic" && r.day === "2026-09-11");
    expect(a).toMatchObject({ month: "2026-09", input: 150, output: 30, requests: 2 });
    expect(a?.cost).toBeCloseTo(0.03);
    // Gün yerel saate göre; gece yarısından sonraki çağrı ayrı güne yazılır.
    expect(rows.find((r) => r.day === "2026-09-12")).toMatchObject({ input: 7, requests: 1 });
    expect(rows.find((r) => r.provider === "openai")?.cost).toBe(0);
  });

  it("eski usage.json (cost alanı yok) okunur", () => {
    const d = join(dir, "old");
    const stores1 = new AppStores(d);
    stores1.addUsage("p", "m", 1, 1);
    const raw = JSON.parse(readFileSync(join(d, "usage.json"), "utf8"));
    for (const e of raw.entries) {
      delete e.cost;
      delete e.day;
    }
    writeFileSync(join(d, "usage.json"), JSON.stringify(raw));
    const old = new AppStores(d).usageEntries()[0];
    expect(old?.cost).toBe(0);
    expect(old?.day).toBeUndefined();
  });
});
