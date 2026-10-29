import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ResourceDiagnostic, SkillCatalog, SkillInfo } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import {
  DefaultPackageManager,
  loadSkillsFromDir,
  type ResolvedResource,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

/** `~/x`, `~\x` ve göreli yolları mutlak yola çevirir. */
export function expandPath(input: string, base = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  // Windows'ta ayraç `\`: `~\Belgeler` de ev dizinine çözülsün.
  if (/^~[\\/]/.test(trimmed)) return join(homedir(), trimmed.slice(2));
  return resolve(base, trimmed);
}

function toPosix(path: string): string {
  return sep === "\\" ? path.split(sep).join("/") : path;
}

function isOverride(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

interface Meta {
  scope: SkillInfo["scope"];
  source: string;
  enabled: boolean;
}

/**
 * Pi yükleyicisine paket listesini boş gösteren ayar görünümü. Pi `resolve()` ayardaki paketi eksik
 * bulunca sormadan npm'den kurar; eklenti ve şablon yüzeyi kaldırıldığı için Codezal hiçbir kapsamda
 * (kullanıcı ya da güvenilen projenin `.pi/settings.json`'ı) paket çözmez. Yazmalar gerçek
 * yöneticiye gider; yalnız okunan `packages` alanı gizlenir.
 */
export function withoutPackages(sm: SettingsManager): SettingsManager {
  return new Proxy(sm, {
    get(target, prop) {
      if (prop === "getGlobalSettings")
        return () => ({ ...target.getGlobalSettings(), packages: [] });
      if (prop === "getProjectSettings")
        return () => ({ ...target.getProjectSettings(), packages: [] });
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function metaOf(r: ResolvedResource): Meta {
  return {
    scope: r.metadata.scope,
    source: r.metadata.source,
    enabled: r.enabled,
  };
}

/**
 * Beceri kataloğu (TODO 8). Pi paket yöneticisinin çözdüğü kaynak listesini Pi'nin kendi
 * ayrıştırıcısıyla birleştirir; açma/kapamayı Pi TUI'nin `pi config` komutuyla aynı `+yol` / `-yol`
 * deseniyle `settings.json`'a yazar, böylece iki araç birbirini bozmaz. Oturumların kendi
 * yükleyicisi vardır; buradaki değişiklikler yeni oturumlarda geçerli olur.
 */
export class ResourceCatalog {
  readonly #agentDir: string;
  readonly #lang: Locale;
  readonly #projectTrusted: ((cwd: string) => boolean) | undefined;

  constructor(agentDir: string, lang: Locale = "tr", projectTrusted?: (cwd: string) => boolean) {
    this.#agentDir = agentDir;
    this.#lang = lang;
    this.#projectTrusted = projectTrusted;
  }

  get ownSkillsDir(): string {
    return join(this.#agentDir, "skills");
  }

  /**
   * İlk kurulumda var olan Pi CLI klasörlerini kaynak olarak ekler. Yalnızca `skills` anahtarı hiç
   * yazılmamışsa çalışır; kullanıcı kaynağı kaldırınca boş dizi kalır, yeniden eklenmez.
   */
  async seedDefaults(candidates: { skills?: string[] }): Promise<void> {
    const sm = this.#settings(null);
    if (sm.getGlobalSettings().skills === undefined) {
      const dirs = (candidates.skills ?? []).map((p) => expandPath(p)).filter((p) => existsSync(p));
      sm.setSkillPaths(dirs);
    }
    await sm.flush();
  }

  #settings(cwd: string | null): SettingsManager {
    // Proje yokken ev klasörü yalnızca yer tutucu; güvenilmeyen projenin kaynakları taranmaz.
    return SettingsManager.create(cwd ?? homedir(), this.#agentDir, {
      projectTrusted: cwd !== null && (this.#projectTrusted?.(cwd) ?? true),
    });
  }

  /**
   * Oturum yükleyicisiyle aynı görünüm: paketler çözülmez (bkz. `withoutPackages`). Çağıranlar
   * `resolve()`a yine de "skip" verir: görünüm bir Pi sürümünde delinirse ikinci kilit kurulumu durdurur.
   */
  #packageManager(cwd: string | null, sm = this.#settings(cwd)): DefaultPackageManager {
    return new DefaultPackageManager({
      cwd: cwd ?? homedir(),
      agentDir: this.#agentDir,
      settingsManager: withoutPackages(sm),
    });
  }

  async list(cwd: string | null): Promise<SkillCatalog> {
    const sm = this.#settings(cwd);
    const resolved = await this.#packageManager(cwd, sm).resolve(async () => "skip");
    const diagnostics: ResourceDiagnostic[] = [];
    const skills = this.#skills(resolved.skills, diagnostics);
    const sources = (sm.getGlobalSettings().skills ?? []).filter((e) => !isOverride(e));
    this.#ignoredPackages(sm, cwd, diagnostics);
    return { skills, sources, diagnostics, ownSkillsDir: this.ownSkillsDir };
  }

  /** Ayarda kalan paket kayıtları yüklenmez; beceriler sessizce kaybolmasın diye uyarı düşülür. */
  #ignoredPackages(sm: SettingsManager, cwd: string | null, out: ResourceDiagnostic[]): void {
    const d = dict(this.#lang);
    const scopes = [
      { packages: sm.getGlobalSettings().packages, file: join(this.#agentDir, "settings.json") },
      // Güvenilmeyen projede Pi proje ayarını boş döner; kayıt da uyarı da çıkmaz.
      ...(cwd === null
        ? []
        : [
            { packages: sm.getProjectSettings().packages, file: join(cwd, ".pi", "settings.json") },
          ]),
    ];
    for (const { packages, file } of scopes) {
      for (const entry of packages ?? []) {
        const source = typeof entry === "string" ? entry : entry.source;
        out.push({
          level: "warning",
          message: d.errors.packageIgnored.replace("{{source}}", source),
          path: file,
        });
      }
    }
  }

  #skills(resources: ResolvedResource[], diagnostics: ResourceDiagnostic[]): SkillInfo[] {
    const byDir = new Map<string, Skill[]>();
    const parsed = (path: string): Skill | undefined => {
      const dir = dirname(path);
      let list = byDir.get(dir);
      if (!list) {
        const result = loadSkillsFromDir({ dir, source: "codezal" });
        for (const d of result.diagnostics) {
          if (d.type === "collision") continue;
          diagnostics.push({ level: d.type, message: d.message, path: d.path ?? path });
        }
        list = result.skills;
        byDir.set(dir, list);
      }
      return list.find((s) => s.filePath === path);
    };
    const out: SkillInfo[] = [];
    const seen = new Map<string, string>();
    for (const r of resources) {
      const skill = parsed(r.path);
      if (!skill) continue;
      const meta = metaOf(r);
      const d = dict(this.#lang);
      const first = seen.get(skill.name);
      if (meta.enabled && first) {
        diagnostics.push({
          level: "warning",
          message: d.errors.resourceNameClash
            .replace("{{name}}", skill.name)
            .replace("{{first}}", first),
          path: r.path,
        });
      } else if (meta.enabled) seen.set(skill.name, r.path);
      out.push({
        name: skill.name,
        description: skill.description,
        path: r.path,
        baseDir: skill.baseDir,
        ...meta,
        hidden: skill.disableModelInvocation,
      });
    }
    return out;
  }

  /** Beceriyi aç/kapat: ayara mutlak yol deseni (`+yol` / `-yol`) yazılır. */
  async setEnabled(cwd: string | null, path: string, enabled: boolean): Promise<void> {
    const sm = this.#settings(cwd);
    const resolved = await this.#packageManager(cwd, sm).resolve(async () => "skip");
    const item = resolved.skills.find((r) => r.path === path);
    if (!item) throw new Error(dict(this.#lang).errors.resourceNotFound.replace("{{path}}", path));
    const scope = item.metadata.scope === "project" ? "project" : "user";
    const settings = scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
    const baseDir =
      item.metadata.baseDir ?? (scope === "project" ? join(cwd ?? "", ".pi") : this.#agentDir);
    const abs = toPosix(path);
    const rel = toPosix(relative(baseDir, path));
    const updated = (settings.skills ?? []).filter((entry) => {
      if (!isOverride(entry)) return true;
      const stripped = entry.slice(1);
      return stripped !== abs && stripped !== rel;
    });
    updated.push(`${enabled ? "+" : "-"}${abs}`);
    if (scope === "project") sm.setProjectSkillPaths(updated);
    else sm.setSkillPaths(updated);
    // Pi yazmaları kuyruğa alır; çağıran döndüğünde dosya güncel olsun.
    await sm.flush();
  }

  async addSource(path: string): Promise<void> {
    const sm = this.#settings(null);
    const abs = expandPath(path);
    if (!existsSync(abs))
      throw new Error(dict(this.#lang).errors.folderNotFound.replace("{{path}}", abs));
    const current = sm.getGlobalSettings().skills ?? [];
    if (current.includes(abs)) return;
    sm.setSkillPaths([...current, abs]);
    await sm.flush();
  }

  async removeSource(path: string): Promise<void> {
    const sm = this.#settings(null);
    const current = sm.getGlobalSettings().skills ?? [];
    sm.setSkillPaths(current.filter((e) => e !== path));
    await sm.flush();
  }

  /** Codezal'ın kendi beceri klasörünü oluşturur ve yolunu döner. */
  ensureDir(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
  }
}
