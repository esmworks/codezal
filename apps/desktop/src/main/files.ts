import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { convertDocx, convertXlsx, isDocx, isXlsx } from "@codezal/agent";
import type { FileBadge, FileContent, FileNode } from "@codezal/contracts";
import { localeOf } from "@codezal/i18n";
import { i18n } from "./i18n.js";

const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "release",
  ".DS_Store",
  ".worktrees",
  "target",
  ".next",
  ".cache",
]);
const MAX_READ = 512 * 1024;
/** Word önizlemesi bütün paketi okur; bundan büyük belge önizlenmez (main süreç kilitlenmesin). */
const MAX_DOCX_PREVIEW = 20 * 1024 * 1024;
/**
 * Excel paketi çok sıkışır (10 MB kitap 150 MB XML açtı, çevirisi ~10 sn); önizleme main'i
 * kilitlemesin diye dosya sınırı düşük, sayfa başına satır da sınırlı.
 */
const MAX_XLSX_PREVIEW = 4 * 1024 * 1024;
const MAX_XLSX_PREVIEW_ROWS = 500;

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

/** Proje dosyaları: tek seviye listeleme, okuma, arama. Kök dışına çıkılamaz. */
export function listDir(root: string, dir: string, badges: Map<string, FileBadge>): FileNode[] {
  if (!inside(root, dir)) throw new Error(i18n.t("errors.outsideRoot"));
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORED.has(e.name));
  const nodes: FileNode[] = entries.map((e) => {
    const path = join(dir, e.name);
    // Rozet anahtarları git'ten gelir ve her platformda `/` kullanır; `relative` Windows'ta `\`
    // ürettiği için kök dışındaki hiçbir dosya rozet almıyordu (M/A/D yalnız üst düzeyde görünürdü).
    const rel = relative(root, path).split(sep).join("/");
    const kind = e.isDirectory() ? "dir" : "file";
    const badge = kind === "file" ? badges.get(rel) : dirBadge(rel, badges);
    const node: FileNode = { name: e.name, path, kind };
    if (badge) node.badge = badge;
    if (kind === "file") {
      // Kırık sembolik bağ vb. stat edilemeyen dosya zamansız kalır, liste yine de döner.
      try {
        node.modifiedAt = statSync(path).mtimeMs;
      } catch {}
    }
    return node;
  });
  return nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, "tr") : a.kind === "dir" ? -1 : 1,
  );
}

function dirBadge(rel: string, badges: Map<string, FileBadge>): FileBadge | undefined {
  // Ön ek de `/` ile: anahtarlar git biçiminde (yukarıdaki normalizasyonun eşi).
  const prefix = `${rel}/`;
  for (const [p, b] of badges) if (p.startsWith(prefix)) return b === "A" || b === "?" ? "A" : "M";
  return undefined;
}

/**
 * Dosyanın başı okunur, tamamı değil: görüntüleyici yazım sürerken bu ucu 1,5 sn'de bir tazeliyor
 * ve ikili dosyanın içeriğini zaten kullanmıyor. `readFileSync` ile bütün dosyayı belleğe almak
 * büyük çıktılarda (yüz MB'lık PDF) main sürecini her yoklamada kilitliyordu.
 */
export function readFile(path: string): FileContent {
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.min(size, MAX_READ));
  let read = 0;
  if (buf.length > 0) {
    const fd = openSync(path, "r");
    try {
      // Okunan bayt sayısı kullanılır: dosya `stat` ile `read` arasında kısaldıysa (yazımı süren
      // bir çıktı dosyası; görüntüleyici 1,5 sn'de bir okuyor) kuyruk sıfır dolgulu kalıyor ve
      // metin dosyası boşuna "ikili" sayılıp okunamaz görünüyordu.
      read = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
  }
  const head = buf.subarray(0, read);
  const binary = head.subarray(0, 8000).includes(0);
  const markdown = binary ? officePreview(path, size) : undefined;
  return {
    path,
    content: binary ? "" : head.toString("utf8"),
    size,
    truncated: size > MAX_READ,
    binary,
    ...(markdown !== undefined ? { markdown } : {}),
  };
}

/**
 * Word belgesinin ya da Excel kitabının okuma görünümü; bozuk ya da yazımı süren paket önizlemesiz
 * kalır. Excel'de sayfa başına satır sınırlıdır: on binlerce satırlık kitap renderer'ı kilitlemesin.
 */
function officePreview(path: string, size: number): string | undefined {
  const lang = localeOf(i18n.language);
  try {
    if (isDocx(path) && size <= MAX_DOCX_PREVIEW) {
      return convertDocx(readFileSync(path), lang).markdown;
    }
    if (isXlsx(path) && size <= MAX_XLSX_PREVIEW) {
      return convertXlsx(readFileSync(path), lang, { maxRows: MAX_XLSX_PREVIEW_ROWS }).markdown;
    }
  } catch {
    // önizlemesiz kalır
  }
  return undefined;
}

export function writeFile(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

export function createFile(path: string): void {
  if (existsSync(path)) throw new Error(i18n.t("errors.fileExists"));
  writeFileSync(path, "", "utf8");
}

/** Ad tabanlı basit arama (en fazla 200 sonuç, 20.000 giriş). */
export function searchFiles(root: string, query: string): FileNode[] {
  const q = query.toLocaleLowerCase("tr");
  const out: FileNode[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (out.length >= 200 || visited > 20000 || depth > 12) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      visited++;
      const path = join(dir, e.name);
      if (e.name.toLocaleLowerCase("tr").includes(q)) {
        out.push({ name: e.name, path, kind: e.isDirectory() ? "dir" : "file" });
        if (out.length >= 200) return;
      }
      if (e.isDirectory()) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
