import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { McpConnector, McpToolInfo, McpToolPolicy } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { type ImageContent, type TextContent, type TSchema, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type CallToolResult,
  Client,
  type ListChangedHandlers,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type Prompt,
  auth as runOAuth,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFileAtomic } from "./fsx.js";
import {
  GDRIVE_API_URL,
  type NativeContext,
  NativeHttpError,
  type NativeServiceId,
} from "./native.js";
import { NATIVE_SERVICES } from "./native-services.js";
import { boundTextBlocks, truncateToolText } from "./tool-budget.js";
import { wrapUntrusted } from "./untrusted.js";

/** OAuth geri dönüşü için tercih edilen yerel kapı; doluysa rastgele kapı ve yeniden kayıt. */
const CALLBACK_PORT = 47821;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 120_000;
/** Çok araçlı sunucular sistem istemini şişirir; arayüz bu eşikte uyarır. */
export const MANY_TOOLS = 30;
/**
 * Tam şemayla kayıtlı araç üst sınırı: bağlı araçların toplamı bunu aşınca yeni araçlar Pi'ye
 * kaydedilmez, sistem istemine tek satırlık katalog gider ve `tool_search` gerekeni yükler.
 */
export const DIRECT_TOOL_LIMIT = 20;
/**
 * Bağlı servislerin kaynaklarını listeleyen/okuyan ortak araç. `mcp_` öneki taşır: izin kapısında
 * bağlayıcı aracı gibi değerlendirilir (Sor modunda onay, Plan modunda engel).
 */
export const RESOURCES_TOOL = "mcp_resources";
/** Katalogdan araç yükleyen arama aracı; `mcp_` öneki taşımaz ki izin kapısı sormasın. */
export const TOOL_SEARCH_TOOL = "tool_search";
/**
 * Katalog mesajının türü. Gizli dürtmeden (`NUDGE_TYPE`) ayrıdır: bu mesaj transkriptte sınır
 * öğesi üretmez, yalnız modelin bağlamına girer.
 */
export const MCP_CATALOG_TYPE = "codezal-mcp-catalog";
/** Bir aramada yüklenen en çok araç; fazlası için model sorguyu daraltır. */
const SEARCH_RESULTS = 8;
/**
 * Bir turda önden yüklenebilecek en çok araç: tek büyük servis kadar. Bütçe olmadan "Notion'daki
 * notu Linear ve Gmail'e taşı" gibi tek mesaj üç servisin tüm araçlarını tam şemayla kaydediyor
 * ve ertelemenin önlemek için var olduğu istem şişmesi geri geliyordu.
 */
const PRELOAD_LIMIT = MANY_TOOLS;
/** Katalog satırındaki açıklama uzunluğu (karakter). */
const CATALOG_DESC_CHARS = 110;

/** Katalog ve arama için araç özeti. */
export interface CatalogEntry {
  /** Bağlayıcının kullanıcı verdiği adı. */
  connector: string;
  /** Ajanın gördüğü ad (`mcp_<bağlayıcı>_<araç>`). */
  name: string;
  description: string;
}

/** Aksan ve Türkçe harfleri sadeleştirip küçük harfe çevirir; ad, arama ve eşleme bunu kullanır. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase();
}

function tokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Katalog satırı: açıklamanın ilk cümlesi, en çok CATALOG_DESC_CHARS karakter. */
export function catalogLine(description: string): string {
  const first =
    description
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > CATALOG_DESC_CHARS
    ? `${first.slice(0, CATALOG_DESC_CHARS - 1).trimEnd()}…`
    : first;
}

/**
 * İki sözcüğü Türkçe çekim eklerine karşı hoşgörülü eşler: eşitlik ya da iki yönden biri önek.
 * Tek yönlü kural ("etkinlik".startsWith("etkinlikleri")) çekimli sorguyu kaçırıyordu; sorgu
 * "etkinlikleri listele" iken "Takvimde etkinlik oluşturur" açıklaması hiç puan almıyordu.
 * Dört harften kısa sözcükte yalnızca eşitlik aranır ("ara" her araç adını tutmasın).
 */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  return b.length >= 4 && a.startsWith(b);
}

/**
 * Sorgu sözcüklerini araç adı, bağlayıcı adı ve açıklamayla eşler; ad eşleşmesi ağır basar,
 * puanı sıfır olanlar elenir. Bağlayıcı adıyla arama o bağlayıcının tüm araçlarını getirir.
 * Ad ve açıklamada sözcük bütünü aranır (bkz. `alike`); alt dize araması "bir" gibi kısa
 * sözcüklerle her şeyi eşliyordu. Ad ayrıca ham alt dize olarak da denenir ki "sayfa_ara"
 * gibi birleşik parçalar tutsun.
 */
export function matchTools<T extends CatalogEntry>(query: string, entries: readonly T[]): T[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const exact = fold(query).trim();
  const inText = (w: string, text: string[]) => text.some((t) => alike(w, t));
  return entries
    .map((entry, index) => {
      const name = fold(entry.name);
      const nameParts = tokens(entry.name);
      const connector = fold(entry.connector);
      const description = tokens(entry.description);
      let score = name === exact ? 10 : 0;
      for (const w of words) {
        if (name.includes(w) || inText(w, nameParts)) score += 3;
        if (connector.includes(w)) score += 2;
        if (inText(w, description)) score += 1;
      }
      return { entry, score, index };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.entry);
}

/**
 * İstemde adı geçen bağlayıcılar. Ad tam dize olarak aranmaz: "Google Drive" bağlayıcısı
 * "Drive'daki dosyayı aç" isteminde de tanınmalı, "monday.com" ve "Atlassian (Jira, Confluence)"
 * gibi noktalamalı adlar hiç tutmuyordu. Ad sözcüklere bölünür ve yalnızca o bağlayıcıya özgü
 * (başka bağlayıcının adında geçmeyen) bir sözcük istemde geçiyorsa ad anılmış sayılır; böylece
 * yalın "google" altı Google bağlayıcısını birden yüklemez. Özgü sözcüğü olmayan bağlayıcıda
 * adın tüm sözcükleri aranır. Eşleme çekim eklerine hoşgörülüdür ("takvimdeki" → "Takvim").
 */
export function mentionedConnectors(prompt: string, connectors: readonly string[]): string[] {
  const words = tokens(prompt);
  if (words.length === 0) return [];
  const named = connectors.map((name) => ({
    name,
    parts: [...new Set(tokens(name))].filter((p) => p.length >= 3),
  }));
  const freq = new Map<string, number>();
  for (const { parts } of named) for (const p of parts) freq.set(p, (freq.get(p) ?? 0) + 1);
  const hit = (p: string) => words.some((w) => alike(p, w));
  const out: string[] = [];
  for (const { name, parts } of named) {
    if (parts.length === 0) continue;
    const unique = parts.filter((p) => freq.get(p) === 1);
    if (unique.length > 0 ? unique.some(hit) : parts.every(hit)) out.push(name);
  }
  return out;
}

/** Sistem istemine giden katalog: bağlayıcı başına başlık, araç başına tek satır. */
export function catalogText(entries: readonly CatalogEntry[], lang: Locale = "tr"): string {
  const d = dict(lang);
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.connector) ?? [];
    list.push(e);
    groups.set(e.connector, list);
  }
  const lines = [d.prompt.mcpCatalog];
  for (const [connector, list] of groups) {
    lines.push("", `## ${connector} (${list.length})`);
    for (const e of list) lines.push(`- ${e.name}: ${catalogLine(e.description) || e.name}`);
  }
  return lines.join("\n");
}

type StoredAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | {
      kind: "oauth";
      client?: StoredOAuthClientInformation;
      tokens?: StoredOAuthTokens;
      verifier?: string;
      /** Kayıtlı yönlendirme adresinin kapısı; değişirse istemci yeniden kaydedilir. */
      port?: number;
      /** Kendi OAuth istemcisi (DCR desteklemeyen sunucular; ör. Google). */
      preset?: { clientId: string; clientSecret: string };
      /**
       * Yönlendirme adresi sunucuda tek tek kayıtlıysa kapı değişemez (kullanıcının girdiği "Web
       * uygulaması" istemcisi). Uygulamayla gelen masaüstü tipi istemcide her loopback kapısı
       * kabul edildiğinden bu kapalıdır ve kapı doluysa başka kapı seçilir.
       */
      strictPort?: boolean;
      /** Yetki adresine eklenen ek parametreler (ör. Google `access_type=offline`). */
      authorizeParams?: Record<string, string>;
      /** SDK keşif durumu; geri dönüş bacağında yetki sunucusu doğrulaması için saklanır. */
      discovery?: OAuthDiscoveryState;
    };

interface StoredConnector {
  id: string;
  name: string;
  url: string;
  auth: StoredAuth;
  enabled: boolean;
  /** Aynı OAuth istemcisini paylaşan bağlayıcı ailesi (ör. "google"); kopyalama için. */
  clientGroup?: string;
  /**
   * Uygulama içi servis: MCP yok, `url` sağlayıcı API'sinin köküdür ve belirteç oraya gider.
   * OAuth keşfi `authServerUrl` üzerinden yapılır (Google: accounts.google.com).
   */
  native?: NativeConnector;
  /** Son girişin hesabı (e-posta ya da ad); çıkışta silinir. Yalnız gösterim içindir. */
  account?: string;
  /** Sunucudaki araç adı → izin; yazılmayan araç `ask` sayılır (oturumun izin moduna uyar). */
  toolPolicies?: Record<string, McpToolPolicy>;
  /** Yerel komut (stdio) sunucusu; varsa `url` boştur ve kimlik doğrulama yoktur. */
  stdio?: StoredStdio;
  /**
   * Onaylanmış araç tanımları: araç adı → özet. İlk boş olmayan listede hepsi sabitlenir; sonra
   * eklenen ya da değişen araç onaylanana kadar ajana verilmez. Uygulama içi servislerde yok
   * (araçları yereldir).
   */
  pins?: Record<string, ToolPin>;
}

