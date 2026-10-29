import { basename } from "node:path";
import type {
  AgentColor,
  AgentDraft,
  AgentInfo,
  AgentIsolation,
  AgentScope,
  ModelRef,
  ThinkingLevel,
} from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { EXPLORE_TOOLS } from "../explore.js";

/** Gömülü ajan adları; dosya ajanları bu adları kullanamaz. */
export const GENERAL_AGENT = "general";
export const EXPLORE_AGENT = "explore";

/** Ajan `subagent_type` verilmediğinde çalışan gömülü ajan. */
export const DEFAULT_AGENT_TYPE = GENERAL_AGENT;

/**
 * Alt ajanın kullanabileceği araçlar. Liste açıkça yazılır çünkü alt oturumda yalnızca yerleşik
 * dosya/terminal araçları ile web araçları kayıtlıdır: görev listesi, arka plan işi, plan ve
 * denetim araçları ana oturuma aittir, bağlayıcı (mcp_*) araçları alt oturumlara yüklenmez.
 */
export const SUBAGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
  "web_search",
  "web_fetch",
] as const;

/**
 * Her durumda elenen araçlar: iç içe ajan (sonsuz devir), koşu yönetimi ve plan araçları (alt
 * ajanın kullanıcıya plan sunma yüzeyi yok) açık listede yazılsa bile verilmez.
 */
export const SUBAGENT_FORBIDDEN_TOOLS = [
  "agent",
  "agent_list",
  "agent_message",
  "agent_stop",
  "plan_enter",
  "plan_exit",
] as const;

/** Dosya ya da çalışma ağacı değiştirebilen araçlar; bunlardan biri varsa ajan "yazar" sayılır. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

const COLORS: readonly AgentColor[] = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
];
const THINKING: readonly ThinkingLevel[] = ["low", "high", "max"];

/** Dosyadan ya da gömülü tanımdan çözülmüş ajan gövdesi (kimlik ve durum alanları hariç). */
export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  color: AgentColor | null;
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  /** `null`: ajanı çalıştıran oturumun bütün araçları (dağıtım araçları hariç). */
  tools: string[] | null;
  disallowedTools: string[];
  injectAgentsMd: boolean;
  /** Varsayılan çalışma klasörü; model çağrıda yine `isolation` verebilir. */
  isolation: AgentIsolation;
  /** Varsayılan olarak arka planda çalışır mı. */
  background: boolean;
}

/** Okunan ajan dosyası; `diagnostic` doluysa profil eksik/geçersizdir ve listeye uyarı olarak düşer. */
export interface AgentFile {
  profile: AgentProfile | null;
  path: string;
  scope: AgentScope;
  diagnostic: string | null;
}

/** Gömülü ajan tanımı: dosyası yoktur, düzenlenemez. */
export interface BuiltInAgent {
  profile: AgentProfile;
}

/** Kimlik: `kapsam:ad` (ad küçük harf). */
export function agentId(scope: AgentScope, name: string): string {
  return `${scope}:${name.trim().toLocaleLowerCase()}`;
}

/** Kimliği kapsam ve ada ayırır; biçim bozuksa `null`. */
export function parseAgentId(id: string): { scope: AgentScope; name: string } | null {
  const at = id.indexOf(":");
  if (at <= 0) return null;
  const scope = id.slice(0, at);
  const name = id.slice(at + 1);
  if (scope !== "built-in" && scope !== "user" && scope !== "project") return null;
  if (!name) return null;
  return { scope, name };
}

/** Ad çakışması ve dosya adı için normalleştirme: Türkçe büyük/küçük harf tuzağına düşmez. */
export function normalizeAgentName(name: string): string {
  return name.trim().toLocaleLowerCase("en");
}

export function builtInAgents(lang: Locale = "tr"): BuiltInAgent[] {
  const d = dict(lang);
  return [
    {
      profile: {
        name: GENERAL_AGENT,
        description: d.prompt.builtInGeneralDesc,
        systemPrompt: d.prompt.agentGeneralSystem,
        color: "blue",
        model: null,
        thinking: null,
        tools: null,
        disallowedTools: [],
        injectAgentsMd: true,
        isolation: "none",
        background: false,
      },
    },
    {
      profile: {
        name: EXPLORE_AGENT,
        description: d.prompt.builtInExploreDesc,
        systemPrompt: d.prompt.exploreSystem,
        color: "cyan",
        model: null,
        thinking: "low",
        tools: [...EXPLORE_TOOLS, "web_search", "web_fetch"],
        disallowedTools: [],
        injectAgentsMd: false,
        isolation: "none",
        background: false,
      },
    },
  ];
}

/** Gömülü ajan adı mı (dosya ajanları bu adları alamaz). */
export function isReservedAgentName(name: string): boolean {
  const key = normalizeAgentName(name);
  return key === GENERAL_AGENT || key === EXPLORE_AGENT;
}

interface Frontmatter {
  values: Map<string, string>;
  lists: Map<string, string[]>;
}

