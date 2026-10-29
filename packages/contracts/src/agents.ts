import { z } from "zod";
import { ModelRef, ThinkingLevel } from "./domain.js";
import { ResourceDiagnostic } from "./skills.js";

/**
 * Kullanıcı tanımlı alt ajanlar. Bir ajan; adı, açıklaması, sistem istemi, modeli, düşünme
 * seviyesi ve araç kümesiyle Markdown dosyasında tanımlanır (üst veri + gövde metni). Gömülü
 * ajanlar kodda durur, dosyaları yoktur; kullanıcı ve proje ajanları klasörlerden okunur.
 *
 * Kimlik `kapsam:ad` biçimindedir (`user:rapor-yazari`); arayüz ve açma/kapama kayıtları bu
 * kimliği kullanır. Aynı ad birden çok kapsamda varsa daha yakın kapsam kazanır: proje > kullanıcı.
 */
export const AgentScope = z.enum(["built-in", "user", "project"]);
export type AgentScope = z.infer<typeof AgentScope>;

/** Rozet rengi; listede ajanı ayırt etmek için kullanılır. */
export const AgentColor = z.enum([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);
export type AgentColor = z.infer<typeof AgentColor>;

/**
 * Ajanın çalışma klasörü: `none` ana oturumun klasöründe, `worktree` kendi git worktree'sinde
 * çalışır ve değişikliği kullanıcı inceleyip ana dala uygular (paralel düzenlemede çakışmaz).
 */
export const AgentIsolation = z.enum(["none", "worktree"]);
export type AgentIsolation = z.infer<typeof AgentIsolation>;

/** Ajanın tanımlandığı yer: dosya yolu ya da gömülü ajanlar için `built-in:<ad>`. */
export const AgentInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Markdown gövdesi; alt oturumun ek sistem istemine yazılır. */
  systemPrompt: z.string(),
  scope: AgentScope,
  path: z.string(),
  color: AgentColor.nullable().default(null),
  /** Boş: ana oturumun modeli kullanılır. */
  model: ModelRef.nullable().default(null),
  /** Boş: ana oturumun düşünme seviyesi kullanılır. */
  thinking: ThinkingLevel.nullable().default(null),
  /** `null`: ajanı çalıştıran oturumun bütün araçları (dağıtım araçları hariç). */
  tools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).default([]),
  /** `false`: proje talimat dosyaları (CODEZAL.md, AGENTS.md) alt oturuma verilmez. */
  injectAgentsMd: z.boolean().default(true),
  /** Varsayılan çalışma klasörü; model çağrıda yine `isolation` verebilir. */
  isolation: AgentIsolation.default("none"),
  /** `true`: ajan varsayılan olarak arka planda çalışır, ana tur beklemez. */
  background: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Gömülü ajan: düzenlenemez, silinemez, kapatılamaz. */
  readOnly: z.boolean().default(false),
  /** Dosya okunamadıysa/eksikse kısa açıklama; liste yine de gösterilir. */
  diagnostic: z.string().nullable().default(null),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

/** Yeni ajan taslağı ya da var olanın düzenlenmiş hâli (kaydetme gövdesi). */
export const AgentDraft = z.object({
  /** Dosyanın yazılacağı kapsam; düzenlemede değiştirilemez. */
  scope: z.enum(["user", "project"]).default("user"),
  name: z.string().min(1).max(50),
  description: z.string().max(400),
  systemPrompt: z.string(),
  color: AgentColor.nullable().default(null),
  model: ModelRef.nullable().default(null),
  thinking: ThinkingLevel.nullable().default(null),
  tools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).default([]),
  injectAgentsMd: z.boolean().default(true),
  isolation: AgentIsolation.default("none"),
  background: z.boolean().default(false),
});
export type AgentDraft = z.infer<typeof AgentDraft>;

/** Ajan listesi; arayüz hem ajanları hem de klasör yollarını ve okuma uyarılarını görür. */
export const AgentCatalog = z.object({
  agents: z.array(AgentInfo),
  /** Kullanıcı ajanlarının klasörü (`<veri>/agents`); her zaman vardır. */
  userDir: z.string(),
  /** Proje ajanlarının klasörü; açık proje yoksa `null`. */
  projectDir: z.string().nullable(),
  diagnostics: z.array(ResourceDiagnostic),
});
export type AgentCatalog = z.infer<typeof AgentCatalog>;
