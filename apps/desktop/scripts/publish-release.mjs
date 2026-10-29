// Elle yayınlama: release/ içindeki artefaktları güncelleme sunucusuna kopyalar.
//
// NORMAL YOL BU DEĞİL. Yayın `v*` etiketiyle `.github/workflows/release.yml` üzerinden yapılır;
// oradaki publish işi güncelleme sunucusunun kendisinde çalışır ve dosyaları yerel olarak
// /var/codezal-updates altına kopyalar. Bu betik runner'lar hazır değilken ya da tek platform
// düzeltmesi için vardır. Ayrıntı: docs/RELEASE.md.
//
// Sıra önemlidir: ÖNCE ikililer, SONRA manifestler. Ters sırada bir istemci manifesti okuyup henüz
// yüklenmemiş dosyayı ister ve güncelleme 404 ile düşer.
//
// Gerekli ortam değişkenleri:
//   CODEZAL_RELEASE_TARGET   rsync hedefi, örn. "deploy@sunucu:/var/codezal-updates" ya da yerel yol
// İsteğe bağlı:
//   CODEZAL_RELEASE_SSH_KEY  özel anahtar yolu (rsync -e "ssh -i ...")
//   CF_ZONE_ID, CF_API_TOKEN Cloudflare önbelleğinde yalnızca manifestleri temizler
//
// Güvenlik kapısı: betik `--yes` olmadan yalnızca ne yapacağını yazar, hiçbir şey yüklemez.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "https://updates.codezal.com";
const root = process.cwd();
const releaseDir = join(root, "release");
const apply = process.argv.includes("--yes");

const target = process.env.CODEZAL_RELEASE_TARGET;
if (!target) {
  console.error(
    "CODEZAL_RELEASE_TARGET tanımlı değil.\n" +
      'Örnek: CODEZAL_RELEASE_TARGET="deploy@sunucu:/var/www/updates" pnpm release:upload --yes',
  );
  process.exit(1);
}
if (!existsSync(releaseDir)) {
  console.error("release/ yok; önce `pnpm package:mac` ve `pnpm release:manifest` çalıştır.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const all = readdirSync(releaseDir);

/** Kullanıcının indirdiği ya da electron-updater'ın istediği dosyalar; ara çıktılar (mac/, *.yaml) hariç. */
const binaries = all.filter(
  (f) => f.includes(version) && /\.(dmg|exe|AppImage|zip|blockmap)$/.test(f),
);
// Manifestler en sona: yayının "görünür olduğu" an bunların yüklendiği andır.
const manifests = ["latest-mac.yml", "latest.yml", "latest-linux.yml", "latest.json"].filter((f) =>
  existsSync(join(releaseDir, f)),
);

if (binaries.length === 0) {
  console.error(`release/ içinde ${version} sürümüne ait yüklenecek dosya yok.`);
  process.exit(1);
}
if (!manifests.includes("latest.json")) {
  console.error("latest.json yok; önce `pnpm release:manifest` çalıştır.");
  process.exit(1);
}

const mb = (name) => (statSync(join(releaseDir, name)).size / 1024 / 1024).toFixed(1);
console.log(`Sürüm ${version} → ${target}\n`);
console.log("1) İkililer");
for (const f of binaries) console.log(`   ${f}  (${mb(f)} MB)`);
console.log("2) Manifestler");
for (const f of manifests) console.log(`   ${f}`);
console.log(
  "\nUyarı: latest.json aynı adreste duran ESKİ (Tauri) sürüm hattının manifestini değiştirir;\n" +
    "0.5.x istemcilerinin güncelleme denetimi bundan sonra çalışmaz.",
);

if (!apply) {
  console.log("\nProva. Gerçekten yüklemek için `--yes` ekle.");
  process.exit(0);
}

const rsh = process.env.CODEZAL_RELEASE_SSH_KEY
  ? ["-e", `ssh -i ${process.env.CODEZAL_RELEASE_SSH_KEY}`]
  : [];

function upload(names) {
  execFileSync(
    "rsync",
    ["-avz", "--progress", ...rsh, ...names.map((n) => join(releaseDir, n)), target],
    {
      stdio: "inherit",
    },
  );
}

upload(binaries);
upload(manifests);

/**
 * İkililerin adında sürüm geçtiği için önbellek sorunu yaratmazlar; manifestler ise sabit adlıdır
 * ve Cloudflare'da eski kopya kalırsa yeni sürüm günlerce görünmez.
 */
const zone = process.env.CF_ZONE_ID;
const token = process.env.CF_API_TOKEN;
if (zone && token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ files: manifests.map((f) => `${BASE_URL}/${f}`) }),
  });
  console.log(
    res.ok ? "Cloudflare önbelleği temizlendi." : `Cloudflare temizleme başarısız: ${res.status}`,
  );
} else {
  console.log("CF_ZONE_ID / CF_API_TOKEN yok; manifest önbelleğini elle temizle.");
}

console.log("\nDoğrula:");
console.log(`  curl -sS ${BASE_URL}/latest.json`);
for (const f of binaries.filter((f) => /\.(dmg|exe)$/.test(f))) {
  console.log(`  curl -sSI ${BASE_URL}/${f} | head -3`);
}
