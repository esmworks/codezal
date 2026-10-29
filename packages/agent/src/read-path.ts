import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Pi'nin `read` aracının çözdüğü yolu tekrar üretir.
 *
 * Araç yolu düz `resolve()` ile bulmaz: baştaki `@` işaretini atar, `~` genişletir ve dosya
 * bulunamazsa macOS'a özgü yazım denemeleri yapar (NFD ayrıştırması, kıvrık kesme işareti,
 * ekran görüntülerindeki dar boşluklu "AM/PM"). Kancada düz `resolve()` kullanmak Pi'nin başarıyla
 * okuduğu dosyayı "yok" gösteriyordu; uygulamanın kendi `Çıktılar` klasörü buna örnek, macOS adı
 * diskte NFD tutuyor.
 */

const NARROW_NO_BREAK_SPACE = " ";

/** Aynı dosyanın diskte karşılaşılan yazımları; sırayla denenir. */
function variantsOf(path: string): string[] {
  const curly = (p: string) => p.replace(/'/g, "’");
  const nfd = path.normalize("NFD");
  return [
    ...new Set([
      path,
      path.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
      nfd,
      curly(path),
      curly(nfd),
    ]),
  ];
}

/** `@` ve `~` çözülmüş mutlak yol; diskte arama yapmaz. */
export function expandReadPath(raw: string, cwd: string): string {
  const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
  const expanded =
    stripped === "~" || stripped.startsWith("~/")
      ? resolve(homedir(), stripped.slice(2))
      : stripped;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export interface ResolvedReadPath {
  /** Diskte bulunan yazım; bulunamadıysa düz genişletilmiş yol. */
  path: string;
  exists: boolean;
}

export async function resolveReadPath(raw: string, cwd: string): Promise<ResolvedReadPath> {
  const base = expandReadPath(raw, cwd);
  for (const candidate of variantsOf(base)) {
    try {
      await access(candidate);
      return { path: candidate, exists: true };
    } catch {
      // sıradaki yazım denenir
    }
  }
  return { path: base, exists: false };
}