interface ToolPin {
  /** Ad + açıklama + girdi şemasının SHA-256 özeti (kanonik JSON). */
  hash: string;
  /** Onaylanan açıklama: değişiklikte eskisini göstermek için. */
  description: string;
  /** Yalnız girdi şemasının özeti: "parametreler de değişti" ayrımı için. */
  schemaHash: string;
}

/** Yerel komut tanımı. `env` değerleri sırdır (API anahtarı olabilir): renderer'a gitmez. */
interface StoredStdio {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

interface NativeConnector {
  service: NativeServiceId;
  authServerUrl: string;
  /** Drive API kökü (dosya arama ve bağlantı denetimi); yalnızca testte değişir. */
  driveUrl?: string;
}

interface StoreFile {
  version: 1;
  connectors: StoredConnector[];
}

interface ConnectorTool extends CatalogEntry {
  def: ToolDefinition;
}

interface Runtime {
  status: McpConnector["status"];
  error: string | null;
  tools: Tool[];
  client: Client | null;
  /** Yerel komutun stderr kuyruğu (son STDERR_TAIL_CHARS karakter); her bağlanmada sıfırlanır. */
  stderr: string;
  /** Bağlantı anındaki araç adları; list_changed farkı buna göre hesaplanır. */
  baseline: Set<string>;
  /** Bağlandıktan sonra sunucunun eklediği/kaldırdığı araçlar; fark yoksa null. */
  toolChange: McpConnector["toolChange"];
  /** Sunucu `resources` yeteneği bildirdi mi. */
  resources: boolean;
  /** Sunucunun istem şablonları (`prompts` yeteneği varsa). */
  prompts: Prompt[];
}

/** Kaynak listesinde bağlayıcı başına en çok satır; fazlası sayı olarak yazılır. */
const RESOURCE_LIST_LIMIT = 100;
/** İşlenmiş istem metninin üst sınırı: kompozere yazılır, her turda yeniden gönderilir. */
const PROMPT_TEXT_LIMIT = 40_000;

/** Ayarlar satırında gösterilen stderr kuyruğunun uzunluğu. */
const STDERR_TAIL_CHARS = 2_000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface McpAddInput {
  name: string;
  url: string;
  /** Sabit Bearer belirteci (API anahtarı). */
  token?: string | null | undefined;
  /** DCR desteklemeyen sunucular için kullanıcının kendi OAuth istemcisi. */
  oauthClient?: { clientId: string; clientSecret: string } | null | undefined;
  /** Aynı ailedeki (`clientGroup`) bağlayıcının istemcisini kopyala. */
  copyClientFrom?: string | null | undefined;
  authorizeParams?: Record<string, string> | null | undefined;
  clientGroup?: string | null | undefined;
  /** Uygulama içi servis (ör. Google Drive API); `authServerUrl` yalnızca testte değişir. */
  native?:
    | {
        service: NativeServiceId;
        authServerUrl?: string | undefined;
        driveUrl?: string | undefined;
      }
    | null
    | undefined;
}

export interface McpStdioInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null | undefined;
}

/**
 * Otomatik yeniden deneme debounce'u: uykudan dönüş ve çevrimiçi geçişi aynı anda tetikleyebilir;
 * başarısız denemeler de sunucuyu boğmasın.
 */
const RECONNECT_DEBOUNCE_MS = 5_000;

export interface McpManagerConfig {
  /** Belirteçlerin de tutulduğu dosya (agentDir/mcp.json, 0600). */
  storePath: string;
  /** OAuth giriş adresini tarayıcıda açar (Electron `shell.openExternal`). */
  openExternal: (url: string) => Promise<void> | void;
  language?: Locale;
  appVersion?: string;
  /**
   * Uygulamayla gelen OAuth istemcileri: `clientGroup` → istemci. Dinamik istemci kaydı sunmayan
   * sağlayıcılarda (Google) kullanıcı kendi Cloud projesini açmak zorunda kalmasın diye kullanılır.
   */
  builtInClients?: Record<string, { clientId: string; clientSecret: string }>;
  /** Zaman kaynağı; yeniden deneme debounce'u testlerde enjekte edilebilir olsun. */
  now?: () => number;
  /**
   * Yerel komutların PATH'i. Main login kabuğundan zenginleştirilmiş PATH'i verir (Dock'tan açılan
   * uygulama `npx`/`uvx`'i bulsun); verilmezse süreç ortamındaki PATH kullanılır.
   */
  stdioPath?: () => string | undefined;
}

/** Bağlayıcı araçlarının ad öneki; engine aktif araç kümesini ve araç kartı başlığını buna göre seçer. */
export const MCP_TOOL_PREFIX = "mcp_";

/** Ajanın gördüğü araç adı: `mcp_<bağlayıcı>_<araç>`, yalnızca [a-z0-9_], en çok 64 karakter. */
export function agentToolName(connectorName: string, toolName: string): string {
  const slug = (s: string) =>
    fold(s)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const name = `mcp_${slug(connectorName) || "sunucu"}_${slug(toolName) || "arac"}`;
  return name.slice(0, 64).replace(/_+$/g, "");
}

/** Yalnızca https; düz http yalnızca yerel geliştirme (loopback) için serbest. */
export function assertConnectorUrl(raw: string, lang: Locale = "tr"): URL {
  const d = dict(lang);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(d.errors.invalidUrl.replace("{{url}}", raw));
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(d.errors.mcpHttpsOnly);
  return url;
}

/** Aracın kayıtlı izni; yazılmamışsa `ask` (oturumun izin moduna uyar). */
function policyOf(c: StoredConnector, toolName: string): McpToolPolicy {
  return c.toolPolicies?.[toolName] ?? "ask";
}

/**
 * Aracın onay durumu: sabitleme yoksa (uygulama içi servis ya da henüz ilk liste gelmedi) onaylı;
 * kayıtta yoksa `new`, özet farklıysa `changed`.
 */
function reviewOf(c: StoredConnector, tool: Tool): "new" | "changed" | null {
  if (c.native || !c.pins) return null;
  const pin = c.pins[tool.name];
  if (!pin) return "new";
  return pin.hash === toolPin(tool).hash ? null : "changed";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Yerel komutun ortamı: süreç ortamı **miras alınmaz**. Main'in ortamında Codezal'ın kimlik yolları
 * (`PI_CODING_AGENT_DIR`) ve sağlayıcı anahtarları olabilir; kullanıcının eklediği bir komut bunları
 * görmemeli. SDK yalnız güvenli temel değişkenleri (HOME, USER, SHELL, TERM, …) ekler; PATH main'in
 * çözdüğü değerle ezilir, kullanıcının verdiği `env` en sonda gelir.
 */
export function stdioEnv(
  userEnv: Record<string, string>,
  path: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (path) env.PATH = path;
  for (const [key, value] of Object.entries(userEnv)) env[key] = value;
  return env;
}

/**
 * Anahtarları sıralı JSON: sunucu aynı şemayı farklı anahtar sırasıyla döndürebilir, özet yalnız
 * içerik değişince değişmeli. `undefined` alanlar JSON'daki gibi atlanır.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Aracın sabitleme özeti; liste nesneleri değişmediği sürece önbellekten gelir. */
const pinCache = new WeakMap<Tool, ToolPin>();
export function toolPin(tool: Tool): ToolPin {
  const cached = pinCache.get(tool);
  if (cached) return cached;
  const description = tool.description ?? "";
  const pin = {
    hash: sha256(
      canonicalJson({ name: tool.name, description, inputSchema: tool.inputSchema ?? null }),
    ),
    description,
    schemaHash: sha256(canonicalJson(tool.inputSchema ?? null)),
  };
  pinCache.set(tool, pin);
  return pin;
}

/** Gösterim için komut satırı; boşluk içeren argüman tırnaklanır. */
function commandLine(stdio: StoredStdio): string {
  const quote = (s: string) => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  return [stdio.command, ...stdio.args].map(quote).join(" ");
}

/** stderr kuyruğunda kullanıcının verdiği ortam değerlerini maskeler (anahtar ekrana basılmasın). */
function redactEnv(text: string, env: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(env))
    if (value.length >= 4) out = out.split(value).join("••••");
  return out;
}

/** OAuth sunucusu dinamik istemci kaydı (DCR) sunmuyorsa katalog/native yola yönlendirilir. */
function isNoDynamicClientRegistration(e: unknown): boolean {
  return errorMessage(e).includes("does not support dynamic client registration");
}

/**
 * OIDC `id_token` gövdesinden hesap adı: e-posta, yoksa kullanıcı adı ya da ad. İmza doğrulanmaz;
 * belirteç yetki sunucusundan doğrudan geldi ve değer yalnız arayüzde gösterilir.
 */
export function accountFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const key of ["email", "preferred_username", "name"]) {
      const v = claims[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    // Bozuk belirteç: hesap bilinmiyor sayılır.
  }
  return null;
}

