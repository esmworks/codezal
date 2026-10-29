import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentCatalog,
  AgentDraft,
  AgentInfo,
  AgentScope,
  ModelRef,
  ResourceDiagnostic,
} from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { writeFileAtomic } from "../fsx.js";
import {
  agentId,
  builtInAgentInfos,
  isReservedAgentName,
  normalizeAgentName,
  parseAgentId,
  parseAgentMarkdown,
  serializeAgentMarkdown,
  validateDraft,
} from "./profile.js";

/** Proje ajanlarının klasör adı; proje kökünün altında aranır. */
export const PROJECT_AGENTS_DIR = ".codezal/agents";
/** Ajan dosyalarının uzantısı. */
const AGENT_EXT = /\.md$/i;
/** Ajan klasörlerinde inilen en fazla derinlik; beklenmedik ağaçlarda taramayı sınırlar. */
const MAX_AGENT_DIR_DEPTH = 6;

interface AgentState {
  /** Kapatılan ajanların kimlikleri (`kapsam:ad`); dosya silinmez, yalnızca listeye girmez. */
  disabled: string[];
  /**
   * Gömülü ajanların model geçersiz kılmaları (`built-in:ad` → model). Gömülü tanımlar kodda
   * olduğu ve düzenlenemediği için model seçimi burada tutulur; dosya ajanlarında model zaten
   * kendi üst verisindedir.
   */
  overrides: Record<string, ModelRef>;
}

export interface AgentStoreOptions {
  /** Kullanıcı ajanlarının klasörü (`<veri>/agents`); yoksa oluşturulur. */
  userDir: string;
  /** Açma/kapama durumunun yazıldığı JSON dosyası. */
  statePath: string;
  lang?: Locale;
  /**
   * Projeye güveniliyor mu. `false` iken `.codezal/agents` **okunmaz**: klonlanan bir depo
   * `description` metnini modelin araç listesine, `systemPrompt` gövdesini alt ajanın sistem
   * istemine yazdırabilirdi (kaynak: proje dosyası, güven sınırı: model). Pi'nin `.pi/settings.json`
   * ve proje becerileri de aynı kapıya bağlıdır (`resources.ts`).
   */
  projectTrusted?: (cwd: string) => boolean;
}

/**
 * Alt ajan tanımlarının deposu: gömülü ajanlar koddan, kullanıcı ve proje ajanları Markdown
 * dosyalarından gelir. Motor bu depoyu oturum açılışında okur (araç tanımı hangi ajanların
 * çağrılabileceğini buradan öğrenir), arayüz ise Ajanlar sayfasından yönetir.
 *
 * Öncelik: gömülü < kullanıcı < proje. Aynı ad iki kapsamda varsa yakın olan kazanır; kullanıcı
 * kendi ajanıyla projede gelen bir tanımı bilinçli olarak geçersiz kılabilir.
 */
export class AgentStore {
  readonly #userDir: string;
  readonly #statePath: string;
  readonly #lang: Locale;
  readonly #projectTrusted: (cwd: string) => boolean;
  #state: AgentState = { disabled: [], overrides: {} };

  constructor(options: AgentStoreOptions) {
    this.#userDir = options.userDir;
    this.#statePath = options.statePath;
    this.#lang = options.lang ?? "tr";
    // Güven kararı verilmediyse proje ajanları okunmaz: varsayılan kapalı olmalı, çünkü
    // çağıranın bunu düşünmemiş olması "güvenilir" sayılamaz.
    this.#projectTrusted = options.projectTrusted ?? (() => false);
    this.#state = this.#readState();
  }

  get userDir(): string {
    return this.#userDir;
  }

  projectDir(cwd: string | null): string | null {
    return cwd ? join(cwd, PROJECT_AGENTS_DIR) : null;
  }

