import type { UpdateStatus } from "@codezal/contracts";
import { app } from "electron";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { broadcast } from "./ipc.js";
import { log } from "./log.js";

let status: UpdateStatus = {
  state: app.isPackaged ? "idle" : "disabled",
  currentVersion: app.getVersion(),
};
let started = false;

/** Başarılı denetimden sonraki normal aralık: 15 dakika (bkz. startUpdater). */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Denetim hatasında (ağ kalkıyor, DNS yok) normal aralığı beklemeden artan gecikmeyle yeniden
 * denenir: 1 → 2 → 5 dakika; dördüncü ve sonraki başarısızlıklarda 15 dakikalık aralığa dönülür.
 */
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000];

function nextDelayMs(failures: number): number {
  if (failures <= 0) return CHECK_INTERVAL_MS;
  return RETRY_DELAYS_MS[failures - 1] ?? CHECK_INTERVAL_MS;
}

/** Dağıtım sağlayıcısında yayınlanmış sürüm yoksa electron-updater bu metinle 404 hatası verir. */
function isMissingChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot find channel");
}

/**
 * İndirme sürüyor ya da güncelleme kuruluma hazır: yeni bir denetim bu durumu geriletmemeli.
 * Önceden 15 dakikalık denetim `ready` iken de koşup durumu `checking`/`available`'a düşürüyor,
 * karttaki "Yeniden başlat" kayboluyor ve `installUpdate` (`state !== "ready"`) hiçbir şey yapmıyordu.
 */
function busy(): boolean {
  return status.state === "downloading" || status.state === "ready";
}

/** Alanlar birleştirilir: ilerleme olayları yeni sürüm bilgisini (version, notes) silmesin. */
function set(next: UpdateStatus): void {
  status = { ...status, ...next };
  broadcast("update:status", status);
}

/**
 * electron-updater tembel yüklenir; geliştirme sürümünde hiç dokunulmaz. Paket CJS'dir ve `autoUpdater`'ı
 * getter ile tanımlar; ESM'den adlı import bunu göremez (undefined), `default` (module.exports) üzerinden okunur.
 */
async function updater() {
  const mod = await import("electron-updater");
  const cjs = (mod as unknown as { default?: typeof mod }).default ?? mod;
  return cjs.autoUpdater;
}

