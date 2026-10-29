import type { AssistantItem, ToolCallItem, ToolKind } from "@codezal/contracts";

/** Araç kartı ve aynı hedefe önceki başarısız denemeleri. */
export interface ToolEntry {
  item: ToolCallItem;
  attempts: ToolCallItem[];
  /**
   * Satır kimliği: ilk çağrının id'si. Deneme birleşince (`collapseRetries`) ve çağrı bitince
   * değişmez; React satırı remount etmez, kart yerinde güncellenir.
   */
  anchorId: string;
}

/**
 * Başarısız çağrının hemen ardından aynı tür ve hedefe yapılan tekrar denemeyi tek kartta birleştirir:
 * "Oluşturulamadı … hata" + "Oluşturuldu … +7" yerine "Oluşturuldu … 2. deneme +7".
 */
export function collapseRetries(items: ToolCallItem[]): ToolEntry[] {
  const out: ToolEntry[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    const failed = last?.item.status === "error" || last?.item.status === "denied";
    if (
      last &&
      failed &&
      last.item.kind === item.kind &&
      last.item.target !== undefined &&
      last.item.target === item.target
    ) {
      // Kimlik ilk denemede kalır: satır silinip yeniden doğmaz, içeriği yerinde tazelenir.
      out[out.length - 1] = {
        item,
        attempts: [...last.attempts, last.item],
        anchorId: last.anchorId,
      };
    } else out.push({ item, attempts: [], anchorId: item.id });
  }
  return out;
}

/**
 * Terminal komutunun satır başlığı: Pi'nin eklediği `cd <cwd>` öneki (ardından `&&`, `;` ya da
 * satır sonu) düşer, kalan mutlak cwd yolları `./` olur. Tam komut açılır kartın başlığında durur.
 */
