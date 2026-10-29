import { z } from "zod";
import { ImageAttachment } from "./domain.js";
import { ScheduledTask } from "./settings.js";

/** Araç kartı türleri (tasarım: Okundu, Arandı, Oluşturuldu, Düzenlendi, Silindi, Çalıştırıldı). */
export const ToolKind = z.enum([
  "read",
  "search",
  "create",
  "edit",
  "delete",
  "terminal",
  "audit",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ToolStatus = z.enum(["running", "done", "error", "denied", "blocked", "stopped"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/**
 * Web aramasının hangi yolla yapıldığı: sağlayıcının yerleşik araması ya da DuckDuckGo'nun
 * `html.`/`lite.` uç noktası (`web_search` aracının `details.endpoint` alanı). Kartta etiket
 * olarak görünür: yerleşik arama desteklemeyen modelde sessizce DuckDuckGo'ya düşülüyordu ve
 * iki yolun çıktısı ekranda aynı görünüyordu. `searxng`/`brave` kullanıcının Ayarlar'da seçtiği
 * açık sağlayıcıdır.
 */
export const SearchBackend = z.enum(["native", "html", "lite", "searxng", "brave"]);
export type SearchBackend = z.infer<typeof SearchBackend>;

/**
 * `schedule_task` sonucunun sohbetteki kartı için görevin anlık görüntüsü (`details.task`).
 * Talimat metni taşınmaz: uzun olabilir ve kart göstermez. Kart güncel hâli depodan okur; görev
 * silinmişse bu görüntüyle çizilir.
 */
export const ScheduleToolTask = ScheduledTask.pick({
  id: true,
  title: true,
  projectId: true,
  schedule: true,
  paused: true,
  permission: true,
  allowWeb: true,
});
export type ScheduleToolTask = z.infer<typeof ScheduleToolTask>;

/** `schedule_task` çağrısının eylemi ve dokunduğu görevler (listelemede tümü). */
export const ScheduleToolResult = z.object({
  action: z.enum(["create", "update", "delete", "list"]),
  tasks: z.array(ScheduleToolTask),
});
export type ScheduleToolResult = z.infer<typeof ScheduleToolResult>;

/** Gizli tur dürtmelerinin türleri: dürtme tesliminde transcript'e sınır öğesi düşer. */
export const NudgeKind = z.enum(["empty-response", "unrun-script", "checks", "background", "goal"]);
export type NudgeKind = z.infer<typeof NudgeKind>;

/**
 * Aracın dolaylı değiştirdiği dosya: terminal komutunun (`bash`) ya da alt ajanın dokunduğu
 * dosyalar komut öncesi/sonrası farkından çıkarılır ve tur dosya listesinde görünür.
 */
export const ChangedFile = z.object({
  path: z.string(),
  kind: z.enum(["create", "edit", "delete"]),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const DiffLine = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  text: z.string(),
  oldNo: z.number().int().optional(),
  newNo: z.number().int().optional(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const ToolCallItem = z.object({
  type: z.literal("tool"),
  id: z.string(),
  toolName: z.string(),
  kind: ToolKind,
  status: ToolStatus,
  title: z.string(),
  target: z.string().optional(),
  command: z.string().optional(),
  output: z.string().optional(),
  diff: z.array(DiffLine).optional(),
  /**
   * Canlı satır değişimi: yazma/düzenleme sürerken karttaki `+N −N` sayacı buradan okunur (araç
   * çıktısı/diff'i ancak çağrı bitince gelir). Çağrı bitince sayaç yine diff'ten hesaplanır.
   */
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  /** Satır yalnız akıştan doğdu: çağrı henüz başlamadı, engellenirse/kesilirse düşer. */
  preview: z.boolean().optional(),
  /** `web_search` çağrısında aramanın hangi yolla yapıldığı; eski kayıtlarda ve diğer araçlarda yok. */
  searchBackend: SearchBackend.optional(),
  /** `schedule_task` sonucu: tur sonundaki görev kartı bunu çizer; hatalı çağrıda yok. */
  schedule: ScheduleToolResult.optional(),
  /** `bash` çağrısı korumalı alanda koştu (Ayarlar'daki Bash korumalı alanı). */
  sandboxed: z.boolean().optional(),
  /** `bash`/`agent` çağrısının değiştirdiği dosyalar (mutlak yol); tur dosya listesine girer. */
  changedFiles: z.array(ChangedFile).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});
export type ToolCallItem = z.infer<typeof ToolCallItem>;

export const UserItem = z.object({
  type: z.literal("user"),
  id: z.string(),
  text: z.string(),
  images: z.array(ImageAttachment).optional(),
  at: z.number(),
});

export const AssistantItem = z.object({
  type: z.literal("assistant"),
  id: z.string(),
  text: z.string(),
  /** Düşünme metni; sağlayıcı düşünme parçaları yolladıkça birikir. */
  thinking: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  /** Turun bitiş nedeni (Pi `stopReason`): hata/kesme ile biten turlar katlanmaz. */
  stopReason: z.string().optional(),
  durationMs: z.number().optional(),
  streaming: z.boolean().default(false),
  at: z.number(),
});

/**
 * Gizli dürtme sınırı. Çizilmez; tur içinde yeni bir kapanış bölgesi açar: dürtme yanıtı bir araç
 * çağırınca önceki asıl rapor katlanmış çalışma dizisine gömülmesin. Turu bitirmez: dürtmeden
 * sonra iş aynı turda sürdüğü için katlanma kararı turun son kapanışına göre verilir.
 */
export const BoundaryItem = z.object({
  type: z.literal("boundary"),
  id: z.string(),
  kind: NudgeKind,
  at: z.number(),
});
export type BoundaryItem = z.infer<typeof BoundaryItem>;

/**
 * Komut sonucu işaretinin türü. İşaret satırı, tur üretmeyen yerel komutların (`/model`, `/mod`,
 * `/düşünme`, `/compact`) sonucudur: ZCode da bunları sohbetin ortasında tek satırlık ayraç
 * olarak çizer. Tür satırın ikonunu ve metnini belirler; çevrilmiş metin kayda gömülmez, arayüz
 * dili sonradan değişse eski kayıtlar da yeni dilde okunur. `unsent` komut değil, motor kaydıdır:
 * gönderilen mesaj önceki koşu oturmayı beklerken Durdur'a basıldığı için modele gitmedi.
 */
export const MarkerKind = z.enum(["model", "permission", "thinking", "compact", "unsent"]);
export type MarkerKind = z.infer<typeof MarkerKind>;

/**
 * Komut sonucu işareti (ZCode'un timelineMarker satırı). `from`/`to` geçiş işaretlerinde önceki ve
 * yeni değeri taşır ("Opus 4.5 → GPT-5"), `outcome` işlem işaretlerinde sonucu söyler (özetleme:
 * yapıldı / yapacak iş yok / başarısız). `unsent` işaretinde `to` gönderilmeyen mesajın başıdır:
 * mesaj modele ulaşmadığı için yeniden açılışta balonu yoktur. Değerler kimliktir (model referansı, mod adı, seviye);
 * gösterilecek metin arayüz dilinde sözlükten kurulur.
 */
export const MarkerItem = z.object({
  type: z.literal("marker"),
  id: z.string(),
  kind: MarkerKind,
  from: z.string().optional(),
  to: z.string().optional(),
  outcome: z.enum(["done", "noop", "failed"]).optional(),
  at: z.number(),
});
export type MarkerItem = z.infer<typeof MarkerItem>;

export const TranscriptItem = z.discriminatedUnion("type", [
  UserItem,
  AssistantItem,
  ToolCallItem,
  BoundaryItem,
  MarkerItem,
]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;
export type UserItem = z.infer<typeof UserItem>;
export type AssistantItem = z.infer<typeof AssistantItem>;

/**
 * Transkript öğesinin zamanı. Araç kartları `startedAt` taşır (çağrı başlar, güncellemeler onu
 * izler), diğer öğeler `at`; işaret karıştırması ve sıralama tek kural kullansın diye burada durur.
 */
export function itemTime(item: TranscriptItem): number {
  return item.type === "tool" ? item.startedAt : item.at;
}
