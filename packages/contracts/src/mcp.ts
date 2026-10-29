import { z } from "zod";

/**
 * Bağlayıcılar: uzak MCP sunucuları (Streamable HTTP). Renderer yalnızca bu özeti görür;
 * erişim belirteçleri, OAuth istemci kaydı ve yenileme belirteçleri main tarafında kalır.
 */
export const McpAuthKind = z.enum(["none", "bearer", "oauth"]);
export type McpAuthKind = z.infer<typeof McpAuthKind>;

export const McpStatus = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "needs-login",
  "error",
]);
export type McpStatus = z.infer<typeof McpStatus>;

/**
 * Bağlantı türü: `http` uzak sunucu (Streamable HTTP), `stdio` kullanıcının eklediği yerel komut.
 * Yerel komutun ortam değerleri renderer'a gitmez; yalnız adları (`envKeys`) gösterilir.
 */
export const McpTransportKind = z.enum(["http", "stdio"]);
export type McpTransportKind = z.infer<typeof McpTransportKind>;

/** MCP sunucusu olmayan, Codezal'ın kendi çağırdığı servisler. */
export const McpNativeService = z.enum([
  "gdrive",
  "gmail",
  "gcalendar",
  "gdocs",
  "gsheets",
  "gslides",
]);
export type McpNativeService = z.infer<typeof McpNativeService>;

/**
 * Araç başına izin: `auto` sormadan çalışır, `ask` oturumun izin moduna uyar (Sor modunda onay
 * ister, Tam erişimde sormaz), `off` ajana hiç verilmez. Plan modu yan etkiyi yasakladığından
 * `auto` araç da orada engelli kalır.
 */
export const McpToolPolicy = z.enum(["auto", "ask", "off"]);
export type McpToolPolicy = z.infer<typeof McpToolPolicy>;

export const McpToolInfo = z.object({
  /** Sunucudaki araç adı. */
  name: z.string(),
  /** Ajanın gördüğü ad (`mcp_<bağlayıcı>_<araç>`). */
  agentName: z.string(),
  description: z.string(),
  /** Sunucu aracı salt okunur işaretledi (`readOnlyHint`); yalnız ipucu, izin kararı değil. */
  readOnly: z.boolean(),
  policy: McpToolPolicy,
  /**
   * Araç tanımı sabitlemesi (tool poisoning savunması): ilk bağlantıda her aracın ad, açıklama ve
   * girdi şeması özeti saklanır. Sonradan eklenen (`new`) ya da tanımı değişen (`changed`) araç
   * kullanıcı onaylayana kadar ajana verilmez; onaylıysa null.
   */
  review: z.enum(["new", "changed"]).nullable(),
  /** `changed` araçta onaylanmış önceki açıklama (karşılaştırma için); aksi hâlde null. */
  previousDescription: z.string().nullable(),
  /** `changed` araçta girdi şeması da değişti mi. */
  schemaChanged: z.boolean(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/** Sunucunun sunduğu istem şablonu (`prompts/list`); `/` paletinde `/<servis>:<istem>` olur. */
export const McpPromptInfo = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  arguments: z.array(
    z.object({ name: z.string(), description: z.string(), required: z.boolean() }),
  ),
});
export type McpPromptInfo = z.infer<typeof McpPromptInfo>;

export const McpConnector = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  auth: McpAuthKind,
  /** OAuth kimlikleri kullanıcı girdi (DCR yok); istemci kimliği/gizli anahtarı renderer'a gitmez. */
  ownClient: z.boolean(),
  /** Aynı OAuth istemcisini paylaşan aile (ör. "google"); yeni eklerken kopyalanabilir. */
  clientGroup: z.string().nullable(),
  /** Uygulama içi servis: MCP yerine sağlayıcı API'si (Drive) doğrudan çağrılır. */
  native: McpNativeService.nullable(),
  enabled: z.boolean(),
  status: McpStatus,
  /**
   * Girişin bağlı olduğu hesap (e-posta ya da ad): uygulama içi servislerde sağlayıcı API'sinden,
   * MCP'de OIDC `id_token`'dan okunur. Belirteç değil, yalnız gösterim için; bilinmiyorsa null.
   */
  account: z.string().nullable(),
  tools: z.array(McpToolInfo),
  /** Son hata metni (status=error ya da needs-login için açıklama). */
  error: z.string().nullable(),
  transport: McpTransportKind,
  /** Yerel komut: komut ve argümanlar tek satırda (gösterim için); uzak sunucuda null. */
  command: z.string().nullable(),
  /** Yerel komutun çalışma klasörü; verilmediyse null (ev klasörü kullanılır). */
  cwd: z.string().nullable(),
  /** Yerel komuta verilen ortam değişkenlerinin adları; değerler main'de kalır. */
  envKeys: z.array(z.string()),
  /**
   * Yerel komut hata verdiyse stderr'in son satırları (ortam değerleri maskelenir); aksi hâlde
   * null. Sunucunun kendi çıktısıdır, kullanıcı neden düştüğünü görsün diye gösterilir.
   */
  stderr: z.string().nullable(),
  /**
   * Bağlandıktan sonra sunucu araç listesini değiştirdiyse (`tools/list_changed`) eklenen ve
   * kaldırılan araç adları; bağlantı anındaki listeyle aynıysa null. Yeniden bağlanınca sıfırlanır.
   */
  toolChange: z
    .object({ at: z.number(), added: z.array(z.string()), removed: z.array(z.string()) })
    .nullable(),
  /** Sunucu kaynak sunuyor mu (`resources`); ajan `mcp_resources` aracıyla listeler ve okur. */
  resources: z.boolean(),
  /** Sunucunun istem şablonları; bağlı değilse boş. */
  prompts: z.array(McpPromptInfo),
});
export type McpConnector = z.infer<typeof McpConnector>;
