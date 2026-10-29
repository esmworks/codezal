// Geliştirmede uygulama node_modules/electron içindeki Electron.app ile açılır; macOS Dock ve
// menü çubuğu adını çalıştırılan dosyanın adından türetir, app.setName() oraya erişemez.
// İkiliyi yeniden adlandıramayız: Electron `app.isPackaged`'ı da bu ada bakarak hesaplar
// (basename !== "electron" ise paketli sayar) ve geliştirme sürümü paketli davranmaya başlar.
// Bunun yerine "Codezal Dev" adıyla bir sembolik bağ açıp uygulamayı onun üzerinden başlatırız:
// macOS süreç adını başlatma yolundan alır, process.execPath ise gerçek yolu döndürür; böylece
// ad Codezal Dev olur, isPackaged false kalır. Ad bilinçli olarak yayın sürümünden farklı:
// ikisi de "Codezal" iken paketli sürüm kapatılıp `pnpm dev` açılınca kullanıcı uygulamanın
// kendini yeniden başlattığını sanıyordu. Veri kökü etkilenmez (main `app.setName("Codezal")`).
// İmza yalnızca ikiliyi kapsıyor (linker-signed, Info.plist bağlı değil), bu yüzden bozulmaz.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const APP_NAME = "Codezal Dev";
/** Önceki sürümlerin açtığı bağ adı; yeni bağ kurulunca kaldırılır. */
const LEGACY_NAMES = ["Codezal"];
const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = dirname(require.resolve("electron/package.json"));
} catch {
  process.exit(0);
}
const bundle = join(pkgDir, "dist", "Electron.app");
if (!existsSync(bundle)) process.exit(0);

const real = join(bundle, "Contents", "MacOS", "Electron");
const link = join(bundle, "Contents", "MacOS", APP_NAME);
const plist = join(bundle, "Contents", "Info.plist");
const plutil = (...args) => spawnSync("/usr/bin/plutil", args, { encoding: "utf8" });

const iconSrc = fileURLToPath(new URL("../apps/desktop/build/icon.icns", import.meta.url));
const iconDst = join(bundle, "Contents", "Resources", "electron.icns");
const iconStale =
  existsSync(iconSrc) &&
  (!existsSync(iconDst) || statSync(iconSrc).size !== statSync(iconDst).size);
// Dock kutucuğu adı ile bundle kimliği: makinede birden çok proje aynı "com.github.Electron"
// kimliğini kaydettiği için Dock ad çakışması yaşar; geliştirmeye ayrı bir kimlik veririz
// (yayın kimliği com.codezal.app ile karışmasın diye .dev soneki).
const BUNDLE_ID = "com.codezal.app.dev";
const keys = {
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  // Paket, bağ üzerinden başlatılsın; gerçek dosya "Electron" kaldığı için isPackaged bozulmaz.
  CFBundleExecutable: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID,
};
const current = (key) => plutil("-extract", key, "raw", "-o", "-", plist).stdout?.trim();
const linked = existsSync(link) && lstatSync(link).isSymbolicLink() && existsSync(real);
const patched = Object.entries(keys).every(([key, value]) => current(key) === value);
if (patched && linked && !iconStale) process.exit(0);

for (const [key, value] of Object.entries(keys)) {
  if (plutil("-replace", key, "-string", value, plist).status !== 0) {
    console.log(`[brand-dev-electron] ${key} yazılamadı, atlanıyor.`);
    process.exit(0);
  }
}
if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDst);

// Eski bir sürüm ikiliyi yeniden adlandırmış olabilir; gerçek dosyayı geri al, sonra bağı kur.
for (const name of [APP_NAME, ...LEGACY_NAMES]) {
  const old = join(bundle, "Contents", "MacOS", name);
  if (!existsSync(real) && existsSync(old) && lstatSync(old).isFile()) renameSync(old, real);
}
if (!existsSync(link)) symlinkSync("Electron", link);
// Eski ad (ör. "Codezal") bağı kalırsa zararsızdır ama karışıklık yaratır; yalnız bağsa silinir.
for (const name of LEGACY_NAMES) {
  const old = join(bundle, "Contents", "MacOS", name);
  if (existsSync(real) && lstatExists(old) && lstatSync(old).isSymbolicLink()) unlinkSync(old);
}

// electron paketi ikiliyi path.txt'den bulur; geliştirmede bağ üzerinden başlatılsın.
const pathFile = join(pkgDir, "path.txt");
const wanted = `Electron.app/Contents/MacOS/${APP_NAME}`;
if (existsSync(pathFile) && readFileSync(pathFile, "utf8").trim() !== wanted) {
  writeFileSync(pathFile, wanted);
}

// LaunchServices adı ve simgeyi önbelleğe alır; tarihi tazeleyip kaydı yeniden okuturuz.
const now = new Date();
utimesSync(bundle, now, now);
spawnSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", bundle],
);
console.log(`[brand-dev-electron] Geliştirme Electron paketi ${APP_NAME} olarak adlandırıldı.`);

/** Kırık bağ için de doğru: existsSync bağın hedefine bakar. */
function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
