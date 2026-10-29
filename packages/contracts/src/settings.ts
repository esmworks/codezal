import { z } from "zod";
import { ModelRef, PermissionMode, ThinkingLevel } from "./domain.js";
import { HooksConfig } from "./hooks.js";

/**
 * `web_search` sağlayıcısı. `auto`: modelin yerleşik araması, olmazsa DuckDuckGo (eski davranış).
 * Diğerleri yerleşik aramayı atlar; SearXNG/Brave başarısız olursa DuckDuckGo'ya düşülür.
 */
export const WebSearchProvider = z.enum(["auto", "duckduckgo", "searxng", "brave"]);
export type WebSearchProvider = z.infer<typeof WebSearchProvider>;

/** Kalıcı uygulama ayarları (settings.json). Renderer ve main aynı şemayı kullanır. */
export const AppSettings = z.object({
  theme: z.enum(["koyu", "açık", "sistem"]).default("koyu"),
  language: z.enum(["tr", "en"]).default("tr"),
  menubar: z.boolean().default(false),
  startup: z.boolean().default(false),
  notifications: z.boolean().default(true),
  /** Bildirimler açıkken sesi ayrı susturulabilir. */
  notificationSound: z.boolean().default(true),
  /** Ajan turu sürerken sistemin boşta uyumasını engelle (ekran yine kapanabilir). */
  keepAwake: z.boolean().default(false),
  /** Gömülü terminalin yazı tipi; boşsa uygulamanın varsayılanı. */
  terminalFont: z.string().default(""),
  /** Sohbetteki bağlantılar nerede açılsın: gömülü tarayıcı ya da sistem tarayıcısı. */
  linkTarget: z.enum(["app", "system"]).default("system"),
  /** localhost ve yerel IP adresleri için ayrı hedef; geliştirme sunucusu genelde uygulama içinde. */
  localLinkTarget: z.enum(["app", "system"]).default("app"),
  /**
   * Yeni oturuma model çağrısıyla kısa başlık üretilsin mi. Kapalıyken çağrı yapılmaz, ilk
   * mesajdan türetilen başlık kalır; pahalı modelde her yeni oturum bir çağrı daha demektir.
   */
  autoTitle: z.boolean().default(true),
  greet: z.boolean().default(true),
  cards: z.boolean().default(true),
  summary: z.boolean().default(false),
  globalInstructions: z.string().default(""),
  /** Kullanıcı tanımlı kısayollar: komut → Electron hızlandırıcısı ("CmdOrCtrl+Shift+M"). */
  keybindings: z.record(z.string(), z.string()).default({}),
  monthlyBudget: z.enum(["10M", "30M", "60M", "unlimited"]).default("30M"),
  /**
   * Aylık para bütçesi (USD, tahmini liste fiyatıyla); 0 kapalı. Token bütçesi gibi turu
   * durdurmaz: %80 ve %100'de ayda bir kez uyarı gösterilir.
   */
  monthlyBudgetUsd: z.number().min(0).default(0),
  proxy: z.boolean().default(false),
  proxyUrl: z.string().default(""),
  /** Vekile uğramadan doğrudan bağlanılacak adresler (virgülle ayrılır). */
  noProxy: z.string().default(""),
  /** PEM kök sertifika yolu; kurumsal araya giren vekiller için (yeniden başlatma gerekir). */
  caCertPath: z.string().default(""),
  timeoutSec: z.enum(["30", "60", "120", "300"]).default("120"),
  webSearchProvider: WebSearchProvider.default("auto"),
  /** SearXNG örneğinin kök adresi (ör. `https://searx.example.org`); JSON biçimi açık olmalı. */
  searxngUrl: z.string().default(""),
  /** Sunucu süre bildirmezse limiti dolan anahtarın kaç saat "dolu" sayılacağı. */
  keyCooldownHours: z.enum(["1", "3", "5", "24"]).default("5"),
  review: z.boolean().default(false),
  lintCmd: z.string().default(""),
  lintOn: z.boolean().default(false),
  testCmd: z.string().default(""),
  testOn: z.boolean().default(false),
  buildCmd: z.string().default(""),
  buildOn: z.boolean().default(false),
  /** Ajan dosya değiştirdiği her turun sonunda açık kontrol komutlarını çalıştır; hata modele döner. */
  turnChecks: z.boolean().default(false),
  /**
   * Kod incelemesi (deneysel): tur altındaki "İncele" düğmesiyle isteğe bağlı denetim başlatılır.
   * Otomatik çalışmaz; bulgular gölge modda yalnızca raporlanır, modele geri gönderilmez.
   */
  reviewerOn: z.boolean().default(false),
  /**
   * Aynı anda çalışan alt ajan sınırı (bekletilen ve ayrık koşular ayrı ayrı sayılır); fazlası
   * kuyrukta bekler. Sağlayıcı hız sınırına takılmamak için varsayılan 3.
   */
  agentConcurrency: z.number().int().min(1).max(8).default(3),
  /**
   * Worktree ajanlarının izin modu. Değişiklik ayrı klasörde kalır ve ana dala yalnız kullanıcı
   * uygularsa geçer; bu yüzden varsayılan sormadan düzenlemektir (tehlikeli komut yine sorulur).
   */
  agentWorktreePermission: z.enum(["ask", "auto-edit", "full"]).default("auto-edit"),
  commitFormat: z.enum(["conventional", "free", "short"]).default("conventional"),
  worktreeRoot: z.string().default(""),
  worktreePerTask: z.boolean().default(false),
  worktreeClean: z.boolean().default(true),
  /** Güncellemeler bulunur bulunmaz indirilsin mi; kurulum yine çıkışta olur. */
  autoUpdate: z.boolean().default(true),
  /** Ayrıntılı günlük: debug satırları ana günlüğü şişirmemesi için ayrı dosyaya yazılır. */
  verboseLog: z.boolean().default(false),
  /** Ajan olayları oturum başına NDJSON dosyasına yazılsın (tanılama; satırlar maskelenir). */
  agentTraceLog: z.boolean().default(true),
  /** Eskiyen oturumları kendiliğinden arşivle (sabitlenmiş ve çalışan oturumlara dokunmaz). */
  autoArchive: z.boolean().default(false),
  /** Bir oturum son değişiklikten kaç gün sonra arşive uygun sayılır. */
  archiveDays: z.enum(["3", "7", "14", "30"]).default("7"),
  /** "Şurada aç" menüsünde son seçilen uygulamanın kimliği; menü bunu varsayılan yapar. */
  openWithApp: z.string().default(""),
  profileName: z.string().default(""),
  defaultModel: ModelRef.nullable().default(null),
  /**
   * Zamanlanmış görevde web sayfası ve arama sonuçlarını özetleyen model; boşsa görevin modeli.
   * Özet her okumada ayrı bir çağrıdır, ucuz bir model maliyeti düşürür.
   */
  webSummaryModel: ModelRef.nullable().default(null),
  /**
   * Danışman (advisor) modeli; boşsa danışman kapalıdır ve araç oturuma kaydedilmez. Ajan
   * konuşmanın tamamını bu modele gönderip tavsiye alır; görevin modeline düşülmez.
   */
  advisorModel: ModelRef.nullable().default(null),
  /**
   * Zamanlanmış (gözetimsiz) görev koşusunda danışman açık mı. Kapalıyken araç koşu boyunca modelden
   * gizlenir: her danışma konuşmanın tamamını güçlü modele gönderir ve kimse izlemeden birikir.
   */
  advisorScheduled: z.boolean().default(false),
  /**
   * Bash korumalı alanı (yalnız macOS, Seatbelt): ajan komutları çalışma klasörü, geçici klasörler
   * ve paket önbellekleri dışına yazamaz; Codezal veri klasörüne erişemez. Ağ açık kalır.
   */
  bashSandbox: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettings>;

/**
 * Ayar yaması. `AppSettings.partial()` kullanılamaz: Zod 4'te optional alan varsayılanını
 * korur, yamada bulunmayan her alan varsayılanıyla dolar ve dokunulmayan ayarlar sıfırlanır.
 * Bu yüzden varsayılanları söküp alanları optional yapıyoruz.
 */
export const AppSettingsPatch = z.object(
  Object.fromEntries(
    Object.entries(AppSettings.shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
    ]),
  ),
) as unknown as z.ZodType<Partial<AppSettings>, Partial<AppSettings>>;

/**
 * Proje kökündeki `.codezal/ayarlar.json` (ekiple paylaşılır) + `ayarlar.local.json` (kişisel,
 * gitignore): proje seçilince yeni oturumların varsayılanları. Yalnızca güvenilen projede okunur.
 */
export const ProjectConfig = z.object({
  permission: PermissionMode.optional(),
  model: ModelRef.optional(),
  thinking: ThinkingLevel.optional(),
  /**
   * Proje hook'ları; iki dosyadakiler birleştirilir (main `hooks.ts`). Bozuk hook alanı yok
   * sayılır: hatalı bir kural dosyadaki izin/model varsayılanlarını da düşürmesin.
   */
  hooks: HooksConfig.optional().catch(undefined),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Sağlayıcı ve ay bazında token/istek sayacı (usage.json). */
export const UsageEntry = z.object({
  provider: z.string(),
  model: z.string(),
  month: z.string(),
  /** Yerel gün (YYYY-AA-GG); günlük grafikler için. Eski kayıtlarda yok, yalnızca ay toplamı. */
  day: z.string().optional(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  /** Toplam maliyet (USD). */
  cost: z.number().nonnegative().default(0),
});
export type UsageEntry = z.infer<typeof UsageEntry>;

/** Asistan: zamanlanmış görev. */
export const ScheduledTask = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  projectId: z.string().nullable().default(null),
  schedule: z.object({
    // "manual": zamanlayıcı dokunmaz; yalnız "Şimdi çalıştır" ya da asistan aracı koşturur.
    kind: z.enum(["daily", "weekdays", "weekly", "monthly", "interval", "manual"]),
    time: z.string().default("09:00"),
    weekday: z.number().int().min(0).max(6).optional(),
    monthDay: z.number().int().min(1).max(28).optional(),
    intervalMin: z.number().int().positive().optional(),
  }),
  paused: z.boolean().default(false),
  /** Görev başına model; boşsa Ayarlar > Kullanım'daki varsayılan. */
  model: ModelRef.nullable().default(null),
  /** Görev başına izin modu; gözetimsiz koşarken onay gereken adımlar reddedilir. */
  permission: PermissionMode.default("full"),
  /**
   * Sor/Plan modunda web araması ve sayfa okuma sorulmadan geçer. İzin görev kaydedilirken
   * kullanıcı başındayken verilir; gözetimsiz koşuda sorulacak kimse yoktur.
   */
  allowWeb: z.boolean().default(false),
  lastRunAt: z.number().nullable().default(null),
  lastResult: z.string().nullable().default(null),
  /** Son çalışmanın oturumu; sonuç kartından açılır. */
  lastSessionId: z.string().nullable().default(null),
  nextRunAt: z.number().nullable().default(null),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

/** Proje klasörüne alınmış bağlam kopyası; `null` ise bağlam kaynak yoldan okunur. */
export const AssistantContextCopy = z.object({
  /** Kopyanın proje klasöründeki tam yolu (`<proje>/Bağlam/...`). */
  path: z.string(),
  copiedAt: z.number(),
});
export type AssistantContextCopy = z.infer<typeof AssistantContextCopy>;

/** Asistan: proje (görev grubu). */
export const AssistantContext = z.object({
  kind: z.enum(["folder", "file", "link"]),
  value: z.string(),
  label: z.string(),
  /** Alan yoksa eski kayıt: bağlam yalnız kaynaktan okunur (geriye uyum). */
  copy: AssistantContextCopy.nullable().default(null),
});
export type AssistantContext = z.infer<typeof AssistantContext>;

export const AssistantProject = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  instructions: z.string().default(""),
  memory: z.array(z.string()).default([]),
  context: z.array(AssistantContext).default([]),
  createdAt: z.number(),
});
export type AssistantProject = z.infer<typeof AssistantProject>;

/**
 * Bellek: harness tarzı dosya tabanlı hafıza. Her kayıt tek gerçek tutan bir markdown dosyası,
 * `MEMORY.md` ise her oturumda sistem istemine giren tek satırlık dizin.
 */
export const MemoryScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("genel") }),
  z.object({ kind: z.literal("proje"), cwd: z.string().min(1) }),
  z.object({ kind: z.literal("asistan"), projectId: z.string().min(1) }),
]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryType = z.enum(["kullanici", "geribildirim", "proje", "kaynak"]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemoryEntry = z.object({
  /** Dosya adı gövdesi (kebab-case), aynı zamanda [[bağlantı]] adı. */
  name: z.string(),
  description: z.string(),
  type: MemoryType,
  body: z.string(),
  file: z.string(),
  updatedAt: z.number(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryDraft = z.object({
  name: z.string().optional(),
  description: z.string().min(1),
  type: MemoryType.default("kullanici"),
  body: z.string().default(""),
});
export type MemoryDraft = z.infer<typeof MemoryDraft>;