/** Sürüm notu string ya da sürüm listesi gelebilir; karta tek metin yeter, IPC de şişmesin. */
function notesOf(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes;
  if (!notes) return undefined;
  const text =
    typeof notes === "string"
      ? notes
      : notes
          .map((entry) =>
            entry.version && entry.version !== info.version
              ? `${entry.version}: ${entry.note ?? ""}`
              : (entry.note ?? ""),
          )
          .filter((line) => line.trim().length > 0)
          .join("\n\n");
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

function progress(percent: number, transferred: number, total: number): void {
  set({
    state: "downloading",
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    transferred,
    total,
    message: undefined,
  });
}

/**
 * Otomatik güncelleme: paketli sürümde açılışta hemen, sonra her 15 dakikada bir denetler.
 * Denetim yalnızca birkaç KB'lık manifest isteğidir; 6 saatlik eski aralık yeni sürümü gereksiz
 * geciktiriyordu (indirilen güncelleme zaten ancak çıkışta kurulur). Başarısız denetim (ağ yeni
 * kalkarken DNS hatası gibi) normal aralığı beklemez: 1 → 2 → 5 dakika artan gecikmeyle yeniden
 * denenir; başarılı denetim sayacı sıfırlar.
 * Ayara göre kendiliğinden indirir; indirme bitince renderer karta "Yeniden başlat" düğmesi koyar
 * (`app:installUpdate`). Kullanıcı basmazsa kurulum çıkışta yapılır (`autoInstallOnAppQuit`).
 * Yayın kaynağı electron-builder.yml `publish` (kendi sunucumuz); imzasız derlemede güncelleme
 * macOS tarafından reddedilir, bu yüzden hata yalnızca loglanır.
 */
export function startUpdater(autoDownload: boolean): void {
  if (!app.isPackaged || started) return;
  started = true;
  void updater()
    .then((au) => {
      au.autoDownload = autoDownload;
      au.autoInstallOnAppQuit = true;
      au.logger = null;
      au.on("checking-for-update", () => {
        log.debug("updater", "denetim başladı");
        if (busy()) return;
        set({ state: "checking", message: undefined });
      });
      au.on("update-available", (info) => {
        log.info("updater", `yeni sürüm bulundu: ${info.version} (mevcut ${app.getVersion()})`);
        // İndirme sürerken ya da hazırken gelen bildirim durumu `available`'a geri çekmez.
        if (busy()) return;
        set({
          state: "available",
          version: info.version,
          currentVersion: app.getVersion(),
          releaseNotes: notesOf(info),
          percent: undefined,
          transferred: undefined,
          total: undefined,
          message: undefined,
        });
      });
      au.on("update-not-available", () => {
        log.debug("updater", `güncel: ${app.getVersion()}`);
        if (busy()) return;
        set({
          state: "idle",
          version: app.getVersion(),
          releaseNotes: undefined,
          percent: undefined,
          transferred: undefined,
          total: undefined,
          message: undefined,
        });
      });
      au.on("download-progress", (p: ProgressInfo) => progress(p.percent, p.transferred, p.total));
      au.on("update-downloaded", (info) => {
        log.info("updater", `güncelleme indirildi: ${info.version}`);
        set({
          state: "ready",
          version: info.version,
          releaseNotes: notesOf(info) ?? status.releaseNotes,
          percent: 100,
          message: undefined,
        });
      });
      au.on("error", (error) => {
        // Yayında sürüm/yayın dosyası yoksa sağlayıcı 404 döner; bu bir arıza değil, bilinçli
        // olarak sessiz kalınır ve kullanıcıya hata gösterilmez.
        if (isMissingChannel(error)) {
          log.warn("updater", error.message);
          if (!busy()) set({ state: "idle", version: app.getVersion(), message: undefined });
          return;
        }
        log.error("updater", error);
        // Denetim hatasıyla indirme/kurulum hatası ayrılır: kart yalnız ikincisinde açılır.
        // `busy` iken denetim koşmadığı için buradaki hata indirme/kurulumdandır. `available`
        // durumunda da denetim değil indirme sürüyordur (yeni denetim önce `checking`'e geçer):
        // otomatik indirme ilk ilerleme olayından önce düşerse sürüm bilgisi korunmalı.
        const downloadFailed = busy() || status.state === "available";
        set({
          state: "error",
          message: error.message,
          version: downloadFailed ? status.version : app.getVersion(),
          percent: undefined,
          transferred: undefined,
          total: undefined,
        });
      });
      // İlk denetim hemen yapılır; 15 sn beklemek hızlı açılıp kapanan oturumlarda kontrolü
      // ıskalıyordu. Sonraki denetimler tek zincirde zamanlanır (eşzamanlı iki denetim olmaz).
      let failures = 0;
      async function run(): Promise<void> {
        try {
          // İndirme sürerken ya da güncelleme hazırken denetim atlanır; zincir yine sürer.
          if (!busy()) await au.checkForUpdates();
          failures = 0;
        } catch (error) {
          // Yayınlanmış sürüm yokluğu (404) arıza değil; normal aralıkla denenmeye devam edilir.
          failures = isMissingChannel(error) ? 0 : failures + 1;
        }
        const delay = nextDelayMs(failures);
        if (failures > 0)
          log.debug(
            "updater",
            `denetim başarısız (${failures}. deneme), ${Math.round(delay / 60_000)} dk sonra yeniden denenecek`,
          );
        setTimeout(() => void run(), delay);
      }
      void run();
    })
    .catch((error: unknown) => log.error("updater", error));
}

/** Ayarlar > Hesap > "Güncellemeleri kendiliğinden indir"; kapalıyken indirmeyi kart başlatır. */
export function setAutoDownload(autoDownload: boolean): void {
  if (!app.isPackaged) return;
  void updater()
    .then((au) => {
      au.autoDownload = autoDownload;
    })
    .catch((error: unknown) => log.error("updater", error));
}

/** Kart/Ayarlar düğmesi: bilinen yeni sürümü indirir. Zaten indiriliyorsa ya da indirildiyse yok sayılır. */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status;
  const known = !!status.version && status.version !== app.getVersion();
  if (!known || status.state === "downloading" || status.state === "ready") return status;
  try {
    const au = await updater();
    await au.downloadUpdate();
  } catch (error) {
    log.error("updater", error);
    set({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      percent: undefined,
      transferred: undefined,
      total: undefined,
    });
  }
  return status;
}

let quittingForUpdate = false;

/**
 * Kurulum için kapanış sürüyor mu. `before-quit` normalde kapanışı erteleyip temizliği bekler;
 * `quitAndInstall` yolunda ertelenmez (Squirrel/NSIS kurulumu kapanış akışına bağlı).
 */
export function isQuittingForUpdate(): boolean {
  return quittingForUpdate;
}

/** Kart/Ayarlar düğmesi: indirilmiş güncellemeyi kurar, uygulama kapanıp yeniden açılır. */
export function installUpdate(): void {
  if (!app.isPackaged || status.state !== "ready") return;
  quittingForUpdate = true;
  void updater()
    .then((au) => au.quitAndInstall())
    .catch((error: unknown) => log.error("updater", error));
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  // Elle denetim de indirilen/indirilmekte olan güncellemeyi geriletmesin.
  if (!app.isPackaged || busy()) return status;
  try {
    const au = await updater();
    await au.checkForUpdates();
  } catch (error) {
    if (isMissingChannel(error)) {
      // Sürüm yayınlanmamış olabilir; kullanıcıya hata göstermek yerine "güncel" durumda kal.
      log.warn("updater", error instanceof Error ? error.message : String(error));
      set({ state: "idle", version: app.getVersion(), message: undefined });
    } else {
      log.error("updater", error);
      set({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
        version: app.getVersion(),
        percent: undefined,
        transferred: undefined,
        total: undefined,
      });
    }
  }
  return status;
}

export function updateStatus(): UpdateStatus {
  return status;
}