/** SDK'nın `SdkHttpError`'ı: durum kodu `status` alanında, gövde `message` içinde. */
function httpStatus(e: unknown): number | null {
  if (typeof e !== "object" || e === null || !("status" in e)) return null;
  const s = (e as { status: unknown }).status;
  return typeof s === "number" ? s : null;
}

/** 401: SDK, authProvider varsa `UnauthorizedError`, yoksa durum kodlu `SdkHttpError` fırlatır. */
function isUnauthorized(e: unknown): boolean {
  if (UnauthorizedError.isInstance(e) || (e instanceof Error && e.name === "UnauthorizedError"))
    return true;
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    (e as { status: unknown }).status === 401
  );
}

/**
 * MCP içerik bloklarını Pi araç sonucuna çevirir; metin ve görsel geçer, gerisi JSON olur.
 * Metin bütçesi burada uygulanır: uzak sunucu tek çağrıda megabayt döndürebilir ve o metin her
 * sonraki turda yeniden gönderilir (`tool-budget.ts`).
 */
export function toAgentContent(
  content: CallToolResult["content"],
): Array<TextContent | ImageContent> {
  const out: Array<TextContent | ImageContent> = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "image")
      out.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.type === "resource" && "text" in block.resource)
      out.push({ type: "text", text: String(block.resource.text) });
    else out.push({ type: "text", text: JSON.stringify(block) });
  }
  return boundTextBlocks(out);
}

/**
 * Bağlayıcı başına OAuth sağlayıcısı: istemci kaydı, belirteçler ve PKCE doğrulayıcısı mağazaya
 * yazılır. Etkileşimli değilken yönlendirme isteği "giriş gerekli" hatasına dönüşür; böylece bir
 * araç çağrısı sırasında tarayıcı açılmaz, kullanıcı Ayarlar'dan giriş yapar.
 */
class ConnectorOAuthProvider implements OAuthClientProvider {
  #state: string | null = null;

  constructor(
    private readonly auth: Extract<StoredAuth, { kind: "oauth" }>,
    private readonly persist: () => void,
    private readonly redirect: string,
    private readonly onRedirect: ((url: URL) => Promise<void> | void) | null,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Codezal",
      client_uri: "https://codezal.app",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Kimlik yöntemi sunucuya bırakılır: kimi sunucu (Supabase, monday) yalnızca gizli anahtarlı
      // istemci verir; SDK dönen bilgiye göre yöntemi seçer.
    };
  }

  state(): string {
    this.#state = randomBytes(16).toString("hex");
    return this.#state;
  }

  get expectedState(): string | null {
    return this.#state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    if (this.auth.client) return this.auth.client;
    // Kendi istemcisi olan bağlayıcı: sunucu DCR desteklemez, kullanıcı kimlikleri girmiştir.
    if (this.auth.preset)
      return { client_id: this.auth.preset.clientId, client_secret: this.auth.preset.clientSecret };
    return undefined;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.auth.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.auth.discovery = state;
    this.persist();
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.auth.client = info;
    this.persist();
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.auth.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.auth.tokens = tokens;
    this.persist();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.onRedirect) throw new UnauthorizedError("login required");
    for (const [k, v] of Object.entries(this.auth.authorizeParams ?? {}))
      url.searchParams.set(k, v);
    await this.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.auth.verifier = verifier;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.auth.verifier) throw new UnauthorizedError("missing code verifier");
    return this.auth.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") delete this.auth.client;
    if (scope === "all" || scope === "tokens") delete this.auth.tokens;
    if (scope === "all" || scope === "verifier") delete this.auth.verifier;
    if (scope === "all" || scope === "discovery") delete this.auth.discovery;
    this.persist();
  }
}

interface CallbackServer {
  port: number;
  wait: (expectedState: () => string | null) => Promise<URLSearchParams>;
  close: () => void;
}

/**
 * Uzak MCP sunucuları (Streamable HTTP). Her bağlayıcı için bir istemci tutar, araç listesini
 * Pi araç tanımlarına çevirir ve inline uzantı üzerinden oturumlara kaydeder. Belirteçler
 * `storePath` içinde düz JSON'dur (auth.json ile aynı yaklaşım, 0600); renderer'a hiç gitmez.
 */
export class McpManager {
  readonly #config: McpManagerConfig;
  readonly #lang: Locale;
  #file: StoreFile;
  readonly #runtime = new Map<string, Runtime>();
  readonly #listeners = new Set<() => void>();
  readonly #toolsListeners = new Set<() => void>();
  /**
   * Oturum başına uzantı aboneliklerini bırakan kapanışlar. Gerekli çünkü `AgentSession.dispose()`
   * `session_shutdown` yaymaz: oturum her kapatıldığında `sync` aboneliği `#listeners` içinde
   * kalıyor, ölü oturumun uzantı kapsamını tutuyor ve her bağlantı değişiminde boşuna çalışıyordu.
   */
  readonly #sessionOffs = new Map<string, Set<() => void>>();
  readonly #connecting = new Map<string, Promise<void>>();
  readonly #now: () => number;
  /** Son otomatik yeniden deneme zamanı (debounce); 0 = hiç denenmedi. */
  #lastReconnectAt = 0;
  /** Bağlı araç kümesinin son imzası; değişince `#toolsListeners` tetiklenir. */
  #lastToolsSignature = "";

  constructor(config: McpManagerConfig) {
    this.#config = config;
    this.#lang = config.language ?? "tr";
    this.#now = config.now ?? (() => Date.now());
    this.#file = this.#load();
    this.#lastToolsSignature = this.#toolsSignature();
  }

  get #d() {
    return dict(this.#lang);
  }

  // ---------- kalıcılık ----------

