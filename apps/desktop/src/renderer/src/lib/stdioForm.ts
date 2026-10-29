/**
 * "Yerel komut" formunun ayrıştırıcıları. Argümanlar tek satırda yazılır (`-y @scope/pkg "a b"`);
 * kabuk çalıştırılmaz, yalnız tırnak ve boşluk kuralı uygulanır. Ortam değişkenleri satır başına
 * `AD=değer` biçimindedir.
 */

/** Tırnaklara (tek/çift) uyarak boşluktan böler; kaçış yalnız çift tırnak içinde `\"`. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

export interface EnvParse {
  env: Record<string, string>;
  /** `=` içermeyen ya da adı geçersiz satırlar (formda uyarı olarak gösterilir). */
  invalid: string[];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `AD=değer` satırları; boş satır ve `#` yorumu atlanır, değer olduğu gibi kalır. */
export function parseEnvLines(text: string): EnvParse {
  const env: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!ENV_KEY.test(key)) {
      invalid.push(line);
      continue;
    }
    env[key] = line.slice(eq + 1);
  }
  return { env, invalid };
}
