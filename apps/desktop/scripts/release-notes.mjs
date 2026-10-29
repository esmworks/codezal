// electron-builder `releaseInfo.releaseNotesFile` girdisi: CHANGELOG'daki `## [<sürüm>]` bölümünü
// `release-notes.md`'ye yazar. Paketlemede `latest-mac.yml` / `latest.yml` içine `releaseNotes`
// olarak girer; uygulamadaki güncelleme kartı (`updater.ts` → `info.releaseNotes`) oradan okur.
//
// Her paketleme komutunun başında çalışır (`package:mac`, `package:win`, `package:linux`).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainifyNotes, sectionFor } from "./changelog.mjs";

const appDir = join(import.meta.dirname, "..");
const repoRoot = join(appDir, "..", "..");
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const outPath = join(appDir, "release-notes.md");

const body = sectionFor(changelog, pkg.version);
if (body === null) {
  // Yerel denemeler bloke olmasın; katı kapı yayın iş akışında (verify-release.mjs).
  console.warn(
    `Uyarı: CHANGELOG.md içinde "${pkg.version}" sürüm bölümü yok; release-notes.md boş yazıldı.`,
  );
  writeFileSync(outPath, "", "utf8");
} else {
  writeFileSync(outPath, body.length > 0 ? `${plainifyNotes(body)}\n` : "", "utf8");
  console.log(`release-notes.md yazıldı (${pkg.version}, ${body.length} karakter).`);
}
