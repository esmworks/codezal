/**
 * Yerel dosya önizleme şeması. Renderer geliştirmede http://, pakette file:// kökünden yüklenir;
 * ikisinde de rastgele bir yerel dosyayı <iframe>/<img> ile doğrudan açamaz. Main süreç
 * `codezal-file://local/<yol>` şemasını servis eder; adres biçimini iki taraf da buradan alır.
 */

export const LOCAL_FILE_SCHEME = "codezal-file";

/**
 * Şemadan servis edilen önizleme türleri: PDF gömülü görüntüleyicide, görseller <img> ile,
 * HTML betiksiz bir iframe'de (göreli görseller aynı şemadan yüklensin diye).
 */
export type PreviewKind = "pdf" | "image" | "html";

const MIME: Record<string, { kind: PreviewKind; type: string }> = {
  pdf: { kind: "pdf", type: "application/pdf" },
  png: { kind: "image", type: "image/png" },
  jpg: { kind: "image", type: "image/jpeg" },
  jpeg: { kind: "image", type: "image/jpeg" },
  gif: { kind: "image", type: "image/gif" },
  webp: { kind: "image", type: "image/webp" },
  svg: { kind: "image", type: "image/svg+xml" },
  html: { kind: "html", type: "text/html" },
  htm: { kind: "html", type: "text/html" },
};

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Dosya şemadan önizlenebilir mi; değilse `undefined` (diğer metin dosyaları ayrıca ele alınır). */
export function previewKindFor(path: string): PreviewKind | undefined {
  return MIME[extensionOf(path)]?.kind;
}

/** Şemanın servis ettiği içerik türü; önizlenemeyen dosyalar servis edilmez. */
export function previewMimeFor(path: string): string | undefined {
  return MIME[extensionOf(path)]?.type;
}

/** Yolu şema adresine çevirir; her parça ayrı kodlanır ki `#`, `?` ve boşluk bozmasın. */
export function localFileUrl(path: string): string {
  // UNC (`\\sunucu\paylasim\x`): sunucu adı yolun parçasıdır, baştaki "//" korunur.
  if (/^[\\/]{2}[^\\/]/.test(path)) {
    const body = path.slice(2).split(/[\\/]/).map(encodeURIComponent).join("/");
    return `${LOCAL_FILE_SCHEME}://local//${body}`;
  }
  const parts = path.split(/[\\/]/);
  // POSIX yolu "/" ile başlar: ilk boş parça atılır. Windows'ta ilk parça sürücü harfidir ("C:").
  const body = (parts[0] === "" ? parts.slice(1) : parts).map(encodeURIComponent).join("/");
  return `${LOCAL_FILE_SCHEME}://local/${body}`;
}

/** Şema adresinden yolu çıkarır; şema ya da sunucu adı uymuyorsa `undefined`. */
export function localFilePath(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${LOCAL_FILE_SCHEME}:` || parsed.host !== "local") return undefined;
  const decoded = decodeURIComponent(parsed.pathname);
  // UNC: "//sunucu/paylasim/x" → "\\\\sunucu\paylasim\x" (baştaki çift ayraç korunur).
  if (decoded.startsWith("//")) return `\\\\${decoded.slice(2).replace(/\//g, "\\")}`;
  // "/C:/Users/..." biçimindeki Windows yolunda baştaki bölü atılır.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1).replace(/\//g, "\\") : decoded;
}
