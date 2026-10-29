import { fileURLToPath } from "node:url";
import { app, session } from "electron";
import { log } from "./log.js";

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

/**
 * Uygulamanın kendi belgesi mi? `will-navigate` hedefi `file:` olduğu sürece kabul edilirse
 * pencereye sürüklenip bırakılan bir HTML dosyası preload köprüsünü devralır. Karşılaştırma
 * dosya yoluna indirgenir; `#`/`?` parçaları aynı belgeyi gösterdiği için yok sayılır.
 */
function isOwnDocument(raw: string): boolean {
  let target: string;
  try {
    target = fileURLToPath(new URL(raw));
  } catch {
    return false;
  }
  const own = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
  return target === own;
}

/** Hedef, geliştirme sunucusuyla **aynı kaynak** mı (önek değil, tam origin eşleşmesi). */
function sameOrigin(raw: string, dev: string): boolean {
  try {
    return new URL(raw).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

/**
 * Sertleştirme: gömülü <webview>'lar (Tarayıcı) main pencerenin preload'unu
 * ve Node erişimini devralamaz; açılan pencereler uygulama içinde açılmaz, `openLink`'e verilir
 * (ayara göre gömülü tarayıcı ya da sistem tarayıcısı); kamera/mikrofon gibi izin istekleri
 * reddedilir; ana pencere uygulama dışına yönlenemez.
 */
export function hardenWebContents(openLink: (url: string) => void): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      const src = params.src ?? "";
      if (src && !/^(https?|about):/i.test(src)) {
        log.warn("security", `webview engellendi: ${src}`);
        event.preventDefault();
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) openLink(url);
      return { action: "deny" };
    });

    // Ana pencere yalnızca kendi dosyasını ya da geliştirme sunucusunu yükler.
    if (contents.getType() === "window") {
      contents.on("will-navigate", (event, url) => {
        const dev = process.env.ELECTRON_RENDERER_URL;
        // `file:` öneki tek başına yetmez: preload her gezinmede yeniden enjekte edildiği için
        // pencereye bırakılan herhangi bir HTML dosyası (indirilen bir sayfa) tam IPC köprüsünü
        // alırdı — dosya yazma, terminal açma, oturum silme. Yalnız uygulamanın kendi belgesi
        // (ve `#`/`?` ile aynı belgeye giden parça adresleri) kabul edilir.
        // Geliştirmede de önek karşılaştırması yetmez (`http://localhost:5173.evil.com` öneki
        // taşır); kaynak (origin) birebir eşleşmeli.
        const ok = dev ? sameOrigin(url, dev) : isOwnDocument(url);
        if (!ok) {
          event.preventDefault();
          log.warn("security", `yönlendirme engellendi: ${url}`);
        }
      });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}
