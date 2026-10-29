import { z } from "zod";

/** Uygulama modları (tasarımdaki üst sekmeler). */
export const AppMode = z.enum(["kodlama", "asistan"]);
export type AppMode = z.infer<typeof AppMode>;

/** İzin modları (PRD §6). Etiketler i18n'de (`permissionMode.*`): sözleşmede kullanıcı metni tutulmaz. */
export const PermissionMode = z.enum(["ask", "auto-edit", "plan", "full"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Düşünme seviyeleri. Arayüzde üç seçenek; Pi'ye low/high/max olarak gider. */
export const ThinkingLevel = z.enum(["low", "high", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** Çalışma yeri. v1'de yalnızca "local" etkin. */
export const WorkLocation = z.enum(["local", "cloud", "remote", "worktree"]);
export type WorkLocation = z.infer<typeof WorkLocation>;

/** Sağlayıcı + model kimliği; `ModelRef` her yerde bu ikiliyle taşınır. */
export const ModelRef = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** Kullanıcı mesajına eklenen görsel; base64 veri, Pi'nin ImageContent'iyle bire bir. */
export const ImageAttachment = z.object({
  mimeType: z.string(),
  /** base64 (data: öneki olmadan) */
  data: z.string(),
  name: z.string().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const CatalogModel = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  /** Görsel girdisi kabul ediyor mu (Pi: `model.input` içinde "image"). */
  vision: z.boolean().default(false),
  contextWindow: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  /** Milyon token başına USD (girdi/çıktı); yerel modellerde 0. */
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).default({
    input: 0,
    output: 0,
  }),
  available: z.boolean(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/** Kimlik havuzundaki bir yuva; gizli değer taşımaz, `hint` anahtarın son 4 hanesidir. */
export const ApiKeySlot = z.object({
  id: z.string(),
  label: z.string().optional(),
  hint: z.string(),
  /** Değer düz anahtar mı, `$VAR` ortam referansı mı, `!komut` referansı mı. */
  kind: z.enum(["key", "env", "command"]).default("key"),
  /** Referanslı yuvada ham referans metni (`!komut` ya da `$VAR` şablonu); düz anahtarda yok. */
  reference: z.string().optional(),
  /** env referansındaki değişken şu an tanımlı değilse true; yalnız görünürlük amaçlıdır. */
  envMissing: z.boolean().optional(),
  type: z.enum(["api_key", "oauth"]),
  /** `read()`'in şu an döndüreceği yuva. */
  active: z.boolean(),
  /** Limit dolduysa yeniden denenecek zaman (epoch ms); yoksa null. */
  cooldownUntil: z.number().nullable(),
  addedAt: z.number(),
});
export type ApiKeySlot = z.infer<typeof ApiKeySlot>;

export const ProviderInfo = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  authKinds: z.array(z.enum(["api_key", "oauth"])),
  modelCount: z.number().int().nonnegative(),
  /** Sağlayıcının kayıtlı anahtarları, öncelik sırasıyla. */
  keys: z.array(ApiKeySlot).default([]),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

/** Kota penceresi: 5 saat, hafta, ay ya da sağlayıcının kendi kayan penceresi. */
export const QuotaWindow = z.object({
  id: z.enum(["rolling", "fiveHour", "weekly", "monthly"]),
  /** Sağlayıcının kendi adı (ör. "Rolling"); yoksa arayüz id'ye göre etiketler. */
  label: z.string().optional(),
  /** Pencerenin kapasiteye göre doluluk yüzdesi. */
  percent: z.number().min(0).max(100),
  used: z.number().optional(),
  cap: z.number().optional(),
  /** Pencerenin sıfırlanma anı (epoch ms); sağlayıcı vermiyorsa null. */
  resetsAt: z.number().nullable().default(null),
  exceeded: z.boolean().default(false),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

/**
 * Sağlayıcının anlık kota durumu. Anahtar ya da gizli değer taşımaz; eksik alan "bilinmiyor"dur
 * (0 değil), bu yüzden tüm veri alanları isteğe bağlıdır.
 */
export const ProviderQuota = z.object({
  provider: z.string(),
  /**
   * ok: canlı veri geldi · unsupported: sağlayıcının bilinen kota ucu yok ·
   * unauthenticated: anahtar yok ya da geçersiz · error: uç çağrıldı ama yanıt bozuk/ağ hatası.
   */
  state: z.enum(["ok", "unsupported", "unauthenticated", "error"]),
  /** Sağlayıcının plan kimliği (ör. "individual-goat"). */
  plan: z.string().optional(),
  windows: z.array(QuotaWindow).default([]),
  /** Dönem kredisi: kalan ve varsa kapasite (tahmini olabilir). */
  credit: z
    .object({
      remaining: z.number(),
      cap: z.number().optional(),
      /** Kapasite sağlayıcıdan gelmiyorsa (plan tablosundan türetildiyse) true. */
      capEstimated: z.boolean().default(false),
      purchased: z.number().optional(),
      free: z.number().optional(),
    })
    .optional(),
  /** Ön ödemeli bakiye (DeepSeek, OpenRouter gibi). */
  balance: z
    .object({ amount: z.number(), currency: z.string(), usable: z.boolean().default(true) })
    .optional(),
  /** Abonelik döneminin bitişi (epoch ms). */
  periodEnd: z.number().optional(),
  usage: z.object({ requests: z.number().optional(), tokens: z.number().optional() }).optional(),
  /** Kısa durum notu: "kota ucu yok", "anahtar devre dışı", hata özeti. */
  message: z.string().optional(),
  /** Verinin çekildiği an (epoch ms). */
  fetchedAt: z.number(),
});
export type ProviderQuota = z.infer<typeof ProviderQuota>;

const SlotRef = z.object({ id: z.string(), label: z.string().optional(), hint: z.string() });

/** Limit dolunca anahtar değişti; `to` null ise tüm anahtarlar soğumada. */
export const CredentialRotation = z.object({
  sessionId: z.string(),
  provider: z.string(),
  from: SlotRef,
  to: SlotRef.nullable(),
  cooldownUntil: z.number(),
});
export type CredentialRotation = z.infer<typeof CredentialRotation>;

export const ProjectRef = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  isGit: z.boolean(),
  branch: z.string().optional(),
  lastOpenedAt: z.number().optional(),
  /** Proje-yerel yapılandırma (.codezal, .pi) yüklensin mi; hiç sorulmadıysa yok. */
  trusted: z.boolean().optional(),
  /** Git kök commit'i: klasör taşınsa da değişmez, oturum ve belleği yeni yola bağlamak için. */
  fingerprint: z.string().optional(),
});
export type ProjectRef = z.infer<typeof ProjectRef>;

/** "Şurada aç" menüsündeki harici uygulama; komut ve yolları main'de kalır, renderer yalnız ad/simge görür. */
export const OpenWithApp = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["finder", "editor", "terminal"]),
  /** Uygulama simgesi data URL; alınamadıysa null ve arayüz glif çizer. */
  iconDataUrl: z.string().nullable(),
});
export type OpenWithApp = z.infer<typeof OpenWithApp>;

export const SessionSummary = z.object({
  id: z.string(),
  path: z.string(),
  cwd: z.string(),
  name: z.string(),
  mode: AppMode,
  createdAt: z.number(),
  modifiedAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  live: z.boolean().default(false),
  /** Asistan projesi gibi ek gruplama. */
  projectId: z.string().nullable().default(null),
  /** Oturum bir güvenlik denetimi run'ına bağlıysa run kimliği; kenar çubuğu çipi bunu gösterir. */
  auditRunId: z.string().nullable().default(null),
  /**
   * Ayrık ajan koşusunun oturumuysa onu başlatan oturum. Kenar çubuğu bu oturumları listelemez;
   * transkript ana oturumun Ajanlar panelinden açılır.
   */
  parentSessionId: z.string().nullable().default(null),
  /**
   * Yan sohbetse açıldığı ana oturum. Ana oturumun bağlamını taşıyan salt okunur daldır; kenar
   * çubuğunda görünmez, ana oturumun yüzen panelinde açılır.
   */
  sideOf: z.string().nullable().default(null),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Oturum içeriği aramasında sorgunun en kısa ve en uzun hâli. */
export const SESSION_SEARCH_MIN = 2;
export const SESSION_SEARCH_MAX = 200;

/**
 * Oturum içeriği aramasında oturum başına tek isabet: sorgunun ilk geçtiği mesaj ve özet parçası.
 * Mesaj, transkriptte `role` + `at` (mesaj zaman damgası) ile bulunur; sıkıştırılmış ya da
 * işaretli transkriptte sıra kayabileceği için `ordinal` yalnız yedektir.
 */
export const SessionSearchHit = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  /** Mesajın zaman damgası (transkript öğesinin `at` alanı). */
  at: z.number(),
  /** Etkin daldaki kullanıcı + asistan mesajları arasındaki sıra (1'den). */
  ordinal: z.number().int().positive(),
  snippet: z.string(),
  /** Özet içinde eşleşen aralık `[matchStart, matchEnd)`. */
  matchStart: z.number().int().nonnegative(),
  matchEnd: z.number().int().nonnegative(),
  /** Oturumda sorguyu içeren mesaj sayısı. */
  count: z.number().int().positive(),
});
export type SessionSearchHit = z.infer<typeof SessionSearchHit>;

/** `/goal` ile tanımlanan kalıcı hedef; motor hedef bitene dek turları otomatik sürer. */
export const GoalState = z.object({
  text: z.string().min(1),
  /** Otomatik "Continue." sayısı; ilk turdan sonra 1 olur. */
  iter: z.number().int().nonnegative(),
  /** Güvenlik sınırı: iterasyon bu sayıya ulaşınca döngü durur (varsayılan 30). */
  maxIter: z.number().int().positive(),
  paused: z.boolean().default(false),
});
export type GoalState = z.infer<typeof GoalState>;

export const SessionOptions = z.object({
  cwd: z.string().min(1),
  mode: AppMode.default("kodlama"),
  model: ModelRef.optional(),
  thinking: ThinkingLevel.default("low"),
  permission: PermissionMode.default("ask"),
  location: WorkLocation.default("local"),
  name: z.string().optional(),
  projectId: z.string().nullable().default(null),
  /** Sistem istemine eklenecek ek bağlam (asistan talimatları, bellek, seçili öğe). */
  extraSystem: z.string().optional(),
  /** Asistan çıktı klasörü; verilirse `write` bu klasör dışına ilk denemede yönlendirilir. */
  outputsDir: z.string().optional(),
});
export type SessionOptions = z.infer<typeof SessionOptions>;
