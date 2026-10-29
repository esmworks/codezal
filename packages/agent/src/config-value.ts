import { spawnSync } from "node:child_process";
import { agentShellRun } from "./shell.js";

/**
 * Kimlik değerlerini dosyada düz tutmak yerine referans saklama: Pi'nin `resolve-config-value`
 * deseni. `!komut` kullanıcının kabuğunda çalışır, `$VAR` / `${VAR}` ortam değişkeninden okunur,
 * `$$` ve `$!` kaçar; diğer her şey literal sayılır. Pi paketi bu modülü dışa açmadığı için
 * (`package.json` `exports` haritası) davranış birebir uyarlanmıştır; testleri kendi paketimizde.
 */

/** Komut zaman aşımı; anahtar çözümü bağlantı akışını kilitlememeli (Pi ile aynı). */
const COMMAND_TIMEOUT_MS = 10_000;

/** Süreç ömrü boyunca komut sonuçları: aynı komut her istekte yeniden koşmaz (Pi paritesi). */
const commandResultCache = new Map<string, string | undefined>();

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };
type ConfigValueReference =
  | { type: "command"; config: string }
  | { type: "template"; parts: TemplatePart[] };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") {
    previous.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }

    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];

    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }

    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }

    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }

  return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
  if (config.startsWith("!")) return { type: "command", config };
  return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
  return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.type !== "env" || names.includes(part.name)) continue;
    names.push(part.name);
  }
  return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const envValue = resolveEnvConfigValue(part.name, env);
    if (envValue === undefined) return undefined;
    resolved += envValue;
  }
  return resolved;
}

/** Değerdeki ortam değişkeni adları; komut referansında boş dizi. */
export function getConfigValueEnvVarNames(config: string): string[] {
  const reference = parseConfigValueReference(config);
  return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

/** Tanımlı olmayan ortam değişkeni adları; görünürlük uyarısı bununla üretilir. */
export function getMissingConfigValueEnvVarNames(
  config: string,
  env?: Record<string, string>,
): string[] {
  return getConfigValueEnvVarNames(config).filter(
    (name) => resolveEnvConfigValue(name, env) === undefined,
  );
}

/** `!` ile başlayan değer kabuk komutudur. */
export function isCommandConfigValue(config: string): boolean {
  return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
  return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Komutu kullanıcının kabuğunda koşturur; hata, zaman aşımı ve boş çıktı `undefined` döner.
 * `agentShellRun` Windows'ta Git Bash → PowerShell düşüşünü ve UTF-8 sarmasını zaten yönetir.
 */
function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  try {
    const run = agentShellRun(command);
    const usesStdin = run.stdin !== undefined;
    const result = spawnSync(run.shell, run.args, {
      encoding: "utf-8",
      input: run.stdin,
      timeout: COMMAND_TIMEOUT_MS,
      stdio: [usesStdin ? "pipe" : "ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return undefined;
    return (result.stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommand(commandConfig: string): string | undefined {
  if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
  const result = executeCommandUncached(commandConfig);
  commandResultCache.set(commandConfig, result);
  return result;
}

/**
 * Değeri çözümler: `!komut` (önbellekli), `$VAR` / `${VAR}` ortam değişkeni, `$$` / `$!` kaçışı,
 * aksi hâlde literal. Çözülemeyen referans `undefined` döner (Pi paritesi).
 */
export function resolveConfigValue(
  config: string,
  env?: Record<string, string>,
): string | undefined {
  const reference = parseConfigValueReference(config);
  return reference.type === "command"
    ? executeCommand(reference.config)
    : resolveTemplate(reference.parts, env);
}

/** Önbelleksiz çözümleme: komut her çağrıda yeniden koşar (Pi paritesi). */
export function resolveConfigValueUncached(
  config: string,
  env?: Record<string, string>,
): string | undefined {
  const reference = parseConfigValueReference(config);
  return reference.type === "command"
    ? executeCommandUncached(reference.config)
    : resolveTemplate(reference.parts, env);
}

/** Testler için komut önbelleğini temizler. */
export function clearConfigValueCache(): void {
  commandResultCache.clear();
}
