/**
 * Canlı satır değişimi: yazma/düzenleme sürerken karttaki `+N −N` sayacı buradan beslenir.
 * Pi'nin araç çıktısı (diff) ancak çağrı bitince geldiği için sayaç, modelin ürettiği **kısmi
 * araç girdisinden** ölçülür — ZCode da akış sırasında aynı yolu izler. `write` için yazılan
 * içeriğin satırları sayılır (Pi'nin write çıktısı da yalnız ekleme gösterir), `edit` için her
 * değiştirme bloğunun eski/yeni metni karşılaştırılır. Ölçü bitişteki gerçek diff'e yakınsar ama
 * garanti değildir: kısmi metin tamamlandıkça sayı ileri geri oynayabilir.
 */

export interface LineChangeStat {
  added: number;
  removed: number;
}

/**
 * LCS tablosunun hücre bütçesi: satır sayısı çarpımı bunu aşarsa tam karşılaştırma yapılmaz
 * (400k hücre ~4 MB geçici dizi; akış sırasında saniyede bir çalışan bir ölçü için üst sınır).
 */
const LCS_CELL_BUDGET = 400_000;

/** Satırlara ayırır; sondaki boş satır (dosya sonu yeni satırı) sayılmaz. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Değişmeyen satır sayısı; bütçe aşılırsa null (çağıran kaba tahmine düşer). */
function commonLines(a: readonly string[], b: readonly string[]): number | null {
  if (a.length * b.length > LCS_CELL_BUDGET) return null;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[b.length] ?? 0;
}

/**
 * İki metin arasındaki satır değişimi. Ortak önek/sonek kırpılır (değişen bölge küçülür), kalan
 * ortada LCS ile ortak satırlar bulunur: gerisi eklenen/silinen sayılır. `before` boşken (yeni
 * dosya) bütün satırlar eklenmiştir.
 */
export function computeLineChangeStat(before: string, after: string): LineChangeStat {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const oldMid = a.slice(head, a.length - tail);
  const newMid = b.slice(head, b.length - tail);
  if (oldMid.length === 0 || newMid.length === 0)
    return { added: newMid.length, removed: oldMid.length };
  const common = commonLines(oldMid, newMid);
  // Bütçe aşıldı: satır sayısı farkı kadar bir tahmin; sayaç bitişte gerçek diff'e döner.
  if (common === null)
    return {
      added: Math.max(0, newMid.length - oldMid.length),
      removed: Math.max(0, oldMid.length - newMid.length),
    };
  return { added: newMid.length - common, removed: oldMid.length - common };
}

/** `write` girdisinin içeriği; henüz akmamışsa undefined. */
function contentOf(args: Record<string, unknown> | undefined): string | undefined {
  const content = args?.content;
  return typeof content === "string" ? content : undefined;
}

/** Tek bir değiştirme bloğu: eski ve yeni metin. */
interface EditPair {
  oldText: string;
  newText: string;
}

/**
 * Pi `edits: [{oldText, newText}]` bekler, ama modeller sık sık tek nesne ya da JSON dizesi
 * yollar (Pi'nin `prepareArguments`'ı da bunları toparlar) ve eski `old_string/new_string`
 * adlarını kullanır. Kısmi akışta yeni metin henüz gelmemiş olabilir: boş metin geçerlidir.
 */
function editPairs(args: Record<string, unknown> | undefined): EditPair[] {
  if (!args) return [];
  const raw = args.edits;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? parseEdits(raw)
      : raw && typeof raw === "object"
        ? [raw]
        : [];
  const pairs: EditPair[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { oldText, newText } = item as { oldText?: unknown; newText?: unknown };
    if (typeof oldText !== "string" && typeof newText !== "string") continue;
    pairs.push({
      oldText: typeof oldText === "string" ? oldText : "",
      newText: typeof newText === "string" ? newText : "",
    });
  }
  if (pairs.length > 0) return pairs;
  const legacy = args as {
    oldText?: unknown;
    newText?: unknown;
    old_string?: unknown;
    new_string?: unknown;
  };
  const oldText = legacy.oldText ?? legacy.old_string;
  const newText = legacy.newText ?? legacy.new_string;
  if (typeof oldText !== "string" && typeof newText !== "string") return [];
  return [
    {
      oldText: typeof oldText === "string" ? oldText : "",
      newText: typeof newText === "string" ? newText : "",
    },
  ];
}

/** `edits` alanı JSON dizesi olarak gelirse (bazı modeller) diziyi çözer; değilse boş. */
function parseEdits(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    // Kısmi JSON: henüz çözülemez, sayaç bir sonraki akış parçasında güncellenir.
  }
  return [];
}

/** `write` çağrısının canlı ölçüsü: içerik büyüdükçe eklenen satır sayısı artar, silinen yoktur. */
export function writeChangeStat(
  args: Record<string, unknown> | undefined,
): LineChangeStat | undefined {
  const content = contentOf(args);
  if (content === undefined || content.length === 0) return undefined;
  return { added: splitLines(content).length, removed: 0 };
}

/** `edit` çağrısının canlı ölçüsü: bütün değiştirme bloklarının satır farkı toplanır. */
export function editChangeStat(
  args: Record<string, unknown> | undefined,
): LineChangeStat | undefined {
  const pairs = editPairs(args);
  if (pairs.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const pair of pairs) {
    const stat = computeLineChangeStat(pair.oldText, pair.newText);
    added += stat.added;
    removed += stat.removed;
  }
  return { added, removed };
}

/** Araç adına göre canlı ölçü; sayaç gösterilmeyen araçlarda undefined. */
export function liveChangeStat(
  toolName: string,
  args: Record<string, unknown> | undefined,
): LineChangeStat | undefined {
  if (toolName === "write") return writeChangeStat(args);
  if (toolName === "edit") return editChangeStat(args);
  return undefined;
}
