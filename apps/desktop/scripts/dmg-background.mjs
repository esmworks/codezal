// macOS DMG penceresinin arka planı: 1x ve 2x katmanlı `build/background.tiff`. electron-builder
// pencere boyutunu bu görselden alır (`dmg.window` görsel varken yok sayılır), simge konumları
// `electron-builder.yml` `dmg.contents`'tedir; ikisi birlikte değişmeli. Varsayılan şablon 540×380
// ve simgeleri y=220'ye koyduğu için üst kısım boş kalıyordu.
//
// Paketlemede çalışmaz; görsel depoda durur. Düzen değişince elle çalıştırın:
//   node apps/desktop/scripts/dmg-background.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, GlobalFonts, Path2D } from "@napi-rs/canvas";

// Finder pencere boyunu görsel boyuna eşitler ama bu boy başlık çubuğunu da içerir; görselin
// alttaki başlık payı kadarı hiç görünmez. Düzen görünür alana göre kurulur, pay yalnız zemin.
// macOS 26'da başlık 32 pt, eski sürümlerde 28 pt: fark altta birkaç pt fazla zemin olarak kalır.
const WIDTH = 600;
const VISIBLE = 320;
const TITLEBAR = 32;
const HEIGHT = VISIBLE + TITLEBAR;
// electron-builder.yml `dmg.contents` ile aynı olmalı (koordinatlar görünür alanın sol üstünden).
const ICON_Y = 148;
const APP_X = 160;
const APPS_X = 440;

const buildDir = join(import.meta.dirname, "..", "build");

GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF Pro");

// Ana ekrandaki küp dokusuyla aynı geometri (`HomeBackdrop.tsx`): 40 birim kenarlı, sivri
// tepeli altıgen döşeme; tek karo 69,28 × 120 birim.
const R = 40;
const TW = Math.sqrt(3) * R;
const TH = 3 * R;

function hex(cx, cy) {
  const hw = TW / 2;
  const half = R / 2;
  return [
    `M${cx} ${cy - R} L${cx + hw} ${cy - half} L${cx + hw} ${cy + half} L${cx} ${cy + R}`,
    `L${cx - hw} ${cy + half} L${cx - hw} ${cy - half} Z`,
    `M${cx} ${cy} L${cx} ${cy - R} M${cx} ${cy} L${cx - hw} ${cy + half} M${cx} ${cy} L${cx + hw} ${cy + half}`,
  ].join(" ");
}

function cubes() {
  const parts = [];
  // Karo yatayda ortalanır: doku pencerenin iki yanında simetrik görünür.
  const offsetX = (WIDTH / 2) % TW;
  for (let ty = -TH; ty < HEIGHT + TH; ty += TH) {
    for (let tx = offsetX - TW; tx < WIDTH + TW; tx += TW) {
      parts.push(hex(tx + TW / 2, ty + R), hex(tx, ty + 2.5 * R));
    }
  }
  return parts.join(" ");
}

function render(scale) {
  const canvas = createCanvas(WIDTH * scale, HEIGHT * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const bg = ctx.createLinearGradient(0, 0, 0, VISIBLE);
  bg.addColorStop(0, "#fbfbfa");
  bg.addColorStop(1, "#f0f0ee");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Doku üstte tam, simgelerin tepesine doğru söner; simgeler ve etiketler temiz zeminde kalır.
  const fade = ctx.createLinearGradient(0, 0, 0, ICON_Y);
  fade.addColorStop(0, "rgba(0, 0, 0, 0.075)");
  fade.addColorStop(0.4, "rgba(0, 0, 0, 0.075)");
  fade.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.strokeStyle = fade;
  ctx.lineWidth = 1;
  ctx.stroke(new Path2D(cubes()));

  // Sürükleme oku: simge merkezleri hizasında, iki simgenin tam ortasında.
  const cx = (APP_X + APPS_X) / 2;
  ctx.strokeStyle = "#a3a39e";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 30, ICON_Y);
  ctx.lineTo(cx + 30, ICON_Y);
  ctx.moveTo(cx + 18, ICON_Y - 12);
  ctx.lineTo(cx + 30, ICON_Y);
  ctx.lineTo(cx + 18, ICON_Y + 12);
  ctx.stroke();

  ctx.fillStyle = "#86868b";
  ctx.font = "13px 'SF Pro'";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Kurmak için Codezal'ı Applications klasörüne sürükleyin", cx, VISIBLE - 40);

  return canvas.toBuffer("image/png");
}

const tmp = mkdtempSync(join(tmpdir(), "codezal-dmg-"));
const png1 = join(tmp, "background.png");
const png2 = join(tmp, "background@2x.png");
writeFileSync(png1, render(1));
writeFileSync(png2, render(2));
// Tek TIFF'te iki çözünürlük: Retina ekranda Finder 2x katmanını seçer.
const res = spawnSync(
  "tiffutil",
  ["-cathidpicheck", png1, png2, "-out", join(buildDir, "background.tiff")],
  { stdio: "inherit" },
);
rmSync(tmp, { recursive: true, force: true });
if (res.status !== 0) process.exit(res.status ?? 1);
console.log(`DMG arka planı yazıldı: ${WIDTH}×${HEIGHT} (+2x) → build/background.tiff`);
