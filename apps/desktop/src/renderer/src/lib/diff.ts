/**
 * `git diff` çıktısını (unified diff) satır satır çizilebilir hâle getirir. Amaç ham yamayı
 * göstermek değil: satır numaralı cetvel, eklenen/silinen satır rengi, değişen parçanın vurgusu
 * ve aradaki değişmeyen blokların tek satırda toplanması.
 *
 * Bağımlılık yok: ZCode bu görünümü ayrı bir diff kitaplığıyla çiziyor, burada yalnızca gereken
 * kadar ayrıştırma yapılır (hunk başlıkları, iki tarafın satır numaraları, ikili satırlarda
 * karakter farkı).
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** Eski dosyadaki satır numarası; eklenen satırda yok. */
  oldNo: number | null;
  /** Yeni dosyadaki satır numarası; silinen satırda yok. */
  newNo: number | null;
  text: string;
  /**
   * Değişen parçanın aralığı (karakter indeksleri). Yalnız ikili satırlarda (silinen+eklenen çifti)
   * doldurulur; satırın tamamı değiştiyse `null` kalır.
   */
  highlight: [number, number] | null;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@` başlığındaki açıklama (varsa) ve numaralar. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Yeni yol (silinen dosyada eski yol). */
  path: string;
  /** Dosya tamamen silindiyse true. */
  deleted: boolean;
  hunks: DiffHunk[];
}

/** Çizilecek satır listesi: ya bir hunk satırı ya da aradaki değişmeyen blok ayracı. */
export type DiffRow = { type: "lines"; lines: DiffLine[] } | { type: "gap"; count: number };

interface HunkHeader {
  oldStart: number;
  newStart: number;
  label: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function parseHeader(line: string): HunkHeader | null {
  const m = HUNK.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    newStart: Number(m[2]),
    label: (m[3] ?? "").trim(),
  };
}

/** Dosya yolunu `diff --git a/x b/y` ya da `+++ b/y` satırından çıkarır. */
function pathOf(plus: string | undefined, header: string | undefined): string {
  const fromPlus = plus?.replace(/^b\//, "").replace(/^"|"$/g, "");
  if (fromPlus && fromPlus !== "/dev/null") return fromPlus;
  const m = header ? /^diff --git a\/(.+?) b\/(.+)$/.exec(header) : null;
  return m?.[2] ?? m?.[1] ?? "";
}

/**
 * Unified diff metnini dosyalara böler. Dosya başlıkları (`diff --git`, `index`, `---`, `+++`)
 * çizilen satırlara girmez; yalnızca path bilgisi taşınır.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  // Silme bloğunun satırları, sırayla gelen ekleme satırlarıyla eşleştirilir (vurgu için).
  let pendingDel: DiffLine[] = [];
  const lines = patch.split("\n");

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pendingDel = [];
      file = {
        path: pathOf(undefined, line),
        deleted: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      file.path = pathOf(line.slice(4).trim(), undefined) || file.path;
      file.deleted = line.slice(4).trim() === "/dev/null";
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file mode"))
      continue;
    if (line.startsWith("deleted file mode")) {
      file.deleted = true;
      continue;
    }
    if (line.startsWith("@@")) {
      pendingDel = [];
      const parsed = parseHeader(line);
      hunk = {
        header: parsed?.label ?? "",
        oldStart: parsed?.oldStart ?? 1,
        newStart: parsed?.newStart ?? 1,
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // `\ No newline at end of file` bir içerik satırı değildir.
    if (line.startsWith("\\")) continue;
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") {
      const add: DiffLine = { kind: "add", oldNo: null, newNo, text, highlight: null };
      hunk.lines.push(add);
      newNo += 1;
      // Silme bloğuyla aynı sıradaki ekleme satırı: değişen parça vurgulanır.
      const pair = pendingDel.shift();
      if (pair) highlightPair(pair, add);
      continue;
    }
    if (sign === "-") {
      const del: DiffLine = { kind: "del", oldNo, newNo: null, text, highlight: null };
      hunk.lines.push(del);
      pendingDel.push(del);
      oldNo += 1;
      continue;
    }
    pendingDel = [];
    hunk.lines.push({ kind: "ctx", oldNo, newNo, text, highlight: null });
    oldNo += 1;
    newNo += 1;
  }
  return files.filter((f) => f.hunks.length > 0);
}

/**
 * İkili satırda yalnız değişen parçayı işaretler: ortak baş ve son kırpıldıktan sonra kalan
 * aralık vurgulanır. Tamamen farklı satırlarda vurgu yapılmaz (satırın tamamı zaten renkli).
 */
export function highlightPair(del: DiffLine, add: DiffLine): void {
  const a = del.text;
  const b = add.text;
  if (a === b) return;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start += 1;
  let suffix = 0;
  // Kalan (henüz eşleşmemiş) parçaların dışına taşmayacak kadar sondan eşleştir.
  while (suffix < max - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const delEnd = a.length - suffix;
  const addEnd = b.length - suffix;
  // Satırın tamamı farklıysa vurgu anlamlı değil (satır zaten baştan sona renkli).
  if (start === 0 && suffix === 0) return;
  // Saf ekleme/silmede bir tarafın ortası boş kalır (ör. "2" → "22"); yalnız dolu taraf vurgulanır.
  if (delEnd > start) del.highlight = wordBounds(a, start, delEnd);
  if (addEnd > start) add.highlight = wordBounds(b, start, addEnd);
}

const WORD = /[\w$]/;

/**
 * Vurguyu kelime sınırına genişletir: karakter bazlı kırpma "eski"/"yeni" çiftinde son harfi
 * (ortak `i`) dışarıda bırakıp `esk`/`yen` gibi yarım sözcükler boyuyordu. Yalnız satırın
 * tamamına yayılmadığı sürece genişletilir.
 */
function wordBounds(text: string, start: number, end: number): [number, number] {
  let from = start;
  let to = end;
  while (from > 0 && WORD.test(text[from - 1] ?? "")) from -= 1;
  while (to < text.length && WORD.test(text[to] ?? "")) to += 1;
  if (from === 0 && to === text.length) return [start, end];
  return [from, to];
}

/** Çizilecek satır yığını: hunk başlığı, değişmeyen blok ayracı ve içerik satırları. */
export type PatchRow =
  | { type: "hunk"; text: string }
  | { type: "gap"; count: number }
  | { type: "line"; line: DiffLine };

/** Çıktının satırları; sondaki satır sonu boş bir satır üretmez. */
function splitLines(output: string): string[] {
  const lines = output.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Pi'nin araç diff satırı: işaret, boşlukla hizalanmış numara, metin (`+12 metin`, ` 7 metin`). */
const TOOL_LINE = /^([+-]?)\s*(\d+)(?:[|:] ?| |$)(.*)$/;
/** Atlanan bağlamın yerini tutan satır (` ...`). */
const TOOL_GAP = /^\s*\.\.\.\s*$/;

/**
 * Pi'nin araç diff'ini (`edit` sonucu, `write` için sentezlenen diff) ham yamanın satır biçimine
 * çevirir. Pi her satıra **tek** numara yazar: eklenende yeni, silinende ve bağlamda eski dosyanın
 * numarası. Bağlamın yeni numarası o ana kadarki ekleme/silme farkından bulunur; böylece cetvel
 * tek sütunda tutarlı akar (bağlam ve ekleme yeni dosyadan, silme eski dosyadan). Aradaki ` ...`
 * "N satır değişmedi" ayracı olur; baştaki ve sondaki yazılmaz, ham yamada da yazılmıyor.
 * Ardışık silme+ekleme çiftlerinde değişen parça vurgulanır.
 */
export function parseToolDiff(output: string): PatchRow[] {
  const rows: PatchRow[] = [];
  // Yeni numara − eski numara: bağlam satırının yeni dosyadaki yeri.
  let shift = 0;
  let lastOld: number | null = null;
  let skipped = false;
  let pendingDel: DiffLine[] = [];
  for (const raw of splitLines(output)) {
    if (TOOL_GAP.test(raw)) {
      skipped = true;
      pendingDel = [];
      continue;
    }
    const m = TOOL_LINE.exec(raw);
    if (!m) {
      // Diff biçiminde olmayan satır (ör. hata metni) numarasız, olduğu gibi yazılır.
      pendingDel = [];
      rows.push({
        type: "line",
        line: { kind: "ctx", oldNo: null, newNo: null, text: raw, highlight: null },
      });
      continue;
    }
    const no = Number(m[2]);
    const text = m[3] ?? "";
    let line: DiffLine;
    if (m[1] === "+") {
      line = { kind: "add", oldNo: null, newNo: no, text, highlight: null };
      shift += 1;
      const pair = pendingDel.shift();
      if (pair) highlightPair(pair, line);
    } else if (m[1] === "-") {
      line = { kind: "del", oldNo: no, newNo: null, text, highlight: null };
      shift -= 1;
      pendingDel.push(line);
    } else {
      line = { kind: "ctx", oldNo: no, newNo: no + shift, text, highlight: null };
      pendingDel = [];
    }
    if (skipped && lastOld !== null && line.oldNo !== null && line.oldNo - lastOld > 1)
      rows.push({ type: "gap", count: line.oldNo - lastOld - 1 });
    skipped = false;
    if (line.oldNo !== null) lastOld = line.oldNo;
    rows.push({ type: "line", line });
  }
  return rows;
}

/** Diff olmayan çıktı (okuma, arama): satırlar sırayla numaralanır. */
export function plainRows(output: string): PatchRow[] {
  return splitLines(output).map((text, i) => ({
    type: "line",
    line: { kind: "ctx", oldNo: i + 1, newNo: i + 1, text, highlight: null },
  }));
}

/** Cetvelde yazılan tek numara: silinen satırda eski, diğerlerinde yeni dosyanınki. */
export function lineNumberOf(line: DiffLine): number | null {
  return line.kind === "del" ? line.oldNo : (line.newNo ?? line.oldNo);
}

const indentOf = (text: string): string => text.slice(0, text.length - text.trimStart().length);

/**
 * Satırların ortak girintisini atar. Kart dosyanın ortasından bir parça gösterir; derin iç içe
 * koddaki (JSX) girinti kodu sağa itip dar sohbet sütununda yatay kaydırmaya zorluyordu. Göreli
 * girinti korunur, yeri satır numarası söyler. Boş satırlar ortak girintiyi belirlemez.
 */
export function dedentRows(rows: PatchRow[]): PatchRow[] {
  let common: string | null = null;
  for (const row of rows) {
    if (row.type !== "line" || row.line.text.trim() === "") continue;
    const lead = indentOf(row.line.text);
    if (common === null) common = lead;
    else {
      let n = 0;
      while (n < common.length && n < lead.length && common[n] === lead[n]) n += 1;
      common = common.slice(0, n);
    }
    if (common === "") return rows;
  }
  if (!common) return rows;
  const cut = common.length;
  return rows.map((row) => {
    if (row.type !== "line") return row;
    const { text, highlight } = row.line;
    const drop = Math.min(cut, indentOf(text).length);
    if (drop === 0) return row;
    const moved: [number, number] | null =
      highlight && highlight[1] - drop > 0
        ? [Math.max(0, highlight[0] - drop), highlight[1] - drop]
        : null;
    return { type: "line", line: { ...row.line, text: text.slice(drop), highlight: moved } };
  });
}

/** Ham yama mı: sohbet kartlarındaki araç diff'i ile karışmasın diye başlıklardan anlaşılır. */
export function isUnifiedDiff(output: string): boolean {
  return /^diff --git /m.test(output) || /^@@ /m.test(output);
}

/**
 * Yamanın çizim sırası: her hunk'ın başlığı, aradaki değişmeyen bloklar ve satırlar. Tek dosyalık
 * yamalarda başlık yazılmaz (kart zaten dosya adını taşır); çok dosyalıda dosya adı başlık olur.
 */
export function buildPatchRows(patch: string): PatchRow[] {
  const files = parseUnifiedDiff(patch);
  const rows: PatchRow[] = [];
  for (const file of files) {
    if (files.length > 1) rows.push({ type: "hunk", text: file.path });
    for (const row of foldHunks(file.hunks)) {
      if (row.type === "gap") rows.push(row);
      else for (const line of row.lines) rows.push({ type: "line", line });
    }
  }
  return rows;
}

/**
 * Hunks arasındaki değişmeyen satırlar tek satırda toplanır ("N satır değişmedi"). İlk hunk'ın
 * öncesi ve son hunk'ın sonrası yazılmaz: dosyanın kalanı zaten değişmemiştir.
 */
export function foldHunks(hunk: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [index, current] of hunk.entries()) {
    const previous = hunk[index - 1];
    if (previous) {
      const gap = current.oldStart - (previous.oldStart + contextSpan(previous));
      if (gap > 0) rows.push({ type: "gap", count: gap });
    }
    rows.push({ type: "lines", lines: current.lines });
  }
  return rows;
}

/** Hunk'ın eski dosyada kapladığı satır sayısı (bağlam + silinen). */
function contextSpan(hunk: DiffHunk): number {
  return hunk.lines.filter((l) => l.kind !== "add").length;
}
