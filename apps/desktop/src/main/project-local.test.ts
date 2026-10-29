import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  configPath,
  contextFilePath,
  ensureConfigFile,
  ensureGitignore,
  hasLocalConfig,
  planTitle,
  readProjectConfig,
  savePlanToProject,
} from "./project-local";

const root = mkdtempSync(join(tmpdir(), "cz-local-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, git = true): string {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  if (git) mkdirSync(join(cwd, ".git"));
  return cwd;
}

describe("proje-yerel yapılandırma", () => {
  it("contextFilePath var olan talimat dosyasını seçer", () => {
    const cwd = project("talimat");
    // Hiçbiri yoksa oluşturulacak dosya CODEZAL.md.
    expect(basename(contextFilePath(cwd))).toBe("CODEZAL.md");
    writeFileSync(join(cwd, "AGENTS.md"), "# agents\n", "utf8");
    expect(basename(contextFilePath(cwd))).toBe("AGENTS.md");
    // İkisi de varsa CODEZAL.md öncelikli.
    writeFileSync(join(cwd, "CODEZAL.md"), "# codezal\n", "utf8");
    expect(basename(contextFilePath(cwd))).toBe("CODEZAL.md");
  });

  it("hasLocalConfig .codezal ya da .pi klasörüne bakar", () => {
    const cwd = project("bos");
    expect(hasLocalConfig(cwd)).toBe(false);
    mkdirSync(join(cwd, ".pi"));
    expect(hasLocalConfig(cwd)).toBe(true);
  });

  it("ayarlar.json ile ayarlar.local.json birleşir, yerel üstün gelir, bozuk dosya atlanır", () => {
    const cwd = project("ayar");
    expect(readProjectConfig(cwd)).toEqual({});
    mkdirSync(join(cwd, ".codezal"));
    writeFileSync(
      configPath(cwd, false),
      JSON.stringify({
        permission: "auto-edit",
        thinking: "high",
        model: { provider: "p", id: "m" },
      }),
    );
    writeFileSync(configPath(cwd, true), JSON.stringify({ permission: "plan" }));
    expect(readProjectConfig(cwd)).toEqual({
      permission: "plan",
      thinking: "high",
      model: { provider: "p", id: "m" },
    });
    writeFileSync(configPath(cwd, true), "{bozuk");
    expect(readProjectConfig(cwd).permission).toBe("auto-edit");
    writeFileSync(configPath(cwd, true), JSON.stringify({ permission: "yok" }));
    expect(readProjectConfig(cwd).permission).toBe("auto-edit");
  });

  it("ensureConfigFile dosyayı bir kez oluşturur; kişisel dosya .gitignore'a girer", () => {
    const cwd = project("olustur");
    const shared = ensureConfigFile(cwd, false);
    expect(readFileSync(shared, "utf8")).toBe("{\n}\n");
    writeFileSync(shared, '{"permission":"full"}');
    ensureConfigFile(cwd, false);
    expect(readFileSync(shared, "utf8")).toBe('{"permission":"full"}');
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
    ensureConfigFile(cwd, true);
    ensureConfigFile(cwd, true);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".codezal/ayarlar.local.json\n");
  });

  it("ensureGitignore depo değilse dokunmaz, var olan satırı yinelemez, sondaki eksik satır sonunu tamamlar", () => {
    expect(ensureGitignore(project("gitsiz", false), "x")).toBe(false);
    const cwd = project("gitli");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/");
    expect(ensureGitignore(cwd, "/dist")).toBe(true);
    expect(ensureGitignore(cwd, "dist")).toBe(false);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules/\n/dist\n");
  });
});

describe("plan dosyaları", () => {
  const plans = join(root, "plans");

  it("planTitle ilk başlığı alır, yoksa verilen adı", () => {
    expect(planTitle("giriş\n# Kimlik Doğrulama Planı \n## adım", "x")).toBe(
      "Kimlik Doğrulama Planı",
    );
    expect(planTitle("başlıksız", "yedek")).toBe("yedek");
  });

  it("savePlanToProject .codezal/planlar altına tarih-başlık adıyla kopyalar", () => {
    const cwd = project("plan");
    mkdirSync(join(plans, "slug"), { recursive: true });
    const src = join(plans, "slug", "oturum.md");
    writeFileSync(src, "# Giriş Ekranı: yeniden tasarım\n\n1. adım\n");
    const target = savePlanToProject(cwd, src, plans);
    expect(target.startsWith(join(cwd, ".codezal", "planlar"))).toBe(true);
    expect(basename(target)).toMatch(/^\d{4}-\d{2}-\d{2}-giris-ekrani-yeniden-tasarim\.md$/);
    expect(readFileSync(target, "utf8")).toContain("1. adım");
    // Aynı gün aynı başlık: güncel plan üzerine yazılır.
    writeFileSync(src, "# Giriş Ekranı: yeniden tasarım\n\n2. adım\n");
    expect(savePlanToProject(cwd, src, plans)).toBe(target);
    expect(readFileSync(target, "utf8")).toContain("2. adım");
  });

  it("plan klasörü dışındaki, eksik ya da boş dosyayı reddeder", () => {
    const cwd = project("plan-red");
    writeFileSync(join(cwd, "sahte.md"), "# x");
    expect(() => savePlanToProject(cwd, join(cwd, "sahte.md"), plans)).toThrow();
    expect(() => savePlanToProject(cwd, plans, plans)).toThrow();
    expect(() => savePlanToProject(cwd, join(plans, "yok.md"), plans)).toThrow();
    mkdirSync(join(plans, "bos"), { recursive: true });
    writeFileSync(join(plans, "bos", "b.md"), "  \n");
    expect(() => savePlanToProject(cwd, join(plans, "bos", "b.md"), plans)).toThrow();
    expect(existsSync(join(cwd, ".codezal"))).toBe(false);
  });
});
