import { isAbsolutePath, joinPath, type ToolCallItem } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { basename } from "./format";

const ICLOUD = "/Library/Mobile Documents/com~apple~CloudDocs";

/** Yolun kısa gösterimi: cwd altındaysa göreli, iCloud Drive `iCloud/`, ev dizini `~` ile. */
export function shortPath(path: string, cwd: string, home: string): string {
  // Ayraç her iki biçimde kabul edilir: Windows'ta yol ve kök `\` taşır, `/` ile aranan ön ek
  // hiç tutmaz ve satır kısaltılmak yerine tam yolu gösterirdi.
  const under = (base: string): boolean =>
    path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
  if (cwd && under(cwd)) return path.slice(cwd.length + 1);
  if (home && under(`${home}${ICLOUD}`)) return `iCloud${path.slice(home.length + ICLOUD.length)}`;
  if (home && under(home)) return `~${path.slice(home.length)}`;
  return path;
}

export interface TurnFile {
  path: string;
  name: string;
  /** Turdaki son işlem türü. */
  kind: "create" | "edit" | "delete";
  add: number;
  del: number;
  /** Diff çıktısı (İncele için); birden çok işlem varsa birleştirilir. */
  output: string;
}

function counts(output: string): { add: number; del: number } {
  const lines = output.split("\n");
  return {
    add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    del: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
  };
}

/**
 * Bir turda değişen dosyalar: oluşturma, düzenleme ve silme kartlarından ve terminal/alt ajan
 * kartlarının `changedFiles` listesinden, dosya başına tek satır. Göreli hedef cwd'ye göre
 * çözülür; reddedilen, hatalı ve süren yazma işlemleri sayılmaz.
 * `created` ilk kez bu turda oluşturulan dosyalardır (belge kartı olarak gösterilir).
 */
export function turnFiles(
  tools: ToolCallItem[],
  cwd: string,
): { created: TurnFile[]; changed: TurnFile[] } {
  const map = new Map<string, TurnFile>();
  const createdPaths = new Set<string>();
  const put = (path: string, kind: TurnFile["kind"], output: string) => {
    const c = counts(output);
    const prev = map.get(path);
    if (kind === "create") createdPaths.add(path);
    map.delete(path);
    map.set(path, {
      path,
      name: basename(path),
      kind,
      add: (prev?.add ?? 0) + c.add,
      del: (prev?.del ?? 0) + c.del,
      output: [prev?.output ?? "", output].filter(Boolean).join("\n"),
    });
  };
  for (const t of tools) {
    // Terminal komutu ya da alt ajanın değiştirdiği dosyalar (komut öncesi/sonrası farkı). Komut
    // hata koduyla bitse de dosyalar değişmiş olabilir; yalnız süren çağrı sayılmaz.
    if (t.changedFiles && t.status !== "running") {
      for (const f of t.changedFiles) {
        put(isAbsolutePath(f.path) ? f.path : joinPath(cwd, f.path), f.kind, "");
      }
    }
    if (t.kind !== "create" && t.kind !== "edit" && t.kind !== "delete") continue;
    if (t.status !== "done" || !t.target) continue;
    // Windows mutlak yolları (`C:\proj\src\a.ts`) da mutlaktır: yalnız `/` aranınca yol
    // `C:\proj/C:\proj\src\a.ts` oluyor, "Aç" ve geri alma çalışmıyordu.
    const path = isAbsolutePath(t.target) ? t.target : joinPath(cwd, t.target);
    put(path, t.kind, t.output ?? "");
  }
  const all = [...map.values()];
  return {
    created: all.filter((f) => createdPaths.has(f.path) && f.kind !== "delete"),
    changed: all,
  };
}

/** Tur sonunda kart olarak gösterilen belge türleri: uzantı → tür etiketi ("Belge · MD"). */
const DOC_KINDS: Record<string, TranslationKey> = {
  md: "turnFiles.doc",
  markdown: "turnFiles.doc",
  pdf: "turnFiles.doc",
  docx: "turnFiles.doc",
  txt: "turnFiles.text",
  csv: "turnFiles.table",
  xlsx: "turnFiles.table",
  pptx: "turnFiles.slides",
  html: "turnFiles.page",
  htm: "turnFiles.page",
};

/** Bir turun altında en fazla bu kadar belge kartı çizilir (ZCode ile aynı üst sınır). */
export const DOC_CARD_LIMIT = 10;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Kartın alt satırı için tür anahtarı ve büyük harfli uzantı; belge değilse undefined. */
export function docKind(name: string): { key: TranslationKey; ext: string } | undefined {
  const ext = extOf(name);
  const key = DOC_KINDS[ext];
  return key ? { key, ext: ext.toUpperCase() } : undefined;
}

/**
 * Tur sonu belge kartları: bu turda oluşturulan belgeler her zaman, yalnız düzenlenenler ise
 * turun son mesajında adı geçiyorsa. Kodlamada README/TODO gibi belgeler her tur elden geçer;
 * adı anılmayan düzenleme kart olursa her turun altı aynı kartlarla dolardı.
 */
export function docCards(
  files: { created: TurnFile[]; changed: TurnFile[] },
  text: string,
): TurnFile[] {
  const created = new Set(files.created.map((f) => f.path));
  return files.changed
    .filter(
      (f) =>
        f.kind !== "delete" &&
        docKind(f.name) !== undefined &&
        (created.has(f.path) || text.includes(f.name)),
    )
    .slice(0, DOC_CARD_LIMIT);
}
