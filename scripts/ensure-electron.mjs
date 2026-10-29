// Electron 44+ paketinde postinstall yok; ikili ilk require'da iner. electron-vite ise
// path.txt yoksa "Electron uninstall" hatası verir. Bu betik kurulumdan sonra ikiliyi indirir.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = dirname(require.resolve("electron/package.json"));
} catch {
  console.log("[ensure-electron] electron paketi bulunamadı, atlanıyor.");
  process.exit(0);
}
const pathFile = join(pkgDir, "path.txt");
if (existsSync(pathFile) && existsSync(join(pkgDir, "dist"))) {
  process.exit(0);
}
console.log("[ensure-electron] Electron ikilisi indiriliyor…");
const result = spawnSync(process.execPath, [join(pkgDir, "install.js")], { stdio: "inherit" });
process.exit(result.status ?? 1);
