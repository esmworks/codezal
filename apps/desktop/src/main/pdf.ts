import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type PdfRenderInput, withBaseHref } from "@codezal/agent";
import { BrowserWindow, type Session, session } from "electron";

/** Uzak görsel/yazı tipi yavaşsa sayfa yine basılır; eksik kaynak boş kalır, tur asılı kalmaz. */
const LOAD_TIMEOUT_MS = 20_000;

/** PDF pencerelerinin ortak, bellek içi oturumu: istek süzgeci uygulamanın oturumuna değmez. */
const PDF_PARTITION = "codezal-pdf";

/** Bir PDF penceresinin yükleyebileceği yerel kaynaklar. */
export interface PdfRequestScope {
  /** Basılan geçici HTML dosyası: ana çerçeve yalnız bu olabilir. */
  file: string;
  /** PDF'in klasörü: göreli görseller, stil ve yazı tipleri buradan gelir. */
  baseDir: string;
}

function localPath(url: string): string | undefined {
  try {
    return resolve(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

function isUnder(path: string, dir: string): boolean {
  const root = resolve(dir);
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * PDF penceresinin isteği yüklenebilir mi? Model HTML'i yazar; betik kapalı olsa da
 * `<iframe src="file:///…/.ssh/id_rsa">` ya da `<meta http-equiv="refresh">` ile yerel bir
 * dosyanın metni PDF'e basılıp sonra okunabiliyordu (okuma izninin dışından sızma). Bu yüzden
 * ana çerçeve yalnız geçici HTML'dir, iç çerçeve ve gömülü nesne hiç yüklenmez, yerel kaynak yalnız
 * PDF klasöründen gelir. Uzak `http(s)` görsel/stil/yazı tipi serbesttir.
 */
export function isPdfRequestAllowed(
  url: string,
  resourceType: string,
  scope: PdfRequestScope,
): boolean {
  if (resourceType === "mainFrame") return localPath(url) === resolve(scope.file);
  if (resourceType === "subFrame" || resourceType === "object") return false;
  if (url.startsWith("data:")) return true;
  if (url.startsWith("file:")) {
    const path = localPath(url);
    return path !== undefined && isUnder(path, scope.baseDir);
  }
  return url.startsWith("https:") || url.startsWith("http:");
}

/** Pencere kimliği → izinli kapsam; eşzamanlı PDF üretimleri birbirinin kapsamını kullanmaz. */
const scopes = new Map<number, PdfRequestScope>();
let filterInstalled = false;

function pdfSession(): Session {
  const ses = session.fromPartition(PDF_PARTITION);
  if (!filterInstalled) {
    filterInstalled = true;
    ses.webRequest.onBeforeRequest((details, callback) => {
      const scope =
        details.webContentsId === undefined ? undefined : scopes.get(details.webContentsId);
      const allowed =
        scope !== undefined && isPdfRequestAllowed(details.url, details.resourceType, scope);
      callback({ cancel: !allowed });
    });
  }
  return ses;
}

/**
 * `pdf_create` köprüsü: HTML geçici bir dosyaya yazılır, gizli bir pencerede yüklenir ve
 * Chromium `printToPDF` ile PDF'e çevrilir. Dış bağımlılık yok, Türkçe karakterler sistem yazı
 * tipleriyle basılır. Model yazdığı HTML'de betik çalıştıramaz (`javascript: false`); göreli
 * görsel yolları `<base href>` ile PDF'in klasörüne çözülür, yüklemeler `isPdfRequestAllowed`
 * süzgecinden geçer.
 */
export async function renderPdf(input: PdfRenderInput): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "codezal-pdf-"));
  const file = join(dir, "belge.html");
  const baseDir = input.baseDir.endsWith(sep) ? input.baseDir : `${input.baseDir}${sep}`;
  writeFileSync(file, withBaseHref(input.html, pathToFileURL(baseDir).href), "utf8");
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      session: pdfSession(),
    },
  });
  const id = win.webContents.id;
  // `<meta http-equiv="refresh">` betiksiz de gezinir; süzgeç iptal etse de sayfa yarım kalıp
  // basılamıyordu. Gezinme baştan durdurulur, belge kendi içeriğiyle basılır.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  scopes.set(id, { file, baseDir: input.baseDir });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, LOAD_TIMEOUT_MS);
    });
    await Promise.race([win.loadFile(file), timeout]);
    const pdf = await win.webContents.printToPDF({
      pageSize: input.pageSize,
      landscape: input.landscape,
      printBackground: true,
      // Belge `@page` verdiyse ölçüyü ve yönü ondan alır.
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  } finally {
    clearTimeout(timer);
    scopes.delete(id);
    win.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}
