// Sürüm numarasını kök ve apps/desktop package.json'larında aynı anda değiştirir ve CHANGELOG'daki
// "Unreleased" bölümünü `## [<sürüm>] - <tarih>` başlığına kapatır (üstüne yeni boş bölüm açar).
//
//   node scripts/bump-version.mjs 1.0.0          # yalnız dosyaları yazar
//   node scripts/bump-version.mjs 1.0.0 --tag    # ek olarak commit + `v1.0.0` etiketi (push ETMEZ)
//
// İkisi ayrışırsa yayın hattı durur: Release iş akışı etiketle `apps/desktop/package.json`
// sürümünü karşılaştırır, `latest.json` da o dosyadan okunur. Bump'ın kapattığı CHANGELOG bölümü
// paketlemede `release-notes.md` olarak `latest-mac.yml` / `latest.yml` içine girer.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { closeUnreleased } from "../apps/desktop/scripts/changelog.mjs";

const version = process.argv[2];
const doTag = process.argv.includes("--tag");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version)) {
  console.error(`Geçersiz sürüm: "${version ?? ""}"`);
  console.error("Örnek: node scripts/bump-version.mjs 1.0.0 [--tag]");
  process.exit(1);
}

const files = ["package.json", "apps/desktop/package.json"];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const re = /"version":\s*"[^"]*"/;
  if (!re.test(src)) {
    console.error(`Sürüm satırı bulunamadı: ${file}`);
    process.exit(1);
  }
  writeFileSync(file, src.replace(re, `"version": "${version}"`));
  console.log(`  ${file}`);
}

// Yerel tarih: not başlığı kullanıcının takvim gününü göstersin (toISOString UTC'dir).
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
  now.getDate(),
).padStart(2, "0")}`;
const changelogFile = "CHANGELOG.md";
const { text, empty } = closeUnreleased(readFileSync(changelogFile, "utf8"), version, date);
writeFileSync(changelogFile, text);
console.log(`  ${changelogFile}`);
if (empty) {
  console.warn('Uyarı: "Unreleased" bölümü boştu; sürüm notu maddesiz yayınlanacak.');
}

if (doTag) {
  const tag = `v${version}`;
  execFileSync("git", ["commit", "-m", `Sürüm ${version}`, "--", ...files, changelogFile], {
    stdio: "inherit",
  });
  execFileSync("git", ["tag", tag], { stdio: "inherit" });
  console.log(`  ${tag} — yayın için: git push origin HEAD ${tag}`);
}

console.log(`Sürüm ${version}`);