/**
 * Üst veri bloğunu (--- çitleri arası) ve gövdeyi ayırır. Ayrıştırıcı bilerek gevşektir: elle
 * yazılan dosyalarda `tools: read, grep` de, alt alta `- read` satırları da kabul edilir.
 * Tam YAML ayrıştırıcısı bağımlılığı yok; alanlar tek satırlık değerler ve ad listeleridir.
 */
export function splitAgentMarkdown(text: string): { frontmatter: Frontmatter; body: string } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: { values, lists }, body: text };
  let current: string | null = null;
  for (const raw of (match[1] ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) {
      const list = lists.get(current) ?? [];
      list.push(unquote(item[1] ?? ""));
      lists.set(current, list);
      continue;
    }
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = (pair[1] ?? "").toLocaleLowerCase();
    const value = (pair[2] ?? "").trim();
    current = key;
    if (!value) {
      // Değer alt satırlarda: liste ya da blok metin.
      if (!lists.has(key) && !values.has(key)) values.set(key, "");
      continue;
    }
    const inline = /^\[(.*)\]$/.exec(value);
    if (inline) {
      lists.set(
        key,
        (inline[1] ?? "")
          .split(",")
          .map((part) => unquote(part))
          .filter(Boolean),
      );
      continue;
    }
    values.set(key, unquote(value));
  }
  return { frontmatter: { values, lists }, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  return quoted ? (quoted[1] ?? "").trim() : trimmed;
}

/** Üst veri anahtarları küçük harfle saklanır: `disallowedTools` ve `injectAgentsMd` da bulunsun. */
function readValue(fm: Frontmatter, key: string): string | undefined {
  return fm.values.get(key.toLocaleLowerCase("en"));
}

/** `tools` / `disallowedTools`: hem liste hem virgülle ayrılmış metin kabul edilir. */
function readList(fm: Frontmatter, key: string): string[] | null {
  const normalized = key.toLocaleLowerCase("en");
  const list = fm.lists.get(normalized);
  if (list) return list.map((t) => t.trim()).filter(Boolean);
  const raw = fm.values.get(normalized);
  if (raw === undefined) return null;
  if (raw === "" || raw === "*" || raw === "all") return null;
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function readColor(raw: string | undefined): AgentColor | null {
  if (!raw) return null;
  const key = raw.toLocaleLowerCase("en") as AgentColor;
  return COLORS.includes(key) ? key : null;
}

function readThinking(raw: string | undefined): ThinkingLevel | null {
  if (!raw) return null;
  const key = raw.toLocaleLowerCase("en") as ThinkingLevel;
  return THINKING.includes(key) ? key : null;
}

/**
 * `model` alanı `sağlayıcı/model` biçimindedir; `inherit`, `main` ve boş değer "ana oturumun
 * modeli" demektir. Ayraç olarak eğik çizgi kullanılır çünkü sağlayıcı ve model kimlikleri
 * kendi içlerinde eğik çizgi taşımaz.
 */
function readModel(raw: string | undefined): ModelRef | null {
  const value = (raw ?? "").trim();
  if (!value || value === "inherit" || value === "main") return null;
  const at = value.indexOf("/");
  if (at <= 0 || at === value.length - 1) return null;
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

/** `isolation: worktree` dışındaki her değer (boş, `none`, bilinmeyen) yalıtımsız demektir. */
function readIsolation(raw: string | undefined): AgentIsolation {
  return (raw ?? "").trim().toLocaleLowerCase("en") === "worktree" ? "worktree" : "none";
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLocaleLowerCase("en");
  if (!value) return fallback;
  return !["false", "0", "no", "off", "hayir", "hayır"].includes(value);
}

/**
 * Ajan Markdown dosyasını çözer. Zorunlu alanlar `name` ve `description`; gövde sistem istemidir.
 * Eksik ya da bozuk dosya `diagnostic` ile döner: liste kullanıcıya gösterilebilsin, sessizce
 * yok olmasın.
 */
export function parseAgentMarkdown(
  path: string,
  text: string,
  scope: AgentScope,
  lang: Locale = "tr",
): AgentFile {
  const d = dict(lang);
  const { frontmatter, body } = splitAgentMarkdown(text);
  // Sıra önemli: üst veri hiç yoksa tanı "açıklama eksik" değil "üst veri yok" olmalı.
  if (frontmatter.values.size === 0 && frontmatter.lists.size === 0) {
    return { profile: null, path, scope, diagnostic: d.settings.agents.diagnosticNoFrontmatter };
  }
  const name =
    (readValue(frontmatter, "name") ?? "").trim() || basename(path).replace(/\.md$/i, "");
  const description = (readValue(frontmatter, "description") ?? "").trim();
  const systemPrompt = body.trim();
  if (!description) {
    return { profile: null, path, scope, diagnostic: d.settings.agents.diagnosticNoDescription };
  }
  return {
    profile: {
      name,
      description,
      systemPrompt,
      color: readColor(readValue(frontmatter, "color")),
      model: readModel(readValue(frontmatter, "model")),
      thinking: readThinking(readValue(frontmatter, "thinking")),
      tools: readList(frontmatter, "tools"),
      disallowedTools: readList(frontmatter, "disallowedTools") ?? [],
      injectAgentsMd: readBool(readValue(frontmatter, "injectAgentsMd"), true),
      isolation: readIsolation(readValue(frontmatter, "isolation")),
      background: readBool(readValue(frontmatter, "background"), false),
    },
    path,
    scope,
    diagnostic: null,
  };
}

/** Ajanı dosya biçimine çevirir; gövde sistem istemidir. */
export function serializeAgentMarkdown(draft: AgentDraft): string {
  const lines = ["---", `name: ${draft.name.trim()}`, `description: ${flat(draft.description)}`];
  if (draft.color) lines.push(`color: ${draft.color}`);
  if (draft.model) lines.push(`model: ${draft.model.provider}/${draft.model.id}`);
  if (draft.thinking) lines.push(`thinking: ${draft.thinking}`);
  if (draft.tools) lines.push(`tools: [${draft.tools.join(", ")}]`);
  if (draft.disallowedTools.length > 0)
    lines.push(`disallowedTools: [${draft.disallowedTools.join(", ")}]`);
  if (!draft.injectAgentsMd) lines.push("injectAgentsMd: false");
  if (draft.isolation === "worktree") lines.push("isolation: worktree");
  if (draft.background) lines.push("background: true");
  lines.push("---", "", draft.systemPrompt.trim(), "");
  return lines.join("\n");
}

/** Üst veri tek satır: satır sonları değeri bozar, bu yüzden boşluğa çevrilir. */
function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Dosyadan gelen alanları doğrular ve eksikleri tamamlar. Gömülü adlar korunur; ad dosya adı
 * olarak kullanıldığı için yalnızca harf, rakam ve tire kabul eder.
 */
export function validateDraft(
  draft: AgentDraft,
  lang: Locale = "tr",
): { ok: true; draft: AgentDraft } | { ok: false; error: string } {
  const d = dict(lang);
  const name = draft.name.trim();
  if (name.length < 3 || name.length > 50)
    return { ok: false, error: d.settings.agents.validationNameLength };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name))
    return { ok: false, error: d.settings.agents.validationNameChars };
  if (isReservedAgentName(name)) return { ok: false, error: d.settings.agents.validationReserved };
  if (!draft.description.trim())
    return { ok: false, error: d.settings.agents.validationDescription };
  if (!draft.systemPrompt.trim()) return { ok: false, error: d.settings.agents.validationPrompt };
  return {
    ok: true,
    draft: {
      ...draft,
      name,
      description: flat(draft.description),
      systemPrompt: draft.systemPrompt.trim(),
      disallowedTools: draft.disallowedTools.map((t) => t.trim()).filter(Boolean),
    },
  };
}

