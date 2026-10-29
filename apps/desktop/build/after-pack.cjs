"use strict";

// Pi'nin native modülleri macOS'ta "adhoc, linker-signed" gelir (Apple Silicon derleyicisi
// otomatik ekler). osx-sign bunları `--force --timestamp` ile yeniden imzalarken
// "A timestamp was expected but was not found" hatası verip yayını düşürüyor: linker imzasında
// zaman damgası yoktur. Paketleme biter, imzalama başlamadan önce bu imzaları sileriz; dosyalar
// aşağıda normal yoldan, sertleştirilmiş çalışma zamanıyla imzalanır.
//
// Yalnız `linker-signed` imzalar hedeflenir: Electron framework'ünün ve hazır ikililerin Apple ya
// da Developer ID imzalarına dokunulmaz.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BINARY = /\.(node|dylib|so)$/;

function collectBinaries(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBinaries(full, found);
    else if (entry.isFile() && BINARY.test(entry.name)) found.push(full);
  }
  return found;
}

function signatureInfo(file) {
  const result = spawnSync("codesign", ["-dvv", file], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const files = collectBinaries(context.appOutDir, []);
  let stripped = 0;
  for (const file of files) {
    if (!signatureInfo(file).includes("linker-signed")) continue;
    const removed = spawnSync("codesign", ["--remove-signature", file], { encoding: "utf8" });
    if (removed.status === 0) stripped += 1;
    else console.warn(`[after-pack] linker imzası silinemedi: ${file}\n${removed.stderr ?? ""}`);
  }
  if (stripped > 0) {
    console.log(
      `[after-pack] ${stripped} linker imzası silindi; imzalama adımı yeniden imzalayacak`,
    );
  }
};
