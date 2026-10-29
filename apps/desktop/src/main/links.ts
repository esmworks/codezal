import type { AppSettings } from "@codezal/contracts";
import { shell } from "electron";
import { broadcast } from "./ipc.js";
import { log } from "./log.js";

/** localhost, 127.0.0.1, ::1, 0.0.0.0 ve `.local` adları yerel sayılır (geliştirme sunucuları). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      // Tam dörtlü aranır: `/^127\./` öneki `127.0.0.1.evil.com` gibi bir genel alan adını da
      // "yerel" sayıyordu (ayarın vaadi, genel sitelerin sistem tarayıcısında açılmasıdır).
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Yalnız bu makineye dönen adresler: OAuth geri dönüşü gibi yerel sunucular (LAN adı değil). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * İşletim sistemine verilebilecek adres mi. `shell.openExternal` şemaya bakmadan kayıtlı
 * uygulamayı çalıştırır: `file:`, `smb:`, `ms-msdt:` gibi adresler yerel dosya ya da program
 * açabilir. Sağlayıcıdan (OAuth, MCP sunucusu) gelen adres bu yüzden yalnız `https:` olabilir;
 * `http:` yalnız loopback'te (yerel geri dönüş sunucusu) ya da `allowHttp` ile kabul edilir.
 */
export function isSafeExternalUrl(url: string, options: { allowHttp?: boolean } = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return options.allowHttp === true || isLoopbackHost(parsed.hostname);
}

/** Denetimli `shell.openExternal`: güvenli değilse açmaz, günlüğe yazar ve false döner. */
export async function openExternalSafe(
  url: string,
  options: { allowHttp?: boolean } = {},
): Promise<boolean> {
  if (!isSafeExternalUrl(url, options)) {
    // Adresin kendisi yazılmaz: OAuth adresleri `state`/kod taşıyabilir.
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? "?";
    log.warn("security", `dış adres açılmadı (şema ${scheme})`);
    return false;
  }
  await shell.openExternal(url);
  return true;
}

/** Ayarlanan hedef: "app" gömülü tarayıcı sekmesi, "system" işletim sisteminin tarayıcısı. */
export function linkTargetFor(url: string, s: AppSettings): AppSettings["linkTarget"] {
  return isLocalUrl(url) ? s.localLinkTarget : s.linkTarget;
}

/** Sohbetten ya da gömülü sayfadan açılan bağlantıyı ayara göre yönlendirir. */
export function openLink(url: string, s: AppSettings): void {
  if (linkTargetFor(url, s) === "app") broadcast("link:open", { url });
  // Sohbetteki bağlantılarda genel `http:` siteleri de meşrudur; yalnız şema kısıtlanır.
  else void openExternalSafe(url, { allowHttp: true });
}
