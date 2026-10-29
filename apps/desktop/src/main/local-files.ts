import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { LOCAL_FILE_SCHEME, localFilePath, previewMimeFor } from "@codezal/contracts";
import { protocol } from "electron";
import { log } from "./log.js";

/**
 * `codezal-file://local/<yol>`: renderer'ın PDF, görsel ve HTML çıktıları <iframe>/<img> ile
 * göstermesi için. Yalnızca önizlenebilir türler servis edilir. HTML hiçbir koşulda betik
 * çalıştırmaz: yanıt CSP `sandbox` ile opak kökende açılır, renderer iframe'i de `sandbox=""`
 * taşır. Renderer zaten `files:read` ile her dosyayı okuyabildiğinden yeni bir erişim alanı açılmaz.
 */
export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
/**
 * HTML çıktısı (teklif e-postası, rapor) düz belge olarak çizilir. Çıplak `sandbox` betiği ve
 * formu kapatır, kökeni opaklaştırır: belge doğrudan açılsa bile aynı şemadaki başka dosyaları
 * okuyamaz. Göreli görseller (`logo.png`) aynı şemadan gelir; dış kaynak yüklenmez.
 */
const HTML_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src codezal-file: data:; " +
  "form-action 'none'; base-uri 'none'";

interface Span {
  start: number;
  end: number;
}

/** `Range` başlığı → bayt aralığı. Geçersiz aralık `null`, başlık yoksa `undefined`. */
function parseRange(header: string | null | undefined, size: number): Span | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart = "", rawEnd = ""] = m;
  if (rawStart === "" && rawEnd === "") return null;
  // "bytes=-500": sondan N bayt.
  const start = rawStart === "" ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === "" ? size - 1 : rawEnd === "" ? size - 1 : Number(rawEnd);
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * İstek → yanıt; test edilebilsin diye Electron'dan bağımsız.
 *
 * Gövde akıtılır ve `Range` desteklenir: Chromium'un PDF görüntüleyicisi dosyayı parça parça
 * ister, tamamını belleğe alıp vermek büyük çıktılarda main sürecini her istekte kilitliyordu.
 */
export function localFileResponse(url: string, range?: string | null): Response {
  const path = localFilePath(url);
  const type = path ? previewMimeFor(path) : undefined;
  if (!path || !type) return new Response(null, { status: 403 });
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return new Response(null, { status: 404 });
  }
  const headers: Record<string, string> = {
    // Ajan çıktısı çoğu kez `<meta charset>` taşımayan bir parça; Türkçe harfler bozulmasın.
    "content-type": type === "text/html" ? "text/html; charset=utf-8" : type,
    "accept-ranges": "bytes",
    // Tarayıcı türü içerikten tahmin etmesin: `.png` adlı bir HTML belge olarak yorumlanmasın.
    "x-content-type-options": "nosniff",
  };
  // SVG belge olarak açılırsa (iframe, doğrudan gezinme) içindeki `<script>` ve olay öznitelikleri
  // uygulama kökeninde çalışırdı. Politika betiği ve dış yüklemeyi kapatır; satır içi stil ve
  // gömülü `data:` görselleri çizim için açık kalır. PDF'e verilmez: Chromium görüntüleyicisini bozar.
  if (type === "image/svg+xml") headers["content-security-policy"] = SVG_CSP;
  if (type === "text/html") headers["content-security-policy"] = HTML_CSP;
  if (size === 0) return new Response(null, { status: 200, headers });

  const span = parseRange(range, size);
  if (span === null)
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  const start = span?.start ?? 0;
  const end = span?.end ?? size - 1;
  headers["content-length"] = String(end - start + 1);
  if (span) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: span ? 206 : 200, headers });
}

/**
 * İstek uygulama penceresi dışından mı geliyor? Gömülü tarayıcı (<webview>) varsayılan oturumu
 * paylaştığı için açılan herhangi bir site `<img src="codezal-file://…">` ile yerel dosyaların
 * varlığını yoklayabilir. Protokol işleyicisi isteği yapan webContents'i bilmez; elimizdeki tek
 * iz referrer'dır. Referrer'ı `http(s)` olup uygulamanın kendi kökeni (geliştirme sunucusu)
 * olmayan istek reddedilir. Boş referrer kabul edilir: paketli uygulama `file:` sayfasıdır ve
 * referrer göndermez, PDF görüntüleyicisinin parça istekleri de öyle. Bu yüzden
 * `referrerpolicy="no-referrer"` kullanan bir sayfa denetimi aşabilir; asıl çözüm webview'a ayrı
 * `partition` vermektir (renderer tarafı).
 */
export function isForeignReferrer(referrer: string, rendererUrl?: string): boolean {
  if (!referrer || referrer === "about:client") return false;
  let origin: string;
  let protocolName: string;
  try {
    const parsed = new URL(referrer);
    origin = parsed.origin;
    protocolName = parsed.protocol;
  } catch {
    return false;
  }
  if (protocolName !== "http:" && protocolName !== "https:") return false;
  if (!rendererUrl) return true;
  try {
    return new URL(rendererUrl).origin !== origin;
  } catch {
    return true;
  }
}

export function serveLocalFiles(): void {
  protocol.handle(LOCAL_FILE_SCHEME, (request) => {
    const referrer = request.referrer || request.headers.get("referer") || "";
    if (isForeignReferrer(referrer, process.env.ELECTRON_RENDERER_URL)) {
      log.warn("local-file", `yabancı kaynaktan istek reddedildi: ${new URL(referrer).origin}`);
      return new Response(null, { status: 403 });
    }
    const res = localFileResponse(request.url, request.headers.get("range"));
    if (res.status >= 400) log.warn("local-file", `${res.status}: ${request.url}`);
    return res;
  });
}
