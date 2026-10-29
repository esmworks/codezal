import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/**
 * Denetim skill paketinin kökü: paketli sürümde `extraResources/audit`, geliştirmede
 * `apps/desktop/resources/audit` (extraResources ile paketlenen tek varlık). Giriş dosyası doğrudan
 * verilerek açıldığında `getAppPath()` bundle klasörüne döner; o zaman yoldan çözülür.
 * Klasör yoksa null döner; denetim yine çalışır, yalnızca avcılar saldırı sınıfı paketini okuyamaz.
 */
export function auditAssetsDir(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "audit");
    return existsSync(packaged) ? packaged : null;
  }
  const candidates = [
    join(app.getAppPath(), "resources", "audit"),
    fileURLToPath(new URL("../../resources/audit", import.meta.url)),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}
