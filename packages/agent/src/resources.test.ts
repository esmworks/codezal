import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandPath, ResourceCatalog, withoutPackages } from "./resources.js";

const root = mkdtempSync(join(tmpdir(), "codezal-resources-"));
const home = join(root, "home");
const agentDir = join(root, "pi");
const cwd = join(root, "proje");
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function skill(dir: string, name: string, description = `${name} açıklaması`): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  return file;
}

function settings(): { skills?: string[]; packages?: string[] } {
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

beforeAll(() => {
  // Pi `~/.agents/skills` ve `~/.pi/agent` klasörlerini ev dizininden okur; test ortamı izole kalsın.
  // Windows'ta `os.homedir()` HOME değil USERPROFILE okur; ikisi de ayarlanır.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  rmSync(root, { recursive: true, force: true });
});

describe("expandPath", () => {
  it("~ ve göreli yolları çözer", () => {
    expect(expandPath("~/a")).toBe(join(home, "a"));
    // Windows'ta ayraç `\`; aynı sonucu vermeli.
    expect(expandPath("~\\a")).toBe(join(home, "a"));
    expect(expandPath("b", "/base")).toBe("/base/b");
  });
});

describe("ResourceCatalog", () => {
  const catalog = new ResourceCatalog(agentDir);
  const own = skill(join(agentDir, "skills", "kendi"), "kendi", "Codezal'ın kendi becerisi");
  const external = join(root, "harici");
  skill(join(external, "dis"), "dis");

  it("seedDefaults yalnızca var olan klasörleri, yalnızca ilk kez yazar", async () => {
    await catalog.seedDefaults({ skills: [external, join(root, "yok")] });
    expect(settings().skills).toEqual([external]);
    await catalog.removeSource(external);
    await catalog.seedDefaults({ skills: [external] });
    expect(settings().skills).toEqual([]);
    await catalog.addSource(external);
    expect(settings().skills).toEqual([external]);
  });

  it("beceri ve kaynakları listeler", async () => {
    const list = await catalog.list(cwd);
    const names = list.skills.map((s) => [s.name, s.enabled, s.scope]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["kendi", true, "user"],
        ["dis", true, "user"],
      ]),
    );
    expect(list.sources).toEqual([external]);
    expect(list.ownSkillsDir).toBe(join(agentDir, "skills"));
  });

  it("proje kapsamındaki .agents/skills becerisini görür, proje yokken görmez", async () => {
    skill(join(cwd, ".agents", "skills", "proje-becerisi"), "proje-becerisi");
    const withProject = await catalog.list(cwd);
    expect(withProject.skills.find((s) => s.name === "proje-becerisi")).toMatchObject({
      scope: "project",
    });
    const without = await catalog.list(null);
    expect(without.skills.find((s) => s.name === "proje-becerisi")).toBeUndefined();
  });

  it("kapatma Pi ayarına -yol yazar ve gerçek yükleyici beceriyi dışarıda bırakır", async () => {
    await catalog.setEnabled(cwd, own, false);
    expect(settings().skills).toContain(`-${own}`);
    const list = await catalog.list(cwd);
    expect(list.skills.find((s) => s.path === own)?.enabled).toBe(false);

    const sm = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: sm,
      noExtensions: true,
      noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getSkills().skills.map((s) => s.name);
    expect(loaded).not.toContain("kendi");
    expect(loaded).toContain("dis");

    await catalog.setEnabled(cwd, own, true);
    expect(settings().skills).toContain(`+${own}`);
    expect(settings().skills).not.toContain(`-${own}`);
    await loader.reload();
    expect(loader.getSkills().skills.map((s) => s.name)).toContain("kendi");
  });

  it("aynı adlı iki beceri için uyarı üretir", async () => {
    skill(join(external, "kopya"), "dis");
    const list = await catalog.list(cwd);
    expect(list.diagnostics.some((d) => d.message.includes('"dis" adı çakışıyor'))).toBe(true);
  });

  it("bilinmeyen yol için hata verir", async () => {
    await expect(catalog.setEnabled(cwd, "/yok/SKILL.md", false)).rejects.toThrow(
      "Kaynak bulunamadı",
    );
    await expect(catalog.addSource(join(root, "yok"))).rejects.toThrow("Klasör bulunamadı");
  });

  it("ayardaki paket kaydını yükleyici ve katalog çözmez, katalog uyarı düşer", async () => {
    // Yerel yol paketi ağa çıkmadan çözülür: görünüm delinirse içindeki beceri yüklenir. Pi npm
    // kaynağını aynı yoldan, üstelik sormadan kurarak çözer.
    const pkg = join(root, "paket");
    skill(join(pkg, "skills", "paketli"), "paketli");
    const file = join(agentDir, "settings.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...settings(), packages: [pkg] }));
    try {
      const sm = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: withoutPackages(sm),
        noExtensions: true,
        noThemes: true,
        noPromptTemplates: true,
      });
      await loader.reload();
      const loaded = loader.getSkills().skills.map((s) => s.name);
      expect(loaded).toContain("dis");
      expect(loaded).not.toContain("paketli");

      const list = await catalog.list(cwd);
      expect(list.skills.map((s) => s.name)).not.toContain("paketli");
      expect(list.diagnostics).toContainEqual({
        level: "warning",
        message: expect.stringContaining(`Paket kaydı yok sayıldı: ${pkg}`),
        path: file,
      });
      // Görünüm yalnız okumayı gizler; ayar dosyasındaki kayıt yerinde durur.
      expect(settings().packages).toEqual([pkg]);
    } finally {
      writeFileSync(file, before);
    }
  });
});
