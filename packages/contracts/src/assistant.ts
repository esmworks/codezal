/**
 * Asistan çıktı klasörü kuralı. Main (sistem istemi, klasör oluşturma) ve renderer
 * (çıktı tespiti) aynı yolu üretmek zorunda olduğundan burada, tek yerde tanımlıdır.
 * Renderer'da `node:path` yok; iki platformun yol kuralları da bu yüzden burada.
 */

/** Windows yolu: sürücü harfi (`C:\`) ya da UNC (`\\sunucu`). */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Mutlak yol mu; Windows'ta mutlak yol "/" ile başlamadığından ayrı kural gerekir. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsPath(path);
}

/** Tabanın ayracını koruyarak birleştirir: karışık ayraç kullanıcıya gösterilmesin. */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = isWindowsPath(base) ? "\\" : "/";
  const tail = parts
    .map((p) => (sep === "\\" ? p.replace(/\//g, sep) : p))
    .filter((p) => p.length > 0);
  return [base.replace(/[\\/]+$/, ""), ...tail].join(sep);
}

/** Windows'ta klasör adı olamayan aygıt adları (CON, PRN, COM1…). */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Proje adını dosya sistemi için güvenli klasör adına çevirir; boş kalırsa "Proje". */
export function safeFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Windows klasör adı nokta ya da boşlukla bitemez; kırpma macOS/Linux'ta da zararsız.
    .replace(/[. ]+$/, "");
  if (cleaned.length === 0) return "Proje";
  // Windows uzantılı adı da aygıta çözer ("CON.txt" yasak), ayrıca "CON " adını "CON" sayar:
  // taban ad (ilk noktadan öncesi) kırpılıp sınanır.
  const base = (cleaned.split(".")[0] ?? cleaned).trim();
  return WINDOWS_RESERVED_NAME.test(base) ? `${cleaned}_` : cleaned;
}

/**
 * Asistan çıktılarının kökü: `<Belgeler>/Codezal Asistan`. Kod deposunun (`<Belgeler>/Codezal`)
 * içinde tutulmaz; kullanıcının kendi depoları ile çıktılar aynı klasöre karışmasın.
 */
export const OUTPUTS_ROOT_NAME = "Codezal Asistan";

/** Bağlam kopyalarının alt klasörü: `<proje>/Bağlam`. */
export const CONTEXT_DIR_NAME = "Bağlam";

/** Çıktı kökünün tam yolu; ayraç tabandan gelir. */
export function outputsRootFor(documentsDir: string): string {
  return joinPath(documentsDir, OUTPUTS_ROOT_NAME);
}

/** Proje klasörü: `<Belgeler>/Codezal Asistan/<proje>`; proje yoksa `Genel`. */
export function projectDirFor(documentsDir: string, projectName: string | null): string {
  const folder = projectName === null ? "Genel" : safeFolderName(projectName);
  return joinPath(outputsRootFor(documentsDir), folder);
}

/** Bağlam kopyalarının klasörü: `<proje>/Bağlam`. */
export function contextDirFor(documentsDir: string, projectName: string | null): string {
  return joinPath(projectDirFor(documentsDir, projectName), CONTEXT_DIR_NAME);
}

/** `<Belgeler>/Codezal Asistan/<proje>/Çıktılar`. */
export function outputsDirFor(documentsDir: string, projectName: string | null): string {
  return joinPath(projectDirFor(documentsDir, projectName), "Çıktılar");
}

/** Kaba boyut etiketi: `512 B`, `3,4 MB`, `1,2 GB`; ondalık ayraç dile uyar. */
export function formatBytes(bytes: number, locale = "tr"): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    unit === 0
      ? String(Math.round(value))
      : new Intl.NumberFormat(locale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(value);
  return `${text} ${units[unit] ?? "B"}`;
}
