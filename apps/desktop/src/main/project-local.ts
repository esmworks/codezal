import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONTEXT_FILES, slugify } from "@codezal/agent";
import { ProjectConfig } from "@codezal/contracts";
import { i18n } from "./i18n.js";
import { log } from "./log.js";

/**
 * Proje kökündeki `.codezal/` klasörü: diğer araçların `.claude/`, `.codex/`, `.kiro/` karşılığı.
 * Yalnızca ilk yazımda oluşur; `ayarlar.json` ekiple paylaşılır, `ayarlar.local.json` kişiseldir,
 * `planlar/` plan modunda üretilen planların proje kopyalarıdır. Oturum, bellek ve anahtar burada
 * değil userData altında durur.
 */
export const LOCAL_DIR = ".codezal";
const CONFIG = "ayarlar.json";
const CONFIG_LOCAL = "ayarlar.local.json";
const PLANS = "planlar";

/** Proje-yerel yapılandırma var mı: Codezal'ın ya da Pi'nin dot-klasörü. Güven sorusu buna bağlı. */
export function hasLocalConfig(cwd: string): boolean {
  return existsSync(join(cwd, LOCAL_DIR)) || existsSync(join(cwd, ".pi"));
}

/**
 * "Proje talimatları"nı açarken kullanılacak dosya. Motor `CONTEXT_FILES`'ın ikisini de okur;
 * burada var olan tercih edilir, hiçbiri yoksa ilki (CODEZAL.md) oluşturulur.
 */
export function contextFilePath(cwd: string): string {
  const existing = CONTEXT_FILES.map((name) => join(cwd, name)).find((path) => existsSync(path));
  return existing ?? join(cwd, CONTEXT_FILES[0]);
}

export function configPath(cwd: string, local: boolean): string {
  return join(cwd, LOCAL_DIR, local ? CONFIG_LOCAL : CONFIG);
}

/** `ayarlar.json` + `ayarlar.local.json` (yerel üstün); bozuk dosya günlüğe düşer ve atlanır. */
export function readProjectConfig(cwd: string): ProjectConfig {
  let merged: ProjectConfig = {};
  for (const local of [false, true]) {
    const path = configPath(cwd, local);
    if (!existsSync(path)) continue;
    try {
      const parsed = ProjectConfig.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) merged = { ...merged, ...parsed.data };
      else log.warn("project:config", `${path}: ${parsed.error.message}`);
    } catch (error) {
      log.warn("project:config", `${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return merged;
}

/** Ayar dosyası yoksa boş nesneyle oluşturur; kişisel dosya git'e girmesin diye .gitignore'a yazılır. */
export function ensureConfigFile(cwd: string, local: boolean): string {
  const path = configPath(cwd, local);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{\n}\n", "utf8");
  }
  if (local) ensureGitignore(cwd, `${LOCAL_DIR}/${CONFIG_LOCAL}`);
  return path;
}

/** Git deposunda .gitignore'a satır ekler (zaten varsa dokunmaz); depo değilse false. */
export function ensureGitignore(cwd: string, entry: string): boolean {
  if (!existsSync(join(cwd, ".git"))) return false;
  const path = join(cwd, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return false;
  const glue = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${glue}${entry}\n`, "utf8");
  return true;
}

/** Plan başlığı: ilk `# Başlık` satırı; yoksa verilen ad. */
export function planTitle(text: string, fallback: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(text);
  return m?.[1]?.trim() || fallback;
}

/**
 * userData/plans altındaki plan dosyasını projenin `.codezal/planlar/` klasörüne
 * `<tarih>-<başlık-slug>.md` adıyla kopyalar; aynı gün aynı başlık varsa üzerine yazar (güncel plan).
 */
export function savePlanToProject(cwd: string, source: string, plansDir: string): string {
  const src = resolve(source);
  const rel = relative(resolve(plansDir), src);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(i18n.t("errors.notPlanFile"));
  if (!existsSync(src)) throw new Error(i18n.t("errors.planMissing"));
  const text = readFileSync(src, "utf8");
  if (!text.trim()) throw new Error(i18n.t("errors.planEmpty"));
  const dir = join(cwd, LOCAL_DIR, PLANS);
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const title = planTitle(text, basename(src, ".md"));
  const target = join(dir, `${date}-${slugify(title, 50)}.md`);
  writeFileSync(target, text, "utf8");
  return target;
}