/**
 * Ajanın çalıştırabileceği araçlar. `tools` boşsa alt ajanın kullanabildiği bütün araçlar
 * (`SUBAGENT_TOOLS`) verilir; iki durumda da yasaklı araçlar ve `disallowedTools` elenir.
 */
export function resolveAgentTools(profile: AgentProfile): string[] {
  const allow = profile.tools;
  const base: readonly string[] = allow && allow.length > 0 ? allow : SUBAGENT_TOOLS;
  const denied = new Set<string>([...SUBAGENT_FORBIDDEN_TOOLS, ...profile.disallowedTools]);
  return [...new Set(base.filter((t) => !denied.has(t)))];
}

/**
 * Ajan dosya ya da çalışma ağacı değiştirebilir mi. Yazan ajan arka planda ya da paralel
 * çalışırken worktree'ye alınır; salt okur ajan (explore) kökte kalır, çakışma riski yoktur.
 */
export function canWrite(profile: AgentProfile): boolean {
  return resolveAgentTools(profile).some((tool) => WRITE_TOOLS.has(tool));
}

/** Gömülü ajanı listeye çevirir; `labelKey` arayüzde çevrilir. */
export function builtInAgentInfos(lang: Locale = "tr"): AgentInfo[] {
  return builtInAgents(lang).map((agent) => ({
    id: agentId("built-in", agent.profile.name),
    name: agent.profile.name,
    description: agent.profile.description,
    systemPrompt: agent.profile.systemPrompt,
    scope: "built-in" as const,
    path: `built-in:${agent.profile.name}`,
    color: agent.profile.color,
    model: agent.profile.model,
    thinking: agent.profile.thinking,
    tools: agent.profile.tools,
    disallowedTools: agent.profile.disallowedTools,
    injectAgentsMd: agent.profile.injectAgentsMd,
    isolation: agent.profile.isolation,
    background: agent.profile.background,
    enabled: true,
    readOnly: true,
    diagnostic: null,
  }));
}