export function displayCommand(command: string, cwd: string): string {
  if (!cwd) return command;
  const esc = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command
    .replace(new RegExp(`^\\s*cd\\s+(?:"${esc}"|'${esc}'|${esc})[ \\t]*(?:&&|;|\\n)\\s*`), "")
    .replace(new RegExp(`${esc}/`, "g"), "./");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Hiç çalışmamış terminal çağrısı (hook reddetti, plan modu engelledi). Başlığı "Çalıştırıldı"
 * kalırsa sıfır dışı çıkışla biten komuttan ayırt edilmiyordu.
 */
export function terminalNotRun(item: ToolCallItem): boolean {
  return item.kind === "terminal" && (item.status === "denied" || item.status === "blocked");
}

/**
 * Katlanmış özetteki ilk hatanın kısa açıklaması: "Terminal python3 cizim.py: ModuleNotFoundError…".
 * Kart açılmadan neyin patladığı görünsün; çıktı yoksa yalnızca araç ve hedef yazılır. Hiç
 * çalışmamış komutta başlık yerine `notRunLabel` ("Çalıştırılmadı") yazılır.
 */
export function firstErrorDetail(
  entries: ToolEntry[],
  cwd: string,
  notRunLabel?: string,
): string | undefined {
  const failed = entries.find((e) => e.item.status === "error" || e.item.status === "denied");
  if (!failed) return undefined;
  const { item } = failed;
  const subject = item.command
    ? displayCommand(item.command, cwd)
    : ((item.target ?? "").split("/").pop() ?? "");
  const line =
    (item.output ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const title = notRunLabel && terminalNotRun(item) ? notRunLabel : item.title;
  const head = [title, clip(subject, 40)].filter(Boolean).join(" ");
  return line ? `${head}: ${clip(line, 90)}` : head;
}

/** Sayaç yuvası: sabit kimlik (tür başlığı) ve o türden biten çağrı sayısı. */
export interface CountPart {
  label: string;
  count: number;
}

/** Katlanmış satırın sayım dışı kalanları: hata, plan modunun engeli ve hook reddi. */
export interface StopCounts {
  errors: number;
  /** Plan modu engelledi; çağrı hiç çalışmadı. */
  blocked: number;
  /** Kullanıcının PreToolUse hook'u reddetti; çağrı hiç çalışmadı. */
  denied: number;
}

/** Sayım dışı kalanların etiketleri ("1 hata", "1 engellendi", "1 reddedildi"). */
export interface StopLabels {
  error: (n: number) => string;
  blocked: (n: number) => string;
  denied: (n: number) => string;
}

/**
 * Bitmiş çağrıları tür başlığına göre sayar; hata, engel ve reddi ayrı döner. Süren çağrı
 * sayılmaz: henüz "okundu" demedi, canlı satırda yalnızca sağdaki adım metninde görünür.
 * Engellenen/reddedilen çağrı başlığıyla sayılırsa hiç çalışmamış komut "1 çalıştırıldı"
 * görünüyordu. Sıra ilk görülme sırasıdır; yuvalar yer değiştirmediği için canlı satır her
 * araçta baştan yazılmaz.
 */
export function countParts(entries: ToolEntry[]): { parts: CountPart[] } & StopCounts {
  const counts = new Map<string, number>();
  const stops: StopCounts = { errors: 0, blocked: 0, denied: 0 };
  for (const e of entries) {
    const { status, title } = e.item;
    if (status === "running") continue;
    if (status === "error") stops.errors++;
    else if (status === "blocked") stops.blocked++;
    else if (status === "denied") stops.denied++;
    else counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return { parts: [...counts].map(([label, count]) => ({ label, count })), ...stops };
}

/** Hata, engel ve red sayılarını sırayla etikete çevirir; sıfır olanlar yazılmaz. */
export function stopLabels(stops: StopCounts, labels: StopLabels): string[] {
  const out: string[] = [];
  if (stops.errors) out.push(labels.error(stops.errors));
  if (stops.blocked) out.push(labels.blocked(stops.blocked));
  if (stops.denied) out.push(labels.denied(stops.denied));
  return out;
}

/**
 * Katlanmış grup özeti: "3 okundu · 2 oluşturuldu · 1 hata".
 *
 * Küçültme **arayüz diline** göre yapılır: sabit `"tr"` ile "ImageGen" gibi ham araç adları
 * İngilizce arayüzde "ımagegen" oluyordu (Türkçe küçültmede `I → ı`).
 */
export function summarizeTools(
  entries: ToolEntry[],
  labels: StopLabels,
  lang: "tr" | "en" = "tr",
): string {
  const { parts, ...stops } = countParts(entries);
  const out = parts.map((p) => `${p.count} ${p.label.toLocaleLowerCase(lang)}`);
  out.push(...stopLabels(stops, labels));
  return out.join(" · ");
}

/**
 * Canlı satırın sağında gösterilen adım: süren çağrı varsa o, yoksa dizinin son çağrısı
 * (dosya adı zihinde kalsın diye son dokunulan hedef).
 */
export function liveStep(entries: ToolEntry[]): ToolEntry | undefined {
  return entries.findLast((e) => e.item.status === "running") ?? entries[entries.length - 1];
}

/**
 * Çalışma dizisinin çizim adımı: tek kart, katlanmış kart grubu ya da ara anlatım/düşünme.
 */
export type RunStep =
  | { type: "assistant"; item: AssistantItem }
  | { type: "tool"; entry: ToolEntry }
  | { type: "group"; entries: ToolEntry[] };

/** Ardışık kartlardan en az bu kadarı tek satıra katlanır: iki tekrar da grup olur. */
export const GROUP_MIN = 2;

/**
 * Katlanan aileler: ZCode yalnızca keşif (okuma/arama) ve terminal ardışıklarını gruba alır —
 * `Explore` ve `Terminal` grupları. Düzenleme/oluşturma/silme/denetim çağrıları tek tek kalır:
 * ZCode'da değişiklik grubu kapalıdır (`ENABLE_CHANGES_TOOL_CALL_GROUPING = false`), çünkü her
 * dosya değişikliği kendi satırında okunur. Diğer türler için `null` döner.
 * Grup satırının tür etiketi de bu aileden gelir (`ToolGroup`).
 */
export function groupFamily(kind: ToolKind): "explore" | "terminal" | null {
  if (kind === "read" || kind === "search") return "explore";
  if (kind === "terminal") return "terminal";
  return null;
}

/**
 * Gruba girebilen kart: katlanan aileden, tekrar denemesi olmayan ve başarıyla bitmiş kart.
 * Hata, reddedilen, engellenen ve denemeli kart kendi satırında kalır (kırmızı ayrıntı satırı
 * kartın kendisinde okunur). `live` iken süren kart da ailesine katılır: tur sürerken satırlar
 * tek tek doğar, araç bitince satır yerinde kalır — ZCode da süren turda diziyi açık tutar.
 */
function groupable(e: ToolEntry, live: boolean): boolean {
  if (e.attempts.length > 0 || groupFamily(e.item.kind) === null) return false;
  return e.item.status === "done" || (live && e.item.status === "running");
}

/**
 * Çalışma dizisini çizim adımlarına böler. Ardışık keşif çağrıları (okuma/arama) ve terminal
 * komutları `min` ve üstündeyse tek gruba katlanır ("5 okundu · 2 arandı", "3 çalıştırıldı");
 * araya giren düşünme, anlatım, başka aile ya da hatalı/süren kart grubu böler. ZCode'un kuralı
 * budur: grubun ilk çağrısı hemen kendi satırında görünür, ikincisi gelince satır gruba döner.
 * `live` turda süren kart da gruba katılır; tekrar denemede yutulan kartlar atlanır.
 */
export function planRun(
  run: ReadonlyArray<ToolCallItem | AssistantItem>,
  { live = false, min = GROUP_MIN }: { live?: boolean; min?: number } = {},
): RunStep[] {
  const tools = run.filter((i): i is ToolCallItem => i.type === "tool");
  const byId = new Map(collapseRetries(tools).map((e) => [e.item.id, e]));
  const out: RunStep[] = [];
  let pending: ToolEntry[] = [];
  const flush = () => {
    if (pending.length >= min) out.push({ type: "group", entries: pending });
    else for (const entry of pending) out.push({ type: "tool", entry });
    pending = [];
  };
  for (const i of run) {
    if (i.type === "assistant") {
      flush();
      out.push({ type: "assistant", item: i });
      continue;
    }
    const e = byId.get(i.id);
    if (!e) continue;
    if (!groupable(e, live)) {
      flush();
      out.push({ type: "tool", entry: e });
      continue;
    }
    const last = pending[pending.length - 1];
    if (last && groupFamily(last.item.kind) !== groupFamily(e.item.kind)) flush();
    pending.push(e);
  }
  flush();
  return out;
}
