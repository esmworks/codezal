// Yayın sonrası denetim: updates.codezal.com'daki manifestleri ve her artefaktı gerçekten ister.
//
//   node scripts/verify-release.mjs [--version 1.0.0] [--base https://updates.codezal.com]
//
// Eski (Tauri) hattın `verify-release.mjs`'inin karşılığı; orada `platforms` + `signature` denetlenirdi,
// burada site sözleşmesi (`downloads`) ve electron-updater beslemeleri (`latest-mac.yml`, `latest.yml`)
// denetlenir. Yayın "bitti" sayılmadan önce çalıştırılır: manifest yeni sürümü gösterdiği hâlde dosya
// yüklenmemişse kullanıcı 404 alır ve güncelleme sessizce kırılır.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BASE = "https://updates.codezal.com";
const TIMEOUT_MS = 20_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const version = arg("--version", pkg.version);
const base = arg("--base", DEFAULT_BASE).replace(/\/+$/, "");

/** Cloudflare eski kopyayı sunarsa yayın "başarılı" görünür; her istek önbellek atlatılarak yapılır. */
function bust(url) {
  const u = new URL(url);
  u.searchParams.set("_", String(Date.now()));
  return u.toString();
}

async function get(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const problems = [];
const note = (message) => problems.push(message);

async function head(url) {
  let res = await get(url, { method: "HEAD" });
  // Bazı statik sunucular HEAD'e 405 döner; tek baytlık aralık isteği yeter.
  if (res.status === 405) res = await get(url, { headers: { range: "bytes=0-0" } });
  if (!res.ok && res.status !== 206) {
    note(`${url} → ${res.status} ${res.statusText}`);
    return null;
  }
  const length = res.headers.get("content-length");
  return length === null ? null : Number(length);
}

console.log(`Codezal ${version} doğrulanıyor — ${base}`);

// 1) Site manifesti: sürüm eşleşmeli, adresler indirilebilir olmalı.
const manifestRes = await get(bust(`${base}/latest.json`), {
  headers: { accept: "application/json", "cache-control": "no-cache" },
});
if (!manifestRes.ok) {
  console.error(`latest.json alınamadı: ${manifestRes.status} ${manifestRes.statusText}`);
  process.exit(1);
}
const manifest = await manifestRes.json();

if (manifest.version !== version) {
  note(`latest.json sürümü ${manifest.version}, beklenen ${version}`);
}
if (!manifest.downloads || typeof manifest.downloads !== "object") {
  // Eski Tauri manifesti tam olarak böyle görünür: `platforms` var, `downloads` yok.
  note("latest.json içinde `downloads` yok; site indirme kartlarını pasif bırakır");
} else {
  for (const [key, url] of Object.entries(manifest.downloads)) {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      note(`downloads.${key} https ile başlamıyor: ${url}`);
      continue;
    }
    if (!/\.(dmg|exe)$/.test(url)) {
      note(`downloads.${key} .dmg/.exe değil, site yok sayar: ${url}`);
      continue;
    }
    if (!url.includes(version)) {
      note(`downloads.${key} adresinde ${version} geçmiyor: ${url}`);
      continue;
    }
    const size = await head(url);
    console.log(
      `  ${key.padEnd(9)} ${url} (${size === null ? "?" : (size / 1024 / 1024).toFixed(1)} MB)`,
    );
  }
}

// 2) electron-updater beslemeleri: uygulama içi güncellemenin okuduğu dosyalar.
for (const feed of ["latest-mac.yml", "latest.yml"]) {
  const res = await get(bust(`${base}/${feed}`), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    note(`${feed} yok (${res.status}); o platformda uygulama içi güncelleme çalışmaz`);
    continue;
  }
  const text = await res.text();
  if (!text.includes(`version: ${version}`)) {
    note(`${feed} ${version} sürümünü göstermiyor`);
    continue;
  }
  // Sürüm notu: güncelleme kartı `releaseNotes` alanını gösterir. Elektron-builder bunu
  // `releaseInfo.releaseNotesFile`ten (CHANGELOG bölümü) yazar; eksikse kart notsuz kalır.
  if (!/^releaseNotes:/m.test(text)) {
    note(`${feed} içinde releaseNotes yok; güncelleme kartı sürüm notu gösteremez`);
  }
  // Besleme dosyayı ada göre ister; adı manifestten okuyup gerçekten var mı diye bakılır.
  const names = [...text.matchAll(/url:\s*(\S+)/g)].map((m) => m[1]);
  for (const name of names) {
    const size = await head(`${base}/${name}`);
    if (size !== null) console.log(`  ${feed} → ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

if (problems.length > 0) {
  console.error("\nSorunlar:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nYayın doğrulandı.");
