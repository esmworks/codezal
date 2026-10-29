// Yayın hazırlığı: release/ klasöründeki artefaktları doğrular ve site için `latest.json` yazar.
//
// İki ayrı manifest vardır, karıştırılmamalı:
//   latest-mac.yml / latest.yml → electron-updater okur (uygulama içi güncelleme). electron-builder üretir.
//   latest.json                 → codezal.com/download okur (kullanıcının tıkladığı indirme bağlantıları).
//                                 electron-builder bunu üretmez; bu betik üretir.
//
// Site sözleşmesi (codezal-website `src/lib/release.ts`): adresler ŞABLONDAN KURULMAZ, `downloads`
// içindeki adres birebir kullanılır ve yalnızca .dmg / .exe kabul edilir. Bu yüzden burada dosya
// adları uydurulmaz, release/ içinde GERÇEKTEN duran dosyalardan üretilir.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "https://updates.codezal.com";
const root = process.cwd();
const releaseDir = join(root, "release");

if (!existsSync(releaseDir)) {
  console.error(
    "release/ yok; önce `pnpm package:mac` (ve Windows'ta `pnpm package:win`) çalıştır.",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const files = readdirSync(releaseDir);

/**
 * Sürüm numarası adın içinde **sınırla** geçmeli; yayına karışmasın.
 *
 * Düz `includes` ile `1.0.6` sürümü `Codezal-Setup-1.0.60.exe` dosyasını da bu sürümün sanıyor,
 * `pick` iki aday görüp paketlemeyi "birden çok aday var" diye durduruyordu.
 */
const ofThisVersion = (name) =>
  // Öncesinde ayraç, sonrasında rakam olmamalı: `1.0.6` artık `1.0.60`ı yakalamaz, ama
  // `Codezal-Setup-1.0.6.exe` (ardından nokta) geçer.
  new RegExp(`[-_v]${version.replace(/\./g, "\\.")}(?![0-9])`).test(name);

function pick(suffix) {
  const hit = files.filter((f) => f.endsWith(suffix) && ofThisVersion(f));
  if (hit.length > 1) {
    console.error(`Birden çok aday var, adlar belirsiz: ${hit.join(", ")}`);
    process.exit(1);
  }
  return hit[0] ?? null;
}

const macArm = pick("-arm64.dmg");
const macIntel = pick("-x64.dmg");
const win = pick(".exe");

/**
 * macOS'ta imzasız ya da notarize edilmemiş bir DMG yayınlamak, kullanıcıya "hasarlı" uyarısı
 * gösterir. Yayından önce burada yakalanır; Windows/Linux'ta `spctl` yoktur, denetim atlanır.
 */
function gatekeeperOk(name) {
  if (process.platform !== "darwin") return null;
  // spctl kararını stderr'e yazar; yalnız stdout okunursa her dosya reddedilmiş sanılır.
  const run = spawnSync(
    "spctl",
    ["-a", "-vvv", "-t", "open", "--context", "context:primary-signature", join(releaseDir, name)],
    { encoding: "utf8" },
  );
  return `${run.stdout ?? ""}${run.stderr ?? ""}`.includes("accepted");
}

const problems = [];
for (const name of [macArm, macIntel]) {
  if (!name) continue;
  const ok = gatekeeperOk(name);
  if (ok === false) problems.push(`${name}: imzasız ya da notarize edilmemiş (spctl reddetti)`);
}
if (!existsSync(join(releaseDir, "latest-mac.yml")) && (macArm || macIntel)) {
  problems.push("latest-mac.yml yok: uygulama içi güncelleme çalışmaz");
}
if (win && !existsSync(join(releaseDir, "latest.yml"))) {
  problems.push("latest.yml yok: Windows'ta uygulama içi güncelleme çalışmaz");
}

const downloads = {};
if (macArm) downloads.macArm = `${BASE_URL}/${macArm}`;
if (macIntel) downloads.macIntel = `${BASE_URL}/${macIntel}`;
if (win) downloads.win = `${BASE_URL}/${win}`;

if (Object.keys(downloads).length === 0) {
  console.error(`release/ içinde ${version} sürümüne ait .dmg/.exe yok.`);
  process.exit(1);
}

const manifest = {
  version,
  notes: "https://codezal.com/docs#intro",
  pub_date: new Date().toISOString(),
  downloads,
};

const out = join(releaseDir, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`latest.json yazıldı: ${out}`);
for (const [key, url] of Object.entries(downloads)) console.log(`  ${key.padEnd(9)} ${url}`);
const missing = ["macArm", "macIntel", "win"].filter((k) => !downloads[k]);
if (missing.length > 0) {
  console.log(`\nEksik platform (site kartı pasif kalır): ${missing.join(", ")}`);
}
if (problems.length > 0) {
  console.error("\nYayınlamadan önce düzeltilmesi gerekenler:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