  /** Kullanıcı klasörünü oluşturur (ilk açılışta ve "klasörü aç" eyleminde). */
  ensureUserDir(): string {
    mkdirSync(this.#userDir, { recursive: true });
    return this.#userDir;
  }

  /**
   * Gömülü + kullanıcı + proje ajanlarını okur. Dosya hataları listeyi düşürmez: bozuk tanımlar
   * `diagnostics` içinde döner, Ajanlar sayfası bunları uyarı olarak gösterir.
   */
  list(cwd: string | null): AgentCatalog {
    const diagnostics: ResourceDiagnostic[] = [];
    const byName = new Map<string, AgentInfo>();
    for (const info of builtInAgentInfos(this.#lang))
      byName.set(normalizeAgentName(info.name), this.#withOverride(info));
    const collected: AgentInfo[] = [];
    for (const file of this.#readDir(this.#userDir, "user", diagnostics)) collected.push(file);
    const project = this.projectDir(cwd);
    if (project && cwd && this.#projectTrusted(cwd) && existsSync(project)) {
      for (const file of this.#readDir(project, "project", diagnostics)) collected.push(file);
    }
    // Sonra gelen kazanır: kullanıcı > gömülü, proje > kullanıcı.
    for (const info of collected) byName.set(normalizeAgentName(info.name), info);
    const agents = [...byName.values()];
    return {
      agents,
      userDir: this.#userDir,
      projectDir: project,
      diagnostics,
    };
  }

  /**
   * Ajanı adıyla bulur. Model `subagent_type` alanına adı bazen tireleri düşürerek ya da boşlukla
   * yazar; bu yüzden önce birebir, sonra ayraçları yok sayan eşleşme denenir.
   */
  find(cwd: string | null, name: string): AgentInfo | null {
    const key = normalizeAgentName(name);
    const flat = key.replace(/[-\s_]/g, "");
    const agents = this.list(cwd).agents;
    return (
      agents.find((a) => normalizeAgentName(a.name) === key) ??
      agents.find((a) => normalizeAgentName(a.name).replace(/[-\s_]/g, "") === flat) ??
      null
    );
  }

  /** Koşullara hazır ajanlar: kapalı olanlar ve okunamayan dosyalar dışarıda kalır. */
  runnable(cwd: string | null): AgentInfo[] {
    return this.list(cwd).agents.filter((a) => a.enabled && !a.diagnostic);
  }

  create(cwd: string | null, draft: AgentDraft): AgentInfo {
    const valid = validateDraft(draft, this.#lang);
    if (!valid.ok) throw new Error(valid.error);
    const dir = this.#dirFor(valid.draft.scope, cwd);
    this.#ensureDir(dir);
    const path = join(dir, `${normalizeAgentName(valid.draft.name)}.md`);
    if (existsSync(path)) throw new Error(dict(this.#lang).settings.agents.errorExists);
    this.#write(path, valid.draft);
    return this.#info(path, valid.draft, valid.draft.scope);
  }

  update(cwd: string | null, id: string, draft: AgentDraft): AgentInfo {
    const target = this.#writable(cwd, id);
    const scope: AgentScope = target.scope === "project" ? "project" : "user";
    const valid = validateDraft({ ...draft, scope }, this.#lang);
    if (!valid.ok) throw new Error(valid.error);
    const path = join(dirname(target.path), `${normalizeAgentName(valid.draft.name)}.md`);
    // Ad değiştiyse dosya yeni adla yazılır; başka bir ajanın dosyasının üzerine yazılmaz.
    if (path !== target.path && existsSync(path))
      throw new Error(dict(this.#lang).settings.agents.errorExists);
    this.#write(path, valid.draft);
    if (path !== target.path) rmSync(target.path, { force: true });
    const info = this.#info(path, valid.draft, scope);
    // Kapalı işareti adla birlikte taşınır: adı değişen ajan kendiliğinden açılmaz, eski kimlik de
    // durum dosyasında artık kalmaz.
    const disabled = this.#state.disabled.filter((entry) => entry !== id);
    if (!target.enabled) disabled.push(info.id);
    if (disabled.length !== this.#state.disabled.length || !target.enabled)
      this.#writeState({ disabled });
    return { ...info, enabled: this.#enabled(info.id) };
  }

  remove(cwd: string | null, id: string): void {
    const target = this.#writable(cwd, id);
    rmSync(target.path, { force: true });
    this.#writeState({ disabled: this.#state.disabled.filter((d) => d !== id) });
  }

  setEnabled(id: string, enabled: boolean): void {
    const parsed = parseAgentId(id);
    if (!parsed) throw new Error(dict(this.#lang).settings.agents.errorNotFound);
    if (parsed.scope === "built-in")
      throw new Error(dict(this.#lang).settings.agents.errorBuiltInReadOnly);
    const disabled = new Set(this.#state.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.#writeState({ disabled: [...disabled] });
  }

  /**
   * Gömülü ajanın modelini değiştirir (`null` = devral). Gömülü tanımlar kodda olduğu ve
   * düzenlenemediği için model seçimi burada tutulur; dosya ajanlarında model üst veride olduğundan
   * bu yol yalnızca gömülü ajanlar içindir.
   */
  setModelOverride(id: string, model: ModelRef | null): void {
    const d = dict(this.#lang);
    const parsed = parseAgentId(id);
    if (!parsed) throw new Error(d.settings.agents.errorNotFound);
    if (parsed.scope !== "built-in") throw new Error(d.settings.agents.errorOverrideOnlyBuiltIn);
    const overrides = { ...this.#state.overrides };
    if (model) overrides[id] = model;
    else delete overrides[id];
    this.#writeState({ overrides });
  }

  /** Düzenlenebilir/silinemez ajanı bulur; gömülü ajanlar salt okunurdur. */
  #writable(cwd: string | null, id: string): AgentInfo {
    const d = dict(this.#lang);
    const parsed = parseAgentId(id);
    if (!parsed || parsed.scope === "built-in")
      throw new Error(d.settings.agents.errorBuiltInReadOnly);
    const info = this.list(cwd).agents.find((a) => a.id === id);
    if (!info) throw new Error(d.settings.agents.errorNotFound);
    if (info.readOnly) throw new Error(d.settings.agents.errorBuiltInReadOnly);
    return info;
  }

  #dirFor(scope: AgentScope, cwd: string | null): string {
    if (scope === "built-in")
      throw new Error(dict(this.#lang).settings.agents.errorBuiltInReadOnly);
    if (scope === "project") {
      const dir = this.projectDir(cwd);
      if (!dir) throw new Error(dict(this.#lang).settings.agents.errorNoProject);
      return dir;
    }
    return this.ensureUserDir();
  }

  #ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }

  #write(path: string, draft: AgentDraft): void {
    this.#ensureDir(dirname(path));
    writeFileAtomic(path, serializeAgentMarkdown(draft));
  }

  #info(path: string, draft: AgentDraft, scope: AgentScope): AgentInfo {
    return {
      id: agentId(scope, draft.name),
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      scope,
      path,
      color: draft.color,
      model: draft.model,
      thinking: draft.thinking,
      tools: draft.tools,
      disallowedTools: draft.disallowedTools,
      injectAgentsMd: draft.injectAgentsMd,
      isolation: draft.isolation,
      background: draft.background,
      enabled: true,
      readOnly: false,
      diagnostic: null,
    };
  }

  /** Klasördeki `.md` dosyalarını (alt klasörler dâhil) okur; bozuklar tanı olarak döner. */
  #readDir(dir: string, scope: AgentScope, diagnostics: ResourceDiagnostic[]): AgentInfo[] {
    if (!existsSync(dir)) return [];
    const out: AgentInfo[] = [];
    for (const path of walk(dir)) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        diagnostics.push({
          level: "error",
          message: dict(this.#lang).errors.agentUnreadable,
          path,
        });
        continue;
      }
      const file = parseAgentMarkdown(path, text, scope, this.#lang);
      if (!file.profile) {
        diagnostics.push({ level: "warning", message: file.diagnostic ?? "", path });
        continue;
      }
      const profile = file.profile;
      if (isReservedAgentName(profile.name)) {
        // Gömülü adı taşıyan dosya sessizce yok sayılmaz: kullanıcı neden etkisiz olduğunu görsün.
        diagnostics.push({
          level: "warning",
          message: dict(this.#lang).settings.agents.diagnosticReserved.replace(
            "{{name}}",
            profile.name,
          ),
          path,
        });
        continue;
      }
      const id = agentId(scope, profile.name);
      out.push({
        id,
        name: profile.name,
        description: profile.description,
        systemPrompt: profile.systemPrompt,
        scope,
        path,
        color: profile.color,
        model: profile.model,
        thinking: profile.thinking,
        tools: profile.tools,
        disallowedTools: profile.disallowedTools,
        injectAgentsMd: profile.injectAgentsMd,
        isolation: profile.isolation,
        background: profile.background,
        enabled: this.#enabled(id),
        readOnly: false,
        diagnostic: null,
      });
    }
    return out;
  }

  #enabled(id: string): boolean {
    return !this.#state.disabled.includes(id);
  }

  /** Gömülü ajanın modelini geçersiz kılma kaydıyla değiştirir (yoksa tanım kendi modelini korur). */
  #withOverride(info: AgentInfo): AgentInfo {
    const override = this.#state.overrides[info.id];
    return override ? { ...info, model: override } : info;
  }

  #readState(): AgentState {
    try {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf8")) as Partial<AgentState>;
      return {
        disabled: Array.isArray(raw.disabled) ? raw.disabled.filter(isString) : [],
        overrides: readOverrides(raw.overrides),
      };
    } catch {
      // Dosya yoksa ya da bozuksa varsayılan: hepsi açık, geçersiz kılma yok. Bozuk dosya
      // üzerine yazılana dek durur.
      return { disabled: [], overrides: {} };
    }
  }

  /** Durum dosyası tek yerden yazılır: her alan güncel hâliyle korunur (kısmi yazım kaybı olmaz). */
  #writeState(patch: Partial<AgentState>): void {
    this.#state = { ...this.#state, ...patch };
    mkdirSync(dirname(this.#statePath), { recursive: true });
    writeFileAtomic(this.#statePath, `${JSON.stringify(this.#state, null, 2)}\n`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Geçersiz kılma kayıtları okunurken doğrulanır: bozuk girdi listeyi düşürmez, yok sayılır. */
function readOverrides(raw: unknown): Record<string, ModelRef> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModelRef> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { provider, id: modelId } = value as { provider?: unknown; id?: unknown };
    if (typeof provider !== "string" || typeof modelId !== "string") continue;
    if (!provider || !modelId) continue;
    out[id] = { provider, id: modelId };
  }
  return out;
}

/**
 * Klasördeki `.md` dosyalarını özyinelemeli ve ad sırasına göre toplar.
 *
 * Sembolik bağlar **izlenmez** ve derinlik sınırlıdır: depoya bırakılan `.codezal/agents/x -> /`
 * bağı, oturum açılışında bütün dosya sistemini gezip okumaya çalışırdı; kendine bağlı bir dizin
 * de sonsuz döngü kurardı (`ELOOP` sınırına kadar). Bağ olmayan alt klasörler taranır.
 */
function walk(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > MAX_AGENT_DIR_DEPTH) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "tr"))) {
    const path = join(dir, entry.name);
    // `isSymbolicLink` önce bakılır: bağ hem dosya hem dizin gibi görünebilir.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(path, depth + 1));
    else if (entry.isFile() && AGENT_EXT.test(entry.name) && entry.name !== "README.md")
      out.push(path);
  }
  return out;
}