  #load(): StoreFile {
    const path = this.#config.storePath;
    if (!existsSync(path)) return { version: 1, connectors: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
      return { version: 1, connectors: Array.isArray(parsed.connectors) ? parsed.connectors : [] };
    } catch {
      return { version: 1, connectors: [] };
    }
  }

  #save(): void {
    const path = this.#config.storePath;
    // Atomik yazım: çökme ya da kilit (Windows EBUSY) anında belirteç dosyası yarım kalıp bütün
    // bağlayıcıları düşürmesin. Geçici dosya 0600 doğar; `chmod` eski dosyaların iznini düzeltir.
    writeFileAtomic(path, JSON.stringify(this.#file, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  #require(id: string): StoredConnector {
    const c = this.#file.connectors.find((x) => x.id === id);
    if (!c) throw new Error(this.#d.errors.mcpNotFound.replace("{{id}}", id));
    return c;
  }

  #rt(id: string): Runtime {
    let rt = this.#runtime.get(id);
    if (!rt) {
      rt = {
        status: "disconnected",
        error: null,
        tools: [],
        client: null,
        stderr: "",
        baseline: new Set(),
        toolChange: null,
        resources: false,
        prompts: [],
      };
      this.#runtime.set(id, rt);
    }
    return rt;
  }

  // ---------- olaylar ----------

  /** Uygulamayla gelen istemcisi olan aileler; arayüz bunlarda kimlik formu göstermez. */
  builtInClientGroups(): string[] {
    return Object.keys(this.#config.builtInClients ?? {});
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Bağlı MCP araç kümesi değiştiğinde tetiklenir: servis eklendi/kaldırıldı, kapatıldı ya da
   * sunucu `tools/list_changed` bildirimi gönderdi. Aynı araç kümesiyle durum değişimlerinde de
   * (yeniden bağlanma) tetiklenir; engine buna açık oturumları tazelemek için abone olur.
   */
  onToolsChanged(listener: () => void): () => void {
    this.#toolsListeners.add(listener);
    return () => this.#toolsListeners.delete(listener);
  }

  #emit(): void {
    for (const l of this.#listeners) l();
    const signature = this.#toolsSignature();
    if (signature === this.#lastToolsSignature) return;
    this.#lastToolsSignature = signature;
    for (const l of this.#toolsListeners) l();
  }

  /**
   * Bağlı araç kümesinin imzası: yalnız `connected` durumdaki bağlayıcıların ajan araç adları.
   * `connecting` gibi ara durumlar imzayı değiştirmez; eşitse tazeleme gerekmez.
   */
  #toolsSignature(): string {
    return this.#entries()
      .map((e) => e.name)
      .sort()
      .join("|");
  }

  // ---------- sorgu ----------

  list(): McpConnector[] {
    return this.#file.connectors.map((c) => this.#summary(c));
  }

  #summary(c: StoredConnector): McpConnector {
    const rt = this.#rt(c.id);
    const tools: McpToolInfo[] = rt.tools.map((t) => {
      const review = reviewOf(c, t);
      const pin = review === "changed" ? c.pins?.[t.name] : undefined;
      return {
        name: t.name,
        agentName: agentToolName(c.name, t.name),
        description: t.description ?? "",
        readOnly: t.annotations?.readOnlyHint === true,
        policy: policyOf(c, t.name),
        review,
        previousDescription: pin?.description ?? null,
        schemaChanged: pin !== undefined && pin.schemaHash !== toolPin(t).schemaHash,
      };
    });
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      auth: c.auth.kind,
      ownClient: this.#ownClient(c),
      clientGroup: c.clientGroup ?? null,
      native: c.native?.service ?? null,
      enabled: c.enabled,
      status: rt.status,
      account: c.account ?? null,
      tools,
      error: rt.error,
      transport: c.stdio ? "stdio" : "http",
      command: c.stdio ? commandLine(c.stdio) : null,
      cwd: c.stdio?.cwd ?? null,
      envKeys: c.stdio ? Object.keys(c.stdio.env) : [],
      stderr:
        c.stdio && rt.status === "error" && rt.stderr.trim()
          ? redactEnv(rt.stderr.trim(), c.stdio.env)
          : null,
      toolChange: rt.status === "connected" ? rt.toolChange : null,
      resources: rt.status === "connected" && rt.resources,
      prompts:
        rt.status === "connected"
          ? rt.prompts.map((p) => ({
              name: p.name,
              title: p.title ?? null,
              description: p.description ?? "",
              arguments: (p.arguments ?? []).map((a) => ({
                name: a.name,
                description: a.description ?? "",
                required: a.required === true,
              })),
            }))
          : [],
    };
  }

  /**
   * Kullanıcının girdiği OAuth istemcisi mi? Uygulamayla gelen istemci de mağazaya `preset` olarak
   * yazılır; onu "kendi istemcin" diye göstermek yanlıştı (kullanıcı hiçbir kimlik girmedi).
   */
  #ownClient(c: StoredConnector): boolean {
    if (c.auth.kind !== "oauth" || !c.auth.preset) return false;
    const builtIn = c.clientGroup ? this.#config.builtInClients?.[c.clientGroup] : undefined;
    return builtIn?.clientId !== c.auth.preset.clientId;
  }

  /**
   * Ajan araç adının (`mcp_<bağlayıcı>_<araç>`) izni; bağlayıcı aracı değilse `undefined`. İzin
   * kapısı her çağrıda buna bakar, böylece Ayarlar'daki değişiklik açık oturumda da hemen geçerlidir.
   */
  toolPolicy(agentName: string): McpToolPolicy | undefined {
    if (!agentName.startsWith(MCP_TOOL_PREFIX)) return undefined;
    for (const c of this.#file.connectors)
      for (const t of this.#rt(c.id).tools)
        if (agentToolName(c.name, t.name) === agentName) return policyOf(c, t.name);
    return undefined;
  }

  /** Bağlı bağlayıcıların araçları, Pi araç tanımı olarak. */
  toolDefinitions(): ToolDefinition[] {
    return this.#entries().map((e) => e.def);
  }

  /** Bağlı araçlar: katalog özeti ve Pi tanımı bir arada. Kapalı (`off`) araçlar ajana gitmez. */
  #entries(): ConnectorTool[] {
    const out: ConnectorTool[] = [];
    for (const c of this.#file.connectors) {
      const rt = this.#rt(c.id);
      if (rt.status !== "connected") continue;
      for (const tool of rt.tools) {
        if (policyOf(c, tool.name) === "off") continue;
        // Onay bekleyen (yeni ya da tanımı değişen) araç modele gösterilmez: açıklaması zehirli
        // talimat taşıyor olabilir.
        if (reviewOf(c, tool) !== null) continue;
        out.push({
          connector: c.name,
          name: agentToolName(c.name, tool.name),
          description: tool.description ?? tool.name,
          def: this.#definition(c, tool),
        });
      }
    }
    // Kaynak sunan bağlı servis varsa tek ortak araç: kaynak sayısı araç sayısını şişirmesin.
    if (this.#resourceConnectors().length > 0) {
      const def = this.#resourcesTool();
      out.push({ connector: def.label, name: def.name, description: def.description, def });
    }
    return out;
  }

  /** Kaynak sunan bağlı (MCP) bağlayıcılar. */
  #resourceConnectors(): StoredConnector[] {
    return this.#file.connectors.filter((c) => {
      const rt = this.#rt(c.id);
      return rt.status === "connected" && rt.resources && rt.client !== null;
    });
  }

  /**
   * `mcp_resources`: kaynakları listeler ve okur. Yalnız metin içerik döner (ikili içerik atlanır),
   * toplam metin araç bütçesiyle sınırlanır. Kaynak metni de servisten gelen veridir.
   */
  #resourcesTool(): ToolDefinition {
    const d = this.#d;
    return {
      name: RESOURCES_TOOL,
      label: d.agent.tool.mcpResources,
      description: d.prompt.mcpResourcesDesc,
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("read")], {
          description: d.prompt.mcpResourcesAction,
        }),
        connector: Type.Optional(Type.String({ description: d.prompt.mcpResourcesConnector })),
        uri: Type.Optional(Type.String({ description: d.prompt.mcpResourcesUri })),
      }),
      execute: async (_id, params, signal) => {
        const p = params as { action?: unknown; connector?: unknown; uri?: unknown };
        const connector = typeof p.connector === "string" ? p.connector.trim() : "";
        const uri = typeof p.uri === "string" ? p.uri.trim() : "";
        const text =
          p.action === "read"
            ? await this.#readResource(connector, uri, signal)
            : await this.#listResources(connector, signal);
        return {
          content: boundTextBlocks(text.map((t) => ({ type: "text" as const, text: t }))),
          details: { tool: RESOURCES_TOOL, action: p.action === "read" ? "read" : "list" },
        };
      },
    };
  }

  /** Adı (aksan ve büyük harf duyarsız) verilen kaynaklı bağlayıcı; yoksa açık hata. */
  #resourceConnector(name: string): StoredConnector {
    const all = this.#resourceConnectors();
    const found = all.find((c) => fold(c.name) === fold(name));
    if (found) return found;
    throw new Error(
      this.#d.errors.mcpResourceConnector.replace(
        "{{names}}",
        all.map((c) => c.name).join(", ") || "-",
      ),
    );
  }

  async #listResources(name: string, signal: AbortSignal | undefined): Promise<string[]> {
    const d = this.#d;
    const targets = name ? [this.#resourceConnector(name)] : this.#resourceConnectors();
    if (targets.length === 0) return [d.prompt.mcpResourcesNone];
    const blocks: string[] = [];
    for (const c of targets) {
      const client = this.#rt(c.id).client;
      if (!client) continue;
      const opts = { ...(signal ? { signal } : {}), timeout: CALL_TIMEOUT_MS };
      const { resources } = await client.listResources(undefined, opts);
      const templates = await client
        .listResourceTemplates(undefined, opts)
        .then((r) => r.resourceTemplates)
        .catch(() => []);
      const lines = [`## ${c.name}`];
      for (const r of resources.slice(0, RESOURCE_LIST_LIMIT)) {
        const about = [r.mimeType, r.title ?? r.name, r.description].filter(Boolean).join(" · ");
        lines.push(`- ${r.uri}${about ? ` — ${about}` : ""}`);
      }
      if (resources.length > RESOURCE_LIST_LIMIT)
        lines.push(
          d.prompt.mcpResourcesMore.replace(
            "{{count}}",
            String(resources.length - RESOURCE_LIST_LIMIT),
          ),
        );
      if (resources.length === 0 && templates.length === 0) lines.push(d.prompt.mcpResourcesEmpty);
      if (templates.length > 0) {
        lines.push(d.prompt.mcpResourcesTemplates);
        for (const t of templates.slice(0, RESOURCE_LIST_LIMIT))
          lines.push(`- ${t.uriTemplate}${t.description ? ` — ${t.description}` : ""}`);
      }
      blocks.push(lines.join("\n"));
    }
    return [blocks.join("\n\n")];
  }

  async #readResource(
    name: string,
    uri: string,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const d = this.#d;
    const c = this.#resourceConnector(name);
    if (!uri) throw new Error(d.errors.mcpResourceUri);
    const client = this.#rt(c.id).client;
    if (!client) throw new Error(d.errors.mcpNotConnected.replace("{{name}}", c.name));
    const { contents } = await client.readResource(
      { uri },
      { ...(signal ? { signal } : {}), timeout: CALL_TIMEOUT_MS },
    );
    return contents.map((item) => {
      if ("text" in item && typeof item.text === "string")
        return wrapUntrusted(`${c.name}/${item.uri}`, item.text, this.#lang, "service");
      const blob = "blob" in item && typeof item.blob === "string" ? item.blob : "";
      return `${item.uri}\n\n${d.prompt.mcpResourcesBinary
        .replace("{{mime}}", item.mimeType ?? "?")
        .replace("{{bytes}}", String(Math.floor((blob.length * 3) / 4)))}`;
    });
  }

  /**
   * İstemi argümanlarla işler; mesaj metinleri boş satırla birleştirilir. Görsel ve ikili içerik
   * atlanır; gömülü metin kaynağı eklenir. Sonuç kompozere yazılır, kullanıcı görmeden gitmez.
   */
  async getPrompt(id: string, name: string, args: Record<string, string>): Promise<string> {
    const c = this.#require(id);
    const rt = this.#rt(id);
    const client = rt.client;
    if (!client || rt.status !== "connected")
      throw new Error(this.#d.errors.mcpNotConnected.replace("{{name}}", c.name));
    if (!rt.prompts.some((p) => p.name === name))
      throw new Error(
        this.#d.errors.mcpPromptNotFound.replace("{{name}}", c.name).replace("{{prompt}}", name),
      );
    const result = await client.getPrompt({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS });
    const parts: string[] = [];
    for (const message of result.messages) {
      const content = message.content;
      if (content.type === "text") parts.push(content.text);
      else if (content.type === "resource" && "text" in content.resource)
        parts.push(String(content.resource.text));
    }
    return truncateToolText(parts.join("\n\n").trim(), PROMPT_TEXT_LIMIT);
  }

  #definition(c: StoredConnector, tool: Tool): ToolDefinition {
    const description = `[${c.name}] ${tool.description ?? tool.name}`;
    return {
      name: agentToolName(c.name, tool.name),
      label: tool.title ?? tool.name,
      description,
      // MCP inputSchema düz JSON Schema; Pi (TypeBox derleyicisi) doğrudan derleyebiliyor.
      parameters: tool.inputSchema as unknown as TSchema,
      execute: (_id, params, signal) =>
        this.#call(c.id, tool.name, params as Record<string, unknown>, signal),
    };
  }

  /**
   * Pi inline uzantısı: oturum açılırken bağlı araçları kaydeder, sonradan bağlanan sunucuların
   * araçlarını da canlı oturuma ekler. Kaldırılan araç Pi'den geri alınamaz; çağrılırsa
   * "bağlı değil" hatası döner.
   *
   * Toplam araç DIRECT_TOOL_LIMIT'i aşınca kalanlar ertelenir: sistem istemine her turda tek
   * satırlık katalog eklenir ve `tool_search` eşleşenleri kaydeder. Pi kaydı tur ortasında da
   * yeniler, yüklenen araç aynı turun bir sonraki model çağrısında kullanılabilir. İstemde adı
   * geçen bağlayıcının araçları aramaya gerek kalmadan önden yüklenir (çok araçlı sunucular hariç).
   */
  extension(sessionId?: string): (pi: ExtensionAPI) => void {
    return (pi) => {
      const loaded = new Set<string>();
      let searchRegistered = false;
      let off = () => {};
      /** Son eklenen katalog metni: aynısı ikinci kez bağlama yazılmaz (bkz. aşağıdaki not). */
      let lastCatalog = "";
      // Oturum kimliği verildiğinde abonelik izlenir: oturum kapanınca `forgetSession` bırakır.
      if (sessionId) {
        const offs = this.#sessionOffs.get(sessionId) ?? new Set<() => void>();
        offs.add(() => off());
        this.#sessionOffs.set(sessionId, offs);
      }
      const pending = () => this.#entries().filter((e) => !loaded.has(e.name));
      // Kapatılan oturumun Pi bağlamı geçersizleşir ama `dispose` session_shutdown yaymaz; kayıt
      // hatası alınca dinlemeyi bırakırız, yoksa sonraki bağlantı o eski oturumda patlardı.
      const register = (def: ToolDefinition): boolean => {
        try {
          pi.registerTool(def);
          return true;
        } catch {
          off();
          return false;
        }
      };
      /**
       * Pi'de araç kaydı geri alınamaz; çekilen araç (sunucu kaldırdı, bağlantı düştü, araç kapatıldı)
       * etkin kümeden düşürülür. Aynı adla yeniden kaydedilen araç Pi'de kendiliğinden etkinleşmez
       * (kayıtta zaten vardı); `retired` onu tanır ve yükleme sırasında yeniden etkinleştirir.
       * Eski bağlam ya da etkin küme API'si olmayan taklit hata verirse sessizce geçilir.
       */
      const retired = new Set<string>();
      const setActive = (next: (names: string[]) => string[]) => {
        try {
          pi.setActiveTools(next(pi.getActiveTools()));
        } catch {
          // Oturum kapanmış ya da bağlam geçersiz: bir sonraki tazeleme kümeyi baştan kurar.
        }
      };
      const load = (entries: readonly ConnectorTool[]) => {
        const revived: string[] = [];
        for (const e of entries) {
          if (loaded.has(e.name)) continue;
          if (!register(e.def)) return;
          loaded.add(e.name);
          if (retired.delete(e.name)) revived.push(e.name);
        }
        if (revived.length > 0) setActive((names) => [...new Set([...names, ...revived])]);
      };
      const retire = () => {
        const current = new Set(this.#entries().map((e) => e.name));
        const gone = [...loaded].filter((name) => !current.has(name));
        if (gone.length === 0) return;
        for (const name of gone) {
          loaded.delete(name);
          retired.add(name);
        }
        const drop = new Set(gone);
        setActive((names) => names.filter((n) => !drop.has(n)));
      };
      const sync = () => {
        retire();
        const rest = pending();
        if (rest.length === 0) return;
        if (loaded.size + rest.length <= DIRECT_TOOL_LIMIT) {
          load(rest);
          return;
        }
        if (searchRegistered) return;
        searchRegistered = register(this.#searchTool(pending, load));
      };
      sync();
      off = this.onChange(sync);
      pi.on("before_agent_start", (event) => {
        const entries = this.#entries();
        const waiting = () => entries.filter((e) => !loaded.has(e.name));
        if (waiting().length === 0) return undefined;
        const names = [...new Set(waiting().map((e) => e.connector))];
        let budget = PRELOAD_LIMIT;
        for (const connector of mentionedConnectors(event.prompt, names)) {
          const own = entries.filter((e) => e.connector === connector);
          // Çok araçlı sunucu önden yüklenmez; ölçü bekleyen değil bağlayıcının toplam araç
          // sayısıdır, yoksa 40 araçlı servis birkaç aramadan sonra bu kapıdan tümüyle geçiyordu.
          if (own.length > MANY_TOOLS) continue;
          const rest = own.filter((e) => !loaded.has(e.name));
          // Sığmayan bağlayıcı atlanır, döngü sürer: küçük bağlayıcılar büyüğün yüzünden aç kalmaz.
          if (rest.length > budget) continue;
          budget -= rest.length;
          load(rest);
        }
        const rest = waiting();
        if (rest.length === 0) return undefined;
        // Katalog sistem istemine **eklenmez**: araç adı ve açıklaması uzak sunucudan gelir ve
        // sistem istemi en yüksek güven konumudur — kötü niyetli bir bağlayıcı oraya talimat
        // yazdırabilirdi. Kullanıcı rolünde, çizilmeyen bir mesaj olarak verilir: model onu veri
        // olarak görür, oturum dosyasına yazılır ama arayüzde satır açmaz.
        //
        // Mesaj **yalnız bekleyen küme değiştiğinde** eklenir. Her turda eklenirse (bekleyen
        // araçlar hiç yüklenmediğinde durum budur) aynı birkaç kilobayt her turda bağlama
        // yazılır, oturum dosyası büyür ve tam da kaçınmaya çalıştığımız sıkıştırmayı tetikler.
        const catalog = catalogText(rest, this.#lang);
        if (catalog === lastCatalog) return undefined;
        lastCatalog = catalog;
        return {
          message: { customType: MCP_CATALOG_TYPE, content: catalog, display: false },
        };
      });
      pi.on("session_shutdown", () => off());
    };
  }

  /**
   * Oturum kapanınca/silinince o oturumun uzantı aboneliklerini bırakır. Motor çağırır:
   * `AgentSession.dispose()` `session_shutdown` yaymadığı için abonelik kendiliğinden düşmez.
   */
  forgetSession(sessionId: string): void {
    const offs = this.#sessionOffs.get(sessionId);
    if (!offs) return;
    this.#sessionOffs.delete(sessionId);
    for (const off of offs) off();
  }

  /** `tool_search`: katalogda arar, eşleşenleri Pi'ye kaydeder ve modele listesini döner. */
  #searchTool(
    pending: () => ConnectorTool[],
    load: (entries: readonly ConnectorTool[]) => void,
  ): ToolDefinition {
    const d = this.#d;
    return {
      name: TOOL_SEARCH_TOOL,
      label: d.agent.tool.toolSearch,
      description: d.prompt.toolSearchDesc,
      promptSnippet: d.prompt.toolSearchSnippet,
      parameters: Type.Object({ query: Type.String({ description: d.prompt.toolSearchQuery }) }),
      execute: async (_id, params) => {
        const text = (t: string): AgentToolResult<unknown> => ({
          content: [{ type: "text", text: t }],
          details: undefined,
        });
        const rest = pending();
        if (rest.length === 0) return text(d.prompt.toolSearchAll);
        const query = String((params as { query?: unknown }).query ?? "");
        const hits = matchTools(query, rest);
        if (hits.length === 0) {
          const names = [...new Set(rest.map((e) => e.connector))].join(", ");
          return text(d.prompt.toolSearchNone.replace("{{names}}", names));
        }
        const picked = hits.slice(0, SEARCH_RESULTS);
        load(picked);
        const lines = [
          d.prompt.toolSearchLoaded,
          ...picked.map((e) => `- ${e.name}: ${catalogLine(e.description) || e.name}`),
        ];
        if (hits.length > picked.length)
          lines.push(
            d.prompt.toolSearchMore.replace("{{count}}", String(hits.length - picked.length)),
          );
        return text(lines.join("\n"));
      },
    };
  }

  // ---------- yaşam döngüsü ----------

  /** Açık bağlayıcılara arka planda bağlanır (uygulama açılışı). */
  start(): void {
    for (const c of this.#file.connectors) if (c.enabled) void this.connect(c.id).catch(() => {});
  }

  async dispose(): Promise<void> {
    for (const id of [...this.#runtime.keys()]) await this.#disconnect(id);
    this.#listeners.clear();
    this.#sessionOffs.clear();
  }

  // ---------- düzenleme ----------

  async add(input: McpAddInput): Promise<McpConnector> {
    const url = assertConnectorUrl(input.url, this.#lang);
    const name = input.name.trim();
    if (this.#file.connectors.some((c) => c.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      throw new Error(this.#d.errors.mcpDuplicate.replace("{{name}}", name));
    const token = input.token?.trim();
    let auth: StoredAuth = token ? { kind: "bearer", token } : { kind: "none" };
    // Kendi OAuth istemcisi: doğrudan girilen ya da aynı ailedeki bağlayıcıdan kopyalanan kimlikler.
    let preset = input.oauthClient ?? undefined;
    // Kullanıcı kendi istemcisini girdiyse yönlendirme adresini tek tek kaydetmiştir; kapı sabittir.
    let strictPort = preset !== undefined;
    if (!preset && input.copyClientFrom) {
      const from = this.#require(input.copyClientFrom);
      if (from.auth.kind === "oauth" && from.auth.preset) {
        preset = from.auth.preset;
        strictPort = from.auth.strictPort === true;
      }
    }
    // Uygulamayla gelen istemci: kullanıcıdan kimlik istemeden aynı aile için kullanılır.
    if (!preset && input.clientGroup) {
      preset = this.#config.builtInClients?.[input.clientGroup];
      if (preset) strictPort = false;
    }
    if (preset) {
      auth = {
        kind: "oauth",
        preset: { clientId: preset.clientId.trim(), clientSecret: preset.clientSecret.trim() },
        port: CALLBACK_PORT,
        ...(strictPort ? { strictPort: true } : {}),
        ...(input.authorizeParams ? { authorizeParams: input.authorizeParams } : {}),
      };
    } else if (input.native) {
      // Uygulama içi servis her zaman OAuth ister; istemci yoksa giriş keşifte dinamik kayıt dener.
      auth = {
        kind: "oauth",
        port: CALLBACK_PORT,
        ...(input.authorizeParams ? { authorizeParams: input.authorizeParams } : {}),
      };
    }
    const native: NativeConnector | null = input.native
      ? {
          service: input.native.service,
          authServerUrl:
            input.native.authServerUrl ?? NATIVE_SERVICES[input.native.service].authServerUrl,
          ...(input.native.driveUrl ? { driveUrl: input.native.driveUrl } : {}),
        }
      : null;
    const c: StoredConnector = {
      id: randomUUID(),
      name,
      url: url.href,
      auth,
      enabled: true,
      ...(input.clientGroup ? { clientGroup: input.clientGroup } : {}),
      ...(native ? { native } : {}),
    };
    this.#file.connectors.push(c);
    this.#save();
    this.#emit();
    await this.connect(c.id);
    return this.#summary(c);
  }

  /**
   * Yerel komut sunucusu ekler. Komutu yalnız kullanıcı ekler (ajanın bağlayıcı ekleyen aracı yok,
   * mcp.json izin kapısında kimlik dosyası sayılır); süreç kullanıcı yetkisiyle çalışır.
   */
  async addStdio(input: McpStdioInput): Promise<McpConnector> {
    const d = this.#d;
    const name = input.name.trim();
    const command = input.command.trim();
    if (!name || !command) throw new Error(d.errors.mcpCommandRequired);
    if (this.#file.connectors.some((c) => c.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      throw new Error(d.errors.mcpDuplicate.replace("{{name}}", name));
    for (const key of Object.keys(input.env))
      if (!ENV_KEY.test(key)) throw new Error(d.errors.mcpBadEnvKey.replace("{{key}}", key));
    const cwd = input.cwd?.trim();
    if (cwd) {
      let dir = false;
      try {
        dir = isAbsolute(cwd) && statSync(cwd).isDirectory();
      } catch {
        dir = false;
      }
      if (!dir) throw new Error(d.errors.mcpCwdMissing.replace("{{cwd}}", cwd));
    }
    const c: StoredConnector = {
      id: randomUUID(),
      name,
      url: "",
      auth: { kind: "none" },
      enabled: true,
      stdio: {
        command,
        args: input.args.filter((a) => a.length > 0),
        env: { ...input.env },
        ...(cwd ? { cwd } : {}),
      },
    };
    this.#file.connectors.push(c);
    this.#save();
    this.#emit();
    await this.connect(c.id);
    return this.#summary(c);
  }

  async update(
    id: string,
    patch: { name?: string | undefined; enabled?: boolean | undefined },
  ): Promise<void> {
    const c = this.#require(id);
    if (patch.name !== undefined) c.name = patch.name.trim();
    if (patch.enabled !== undefined) c.enabled = patch.enabled;
    this.#save();
    this.#emit();
    if (patch.enabled === false) await this.#disconnect(id);
    else if (patch.enabled === true) await this.connect(id);
  }

  /**
   * Araç izinlerini değiştirir. `ask` varsayılandır ve kayıttan silinir; `off` araç kümesini
   * değiştirdiği için `#emit` açık oturumları tazeler, `auto`/`ask` kapıda anında geçerlidir.
   */
  setToolPolicy(id: string, tools: readonly string[], policy: McpToolPolicy): void {
    const c = this.#require(id);
    const next = { ...c.toolPolicies };
    for (const tool of tools) {
      if (policy === "ask") delete next[tool];
      else next[tool] = policy;
    }
    if (Object.keys(next).length > 0) c.toolPolicies = next;
    else delete c.toolPolicies;
    this.#save();
    this.#emit();
  }

  /**
   * Onay bekleyen araçları onaylar: güncel tanım sabitlenir, araç ajana açılır ve `#emit` açık
   * oturumları tazeler. Bağlı listede olmayan ad yok sayılır (onaylanacak tanım yok).
   */
  approveTools(id: string, tools: readonly string[]): void {
    const c = this.#require(id);
    const names = new Set(tools);
    const pins = { ...c.pins };
    for (const tool of this.#rt(id).tools)
      if (names.has(tool.name)) pins[tool.name] = toolPin(tool);
    c.pins = pins;
    this.#save();
    this.#emit();
  }

  async remove(id: string): Promise<void> {
    this.#require(id);
    await this.#disconnect(id);
    this.#file.connectors = this.#file.connectors.filter((c) => c.id !== id);
    this.#runtime.delete(id);
    this.#save();
    this.#emit();
  }

  /** Belirteçleri siler; bağlayıcı `needs-login` durumuna düşer. */
  async logout(id: string): Promise<void> {
    const c = this.#require(id);
    await this.#disconnect(id);
    if (c.auth.kind === "oauth")
      c.auth = { kind: "oauth", ...(c.auth.port ? { port: c.auth.port } : {}) };
    else c.auth = { kind: "none" };
    delete c.account;
    this.#save();
    const rt = this.#rt(id);
    rt.status = "needs-login";
    rt.error = null;
    this.#emit();
  }

  // ---------- bağlantı ----------

  /**
   * Durumu hata/bağlı değil olan etkin bağlayıcıları yeniden dener ve denenen sayısını döndürür.
   * Main ağ nöbetçisi (uykudan dönüş, çevrimiçi geçişi) ile Servisler sayfasının açılışı aynı yolu
   * kullanır; debounce eşzamanlı tetikleri tek denemeye indirir.
   */
  async reconnectFailed(): Promise<number> {
    const now = this.#now();
    if (now - this.#lastReconnectAt < RECONNECT_DEBOUNCE_MS) return 0;
    this.#lastReconnectAt = now;
    const targets = this.list().filter(
      (c) => c.enabled && (c.status === "error" || c.status === "disconnected"),
    );
    for (const c of targets) {
      try {
        await this.connect(c.id);
      } catch {
        // Hata duruma yazılır ve `mcp:changed` yayınlanır; otomatik deneme sessiz kalır.
      }
    }
    return targets.length;
  }

  async connect(id: string): Promise<void> {
    const pending = this.#connecting.get(id);
    if (pending) return pending;
    const run = this.#connect(id).finally(() => this.#connecting.delete(id));
    this.#connecting.set(id, run);
    return run;
  }

  #transport(c: StoredConnector, interactive: ConnectorOAuthProvider | null) {
    const url = new URL(c.url);
    if (c.auth.kind === "bearer")
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${c.auth.token}` } },
      });
    if (c.auth.kind === "oauth") {
      const provider = interactive ?? this.#provider(c.auth, null);
      return new StreamableHTTPClientTransport(url, { authProvider: provider });
    }
    return new StreamableHTTPClientTransport(url);
  }

  #provider(
    auth: Extract<StoredAuth, { kind: "oauth" }>,
    onRedirect: ((url: URL) => Promise<void> | void) | null,
    port = auth.port ?? CALLBACK_PORT,
  ): ConnectorOAuthProvider {
    return new ConnectorOAuthProvider(
      auth,
      () => this.#save(),
      `http://127.0.0.1:${port}/callback`,
      onRedirect,
    );
  }

  /**
   * İlk güven (TOFU): kayıtlı sabitleme yoksa ilk boş olmayan listedeki araçlar onaylı sayılıp
   * sabitlenir. Eski sürümden gelen bağlayıcılar da böylece ilk bağlantıda sabitlenir. Boş liste
   * sabitlenmez; yoksa giriş sonrası araç açan sunucunun bütün araçları "yeni" görünürdü.
   */
  #pinFirst(c: StoredConnector, tools: readonly Tool[]): void {
    if (c.native || c.pins || tools.length === 0) return;
    c.pins = Object.fromEntries(tools.map((t) => [t.name, toolPin(t)]));
    this.#save();
  }

  #client(listChanged?: ListChangedHandlers): Client {
    return new Client(
      { name: "Codezal", version: this.#config.appVersion ?? "0.1.0" },
      { capabilities: {}, ...(listChanged ? { listChanged } : {}) },
    );
  }

  /**
   * Sunucunun bildirdiği yeni araç listesi (list_changed). Bağlantı anındaki listeye göre eklenen
   * ve kaldırılan adlar `toolChange` olarak satırda gösterilir; küme değişimini `#emit` duyurur ve
   * açık oturumlar tazelenir. SDK listeyi kendisi yeniden çeker (`autoRefresh`), burada yalnız uygulanır.
   */
  #applyToolList(c: StoredConnector, rt: Runtime, tools: Tool[]): void {
    this.#pinFirst(c, tools);
    rt.tools = tools;
    const now = new Set(tools.map((t) => t.name));
    const added = [...now].filter((n) => !rt.baseline.has(n));
    const removed = [...rt.baseline].filter((n) => !now.has(n));
    rt.toolChange =
      added.length > 0 || removed.length > 0 ? { at: this.#now(), added, removed } : null;
    this.#emit();
  }

  async #connect(id: string): Promise<void> {
    const c = this.#require(id);
    const rt = this.#rt(id);
    await this.#disconnect(id);
    if (!c.enabled) {
      rt.status = "disconnected";
      rt.error = null;
      this.#emit();
      return;
    }
    // Belirteçsiz OAuth: sunucu tools/list'e açık olsa bile (Google) çağrılar 401 döner; giriş iste.
    if (c.auth.kind === "oauth" && !c.auth.tokens) {
      rt.status = "needs-login";
      rt.error = null;
      this.#emit();
      return;
    }
    rt.status = "connecting";
    rt.error = null;
    this.#emit();
    if (c.native) {
      await this.#connectNative(c, c.native);
      return;
    }
    // list_changed: 2025 bağlantılarında bildirim, 2026 bağlantılarında `subscriptions/listen` akışı
    // gelir; SDK ikisini de `listChanged` seçeneğiyle karşılar (çıplak bildirim işleyicisi yeni
    // protokolde hiç tetiklenmiyordu). Liste SDK'ca yeniden çekilir, debounce varsayılandır.
    const client: Client = this.#client({
      tools: {
        onChanged: (error, tools) => {
          if (error || !tools || rt.client !== client || rt.status !== "connected") return;
          this.#applyToolList(c, rt, tools);
        },
      },
      prompts: {
        onChanged: (error, prompts) => {
          if (error || !prompts || rt.client !== client || rt.status !== "connected") return;
          rt.prompts = prompts;
          this.#emit();
        },
      },
    });
    try {
      await client.connect(c.stdio ? this.#stdioTransport(c.stdio, rt) : this.#transport(c, null));
      const { tools } = await client.listTools();
      const caps = client.getServerCapabilities();
      // İstem listesi alınamazsa bağlantı düşmez: araçlar asıl iştir, istemler yardımcıdır.
      const prompts = caps?.prompts
        ? await client.listPrompts().then(
            (r) => r.prompts,
            () => [],
          )
        : [];
      this.#pinFirst(c, tools);
      rt.client = client;
      rt.resources = caps?.resources !== undefined;
      rt.prompts = prompts;
      rt.tools = tools;
      rt.baseline = new Set(tools.map((t) => t.name));
      rt.toolChange = null;
      rt.status = "connected";
      rt.error = null;
      if (c.auth.kind === "oauth") this.#setAccount(c, accountFromIdToken(c.auth.tokens?.id_token));
      client.onclose = () => {
        if (rt.client !== client) return;
        rt.client = null;
        rt.tools = [];
        // Yerel süreç kendiliğinden kapandıysa bu bir arızadır: satır stderr kuyruğunu gösterir.
        if (c.stdio) {
          rt.status = "error";
          rt.error = this.#d.errors.mcpProcessExited;
        } else rt.status = "disconnected";
        this.#emit();
      };
    } catch (e) {
      await client.close().catch(() => {});
      rt.client = null;
      rt.tools = [];
      if (!c.stdio && isUnauthorized(e) && c.auth.kind !== "bearer") {
        // İlk 401: sunucu OAuth istiyor; kullanıcı "Giriş yap" ile tarayıcıdan bağlanır.
        if (c.auth.kind === "none") {
          c.auth = { kind: "oauth" };
          this.#save();
        }
        rt.status = "needs-login";
        rt.error = null;
      } else {
        rt.status = "error";
        rt.error = this.#connectError(e, c);
      }
    }
    this.#emit();
  }

  /**
   * Yerel komut taşıması. stderr boruya alınır: sunucunun günlüğü main'in konsoluna dökülmez,
   * son satırları hata durumunda Ayarlar'da gösterilir. Çalışma klasörü verilmemişse ev klasörü
   * (Dock'tan açılan Electron'un cwd'si `/` olabilir).
   */
  #stdioTransport(stdio: StoredStdio, rt: Runtime): StdioClientTransport {
    const transport = new StdioClientTransport({
      command: stdio.command,
      args: stdio.args,
      env: stdioEnv(stdio.env, this.#config.stdioPath?.() ?? process.env.PATH),
      cwd: stdio.cwd ?? homedir(),
      stderr: "pipe",
    });
    rt.stderr = "";
    const decoder = new StringDecoder("utf8");
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      rt.stderr = (rt.stderr + text).slice(-STDERR_TAIL_CHARS);
    });
    return transport;
  }

  /**
   * Bağlantı hatası metni. Google gibi sunucular 4xx yanıta bile tam araç listesini gövde olarak
   * koyar; SDK mesajı o gövdeyle başlar ve durum kodunu düşürür. Kod başa alınır, gövde kısaltılır.
   */
  #connectError(e: unknown, c?: StoredConnector): string {
    if (c?.stdio) {
      const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
      if (code === "ENOENT")
        return this.#d.errors.mcpCommandNotFound.replace("{{command}}", c.stdio.command);
      return errorMessage(e);
    }
    if (isUnauthorized(e)) return this.#d.errors.mcpTokenRejected;
    // Sağlayıcı API'si (Drive) kendi açıklamasını verir; 403 burada önizleme değil API kapalı demektir.
    if (e instanceof NativeHttpError) return e.message;
    const status = httpStatus(e);
    if (status === 403) return this.#d.errors.mcpForbidden;
    const message = errorMessage(e);
    if (status === null) return message;
    const body = message.replace(/^Error POSTing to endpoint:\s*/, "").trim();
    const short = body.length > 160 ? `${body.slice(0, 160)}…` : body;
    return `${this.#d.errors.mcpHttpError.replace("{{status}}", String(status))}${short ? ` · ${short}` : ""}`;
  }

  // ---------- uygulama içi servisler ----------

  /** MCP el sıkışması yok: belirteç ve API erişimi `probe` ile doğrulanır, araç listesi yereldir. */
  async #connectNative(c: StoredConnector, native: NativeConnector): Promise<void> {
    const rt = this.#rt(c.id);
    const service = NATIVE_SERVICES[native.service];
    try {
      this.#setAccount(c, await service.probe(this.#nativeContext(c, undefined)));
      rt.tools = service.tools(this.#lang);
      rt.status = "connected";
      rt.error = null;
    } catch (e) {
      rt.tools = [];
      if (isUnauthorized(e)) {
        rt.status = "needs-login";
        rt.error = null;
      } else {
        rt.status = "error";
        rt.error = this.#connectError(e);
      }
    }
    this.#emit();
  }

  /** Hesap değiştiyse kaydeder; bilinmiyorsa (null) eskisi kalır, yalnız çıkış siler. */
  #setAccount(c: StoredConnector, account: string | null): void {
    if (!account || c.account === account) return;
    c.account = account;
    this.#save();
  }

  #nativeContext(c: StoredConnector, signal: AbortSignal | undefined): NativeContext {
    return {
      baseUrl: c.url.replace(/\/+$/, ""),
      driveUrl: c.native?.driveUrl ?? GDRIVE_API_URL,
      request: (url, init) => this.#nativeRequest(c, url, init),
      signal,
      lang: this.#lang,
    };
  }

  /**
   * Bearer başlıklı istek. 401'de SDK `auth()` yenileme belirteciyle tazeler (keşif durumu
   * mağazadan gelir); yenilenemezse etkileşimsiz sağlayıcı yönlendirmede `UnauthorizedError`
   * fırlatır ve bağlayıcı "giriş gerekli"ye düşer.
   */
  async #nativeRequest(c: StoredConnector, url: string, init?: RequestInit): Promise<Response> {
    if (c.auth.kind !== "oauth" || !c.native) throw new UnauthorizedError("login required");
    const auth = c.auth;
    const serverUrl = c.native.authServerUrl;
    const send = () => {
      const token = auth.tokens?.access_token;
      if (!token) throw new UnauthorizedError("login required");
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    };
    const first = await send();
    if (first.status !== 401) return first;
    await first.text().catch(() => {});
    if ((await runOAuth(this.#provider(auth, null), { serverUrl })) !== "AUTHORIZED")
      throw new UnauthorizedError("login required");
    const second = await send();
    if (second.status !== 401) return second;
    await second.text().catch(() => {});
    throw new UnauthorizedError("token rejected");
  }

  /** Uygulama içi servis girişi: yetki sunucusunda keşif, tarayıcı, kod takası; MCP yok. */
  async #nativeLogin(
    native: NativeConnector,
    provider: ConnectorOAuthProvider,
    cb: CallbackServer,
  ): Promise<void> {
    const serverUrl = native.authServerUrl;
    if ((await runOAuth(provider, { serverUrl })) !== "REDIRECT") return;
    const params = await cb.wait(() => provider.expectedState);
    const code = params.get("code");
    if (!code)
      throw new Error(
        params.get("error_description") ?? params.get("error") ?? this.#d.errors.mcpStateMismatch,
      );
    const iss = params.get("iss");
    await runOAuth(provider, { serverUrl, authorizationCode: code, ...(iss ? { iss } : {}) });
  }

  async #callNative(
    c: StoredConnector,
    native: NativeConnector,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> {
    const rt = this.#rt(c.id);
    if (rt.status !== "connected" && c.enabled && rt.status !== "needs-login")
      await this.connect(c.id);
    if (rt.status !== "connected")
      throw new Error(this.#d.errors.mcpNotConnected.replace("{{name}}", c.name));
    try {
      const result = await NATIVE_SERVICES[native.service].call(
        this.#nativeContext(c, signal),
        toolName,
        args,
      );
      return {
        content: this.#untrusted(result.content, `${c.name}/${toolName}`),
        details: { connector: c.name, tool: toolName, structured: result.details ?? null },
      };
    } catch (e) {
      if (!isUnauthorized(e)) throw e;
      await this.#disconnect(c.id);
      rt.status = "needs-login";
      this.#emit();
      throw new Error(this.#d.errors.mcpNotConnected.replace("{{name}}", c.name));
    }
  }

  /**
   * Servis sonucundaki metin blokları güvenilmez veri olarak sarılır (web araçlarıyla aynı zarf).
   * E-posta, belge ya da kayıt içeriğini başkası yazmış olabilir; sistem istemindeki kural tek
   * başına yetmez, sınır içerikte de görünmeli. Görseller olduğu gibi kalır.
   */
  #untrusted<T extends { type: string }>(content: T[], source: string): T[] {
    return content.map((block) =>
      block.type === "text" && "text" in block && typeof block.text === "string"
        ? { ...block, text: wrapUntrusted(source, block.text, this.#lang, "service") }
        : block,
    );
  }

  async #disconnect(id: string): Promise<void> {
    const rt = this.#rt(id);
    const client = rt.client;
    rt.client = null;
    rt.tools = [];
    rt.toolChange = null;
    rt.resources = false;
    rt.prompts = [];
    if (rt.status === "connected" || rt.status === "connecting") rt.status = "disconnected";
    if (client) {
      client.onclose = () => {};
      await client.close().catch(() => {});
    }
    // Durum değişimi duyurulmazsa araç kümesi tazelemesi (onToolsChanged) kaçırılır.
    this.#emit();
  }

  // ---------- OAuth girişi ----------

  /**
   * Tarayıcıda giriş: yerel geri dönüş sunucusu açılır, SDK keşif ve dinamik istemci kaydını
   * yapar, yetki adresi tarayıcıda açılır; kod gelince belirteç alınır ve yeniden bağlanılır.
   */
  async login(id: string): Promise<void> {
    const c = this.#require(id);
    const rt = this.#rt(id);
    await this.#disconnect(id);
    if (c.auth.kind !== "oauth") c.auth = { kind: "oauth" };
    const auth = c.auth;
    // Yönlendirme adresi tek tek kayıtlıysa kapı değişemez; masaüstü istemcisinde serbesttir.
    const cb = await this.#callbackServer(auth.port ?? CALLBACK_PORT, auth.strictPort === true);
    try {
      if (auth.port !== cb.port) {
        // Yönlendirme adresi değişti: eski istemci kaydı bu adresi tanımaz, yeniden kaydolunur.
        delete auth.client;
        auth.port = cb.port;
      }
      delete auth.verifier;
      this.#save();
      const provider = this.#provider(auth, (url) => this.#config.openExternal(url.href), cb.port);
      rt.status = "connecting";
      rt.error = null;
      this.#emit();
      if (c.native) {
        await this.#nativeLogin(c.native, provider, cb);
      } else {
        await this.#mcpLogin(c, provider, cb);
      }
    } catch (e) {
      rt.status = "needs-login";
      // DCR desteklemeyen sunucular (ör. eski Google Docs MCP kaydı) için yönlendirici mesaj;
      // kullanıcı ham SDK metniyle baş başa kalmasın.
      rt.error = isNoDynamicClientRegistration(e)
        ? this.#d.errors.mcpNoDynamicClient.replace("{{name}}", c.name)
        : errorMessage(e);
      this.#emit();
      throw new Error(rt.error, { cause: e });
    } finally {
      cb.close();
    }
    await this.#connect(id);
  }

  /** MCP girişi: el sıkışma 401 dönerse ya da belirteç yoksa yetki akışı başlar. */
  async #mcpLogin(
    c: StoredConnector,
    provider: ConnectorOAuthProvider,
    cb: CallbackServer,
  ): Promise<void> {
    const hadTokens = c.auth.kind === "oauth" && c.auth.tokens !== undefined;
    const transport = this.#transport(c, provider);
    const client = this.#client();
    const finish = async () => {
      const params = await cb.wait(() => provider.expectedState);
      await transport.finishAuth(params);
      await transport.close().catch(() => {});
    };
    try {
      await client.connect(transport);
      await client.close().catch(() => {});
      // Google gibi sunucular belirteçsiz initialize ve tools/list'i kabul edip yalnızca araç
      // çağrısında 401 döner; 401 beklemek tarayıcıyı hiç açmaz. Belirteç yoksa akış burada
      // başlatılır: keşif + (gerekirse) istemci kaydı, sonra yetki adresi tarayıcıda açılır.
      if (!hadTokens && (await runOAuth(provider, { serverUrl: c.url })) === "REDIRECT")
        await finish();
    } catch (e) {
      if (!isUnauthorized(e)) throw e;
      await finish();
    }
  }

  /** 127.0.0.1'de tek kullanımlık geri dönüş sunucusu; tercih edilen kapı doluysa rastgele. */
  async #callbackServer(preferred: number, strict = false): Promise<CallbackServer> {
    const d = this.#d;
    let resolveParams: ((p: URLSearchParams) => void) | null = null;
    let rejectParams: ((e: Error) => void) | null = null;
    let expected: (() => string | null) | null = null;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      const state = params.get("state");
      const ok = expected !== null && state !== null && state === expected();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Codezal</title><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? d.mcp.loginDone : d.mcp.loginFailed}</h2><p>${d.mcp.closeTab}</p></body>`,
      );
      if (!ok) {
        rejectParams?.(new Error(d.errors.mcpStateMismatch));
        return;
      }
      resolveParams?.(params);
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    let port: number;
    try {
      port = await listen(preferred);
    } catch {
      if (strict) throw new Error(d.errors.mcpPortBusy.replace("{{port}}", String(preferred)));
      port = await listen(0);
    }
    return {
      port,
      wait: (expectedState) => {
        expected = expectedState;
        return new Promise<URLSearchParams>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(d.errors.mcpLoginTimeout)),
            LOGIN_TIMEOUT_MS,
          );
          resolveParams = (p) => {
            clearTimeout(timer);
            resolve(p);
          };
          rejectParams = (e) => {
            clearTimeout(timer);
            reject(e);
          };
        });
      },
      close: () => {
        server.close();
        server.closeAllConnections();
      },
    };
  }

  // ---------- araç çağrısı ----------

  async #call(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> {
    const c = this.#require(id);
    if (c.native) return this.#callNative(c, c.native, toolName, args, signal);
    const rt = this.#rt(id);
    if (!rt.client && c.enabled && rt.status !== "needs-login") await this.connect(id);
    const client = rt.client;
    if (!client) throw new Error(this.#d.errors.mcpNotConnected.replace("{{name}}", c.name));
    // Pi'ye kaydedilen araç geri alınamaz: sunucu aracı kaldırdıysa eski tanım hâlâ çağrılabilir.
    // Çağrı sunucuya gitmeden açık hatayla durur.
    const tool = rt.tools.find((t) => t.name === toolName);
    if (!tool)
      throw new Error(
        this.#d.errors.mcpToolRemoved.replace("{{tool}}", toolName).replace("{{name}}", c.name),
      );
    // Tanımı onaydan sonra değişen araç: oturumda eski tanımla kayıtlı kalmış olabilir.
    if (reviewOf(c, tool) !== null)
      throw new Error(
        this.#d.errors.mcpToolNeedsApproval
          .replace("{{tool}}", toolName)
          .replace("{{name}}", c.name),
      );
    let result: CallToolResult;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args },
        { ...(signal ? { signal } : {}), timeout: CALL_TIMEOUT_MS },
      );
    } catch (e) {
      if (isUnauthorized(e) && c.auth.kind === "oauth") {
        // Belirteç süresi doldu ve yenilenemedi: kullanıcı Ayarlar'dan yeniden giriş yapar.
        await this.#disconnect(id);
        rt.status = "needs-login";
        this.#emit();
        throw new Error(this.#d.errors.mcpNotConnected.replace("{{name}}", c.name));
      }
      throw e;
    }
    const content = toAgentContent(result.content);
    if (result.isError) {
      const text = content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      // Hata metni de sunucudan gelir: modele aynı korumayla gider.
      throw new Error(
        text
          ? wrapUntrusted(`${c.name}/${toolName}`, text, this.#lang, "service")
          : this.#d.errors.mcpToolError,
      );
    }
    return {
      content: this.#untrusted(content, `${c.name}/${toolName}`),
      details: {
        connector: c.name,
        tool: toolName,
        structured: result.structuredContent ?? null,
      },
    };
  }
}
