// Paketleme doğrulaması: release/mac*/Codezal.app içindeki asar'ı listeler, boyutu ve Pi paketlerini kontrol eder.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const release = join(process.cwd(), "release");
const dirs = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith("mac")) : [];
if (dirs.length === 0) {
  console.error("release/mac* bulunamadı; önce `pnpm package` çalıştır.");
  process.exit(1);
}

/**
 * Main ve preload bundle'larının dışarıda bıraktığı paketler. Node çözümlemesi `out/main/index.mjs`
 * için yalnızca asar'ın üst düzey `node_modules`'una bakar; paket `@codezal/agent/node_modules/` gibi
 * iç içe kalırsa uygulama /Applications'tan açılırken ERR_MODULE_NOT_FOUND ile çöker (depo içinden
 * açılırken depo node_modules'u bulunup hata gizlenir).
 */
function externalPackages() {
  const names = new Set();
  const add = (spec) => {
    if (spec.startsWith("node:") || spec === "electron") return;
    const parts = spec.split("/");
    names.add(spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  };
  for (const [file, re] of [
    ["out/main/index.mjs", /^import\s+(?:[^;]*?\s+from\s+)?"([^"]+)";/gm],
    ["out/preload/index.cjs", /require\("([^"]+)"\)/g],
  ]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(re)) add(m[1]);
  }
  return [...names].sort();
}

const externals = externalPackages();
for (const d of dirs) {
  const asar = join(release, d, "Codezal.app/Contents/Resources/app.asar");
  if (!existsSync(asar)) continue;
  const size = statSync(asar).size / 1024 / 1024;
  const list = execFileSync("npx", ["--yes", "@electron/asar", "list", asar], {
    encoding: "utf8",
  }).split("\n");
  const entries = new Set(list);
  const pi = list.filter((l) => l.includes("@earendil-works/pi-coding-agent/dist/index.js")).length;
  const pty = list.filter((l) => l.includes("node-pty")).length;
  const maps = list.filter((l) => l.endsWith(".map")).length;
  const src = list.filter((l) => /\/node_modules\/[^/]+\/src\//.test(l)).length;
  const missing = externals.filter((name) => !entries.has(`/node_modules/${name}/package.json`));
  console.log(`${d}: app.asar ${size.toFixed(1)} MB, ${list.length} dosya`);
  console.log(
    `  pi-coding-agent: ${pi ? "var" : "YOK"}, node-pty: ${pty}, .map: ${maps}, src/: ${src}`,
  );
  console.log(`  üst düzey dış paketler: ${externals.length - missing.length}/${externals.length}`);
  if (size > 100) console.warn("  UYARI: asar 100 MB üstünde.");
  if (missing.length > 0) {
    console.error(
      `  HATA: üst düzey node_modules'ta yok: ${missing.join(", ")}. electron-builder pnpm yerine ` +
        "başka paket yöneticisi sanmış olabilir; derlemeyi `pnpm package:*` betikleriyle al.",
    );
    process.exitCode = 1;
  }
  if (!pi) process.exitCode = 1;
}
