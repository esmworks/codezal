import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HookEvent, HooksConfig, type ResolvedHook } from "@codezal/contracts";
import { log } from "./log.js";
import { configPath } from "./project-local.js";

/** Genel hook dosyası (userData altında; kişisel, hiçbir projeye bağlı değil). */
export const HOOKS_FILE = "hooks.json";

export function hooksFilePath(userData: string): string {
  return join(userData, HOOKS_FILE);
}

/** Dosya yoksa boş bir şablonla oluşturur ("Aç" düğmesi boş dosya yerine iskelet göstersin). */
export function ensureHooksFile(userData: string): string {
  const path = hooksFilePath(userData);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ PreToolUse: [], PostToolUse: [] }, null, 2)}\n`);
  }
  return path;
}

/**
 * Liste her araç çağrısında okunur; bozuk dosya her çağrıda günlüğe yazılırsa günlük şişer.
 * Aynı uyarı süreç ömrü boyunca bir kez yazılır (dosya değişip yeni hata çıkarsa yeni satır).
 */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.warn("hooks", message);
}

function flatten(config: HooksConfig, source: string): ResolvedHook[] {
  return HookEvent.options.flatMap((event) =>
    (config[event] ?? []).map((hook) => ({ ...hook, event, source })),
  );
}

/**
 * Bir dosyadaki hook'lar. `hooks.json` kökü doğrudan `HooksConfig`tir; proje ayarlarında `hooks`
 * alanının altındadır. Bozuk dosya ya da şema günlüğe düşer ve atlanır: hatalı bir hook dosyası
 * ajanın bütün araçlarını durdurmamalı.
 */
function readHooks(path: string, nested: boolean): ResolvedHook[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    let value = raw;
    if (nested) {
      value =
        typeof raw === "object" && raw !== null ? (raw as { hooks?: unknown }).hooks : undefined;
    }
    if (value === undefined) return [];
    const parsed = HooksConfig.safeParse(value);
    if (!parsed.success) {
      warnOnce(`${path}: ${parsed.error.message}`);
      return [];
    }
    return flatten(parsed.data, path);
  } catch (error) {
    warnOnce(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Etkin hook'lar: önce genel `hooks.json`, sonra güvenilen projede `ayarlar.json` ve
 * `ayarlar.local.json` (iki proje dosyası **birleşir**; `readProjectConfig`'teki gibi yerel olan
 * ekibinkini ezmez — ekip kuralı kişisel dosyayla sessizce kapanmasın). Güvenilmeyen projenin
 * hook'u okunmaz: klonlanan bir depo kullanıcının makinesinde sorulmadan komut çalıştıramaz.
 */
export function loadHooks(
  userData: string,
  cwd: string | undefined,
  trusted: boolean,
): ResolvedHook[] {
  const hooks = readHooks(hooksFilePath(userData), false);
  if (!cwd || !trusted) return hooks;
  return [
    ...hooks,
    ...readHooks(configPath(cwd, false), true),
    ...readHooks(configPath(cwd, true), true),
  ];
}
