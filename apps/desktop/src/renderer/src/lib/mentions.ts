import { isAbsolutePath, joinPath } from "@codezal/contracts";

/**
 * Yanıt metninde satır içi kod olarak geçen dosya yolları (`Çıktılar/proje.pdf`, `src/a.ts`)
 * tıklanınca açılır. Kod çipi başka her şey için de kullanıldığından (komut, değişken, sürüm)
 * seçim tutucudur: yanlış pozitif, sahte bir "Dosyayı aç" düğmesi demektir.
 */

/** Klasörsüz tek ad yalnızca belge uzantısıyla ya da konuşmada bilinen bir dosyaysa yol sayılır. */
const DOC_EXT =
  /\.(md|markdown|txt|pdf|csv|tsv|json|html?|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|dxf|dwg|zip)$/i;
const EXT = /\.[a-z0-9]{1,5}$/i;

/**
 * Alan adı biçimli ilk parça: `electronjs.org/blog/electron-44-0` gibi şemasız adresler yol
 * sayılmasın. Şema (`https://`) zaten yukarıda eleniyor; şemasız yazılan adres son parçası
 * noktalı olduğunda (`…/release/v44.0.0`) yol sanılıyordu ve kullanıcı tıklayınca olmayan bir
 * yerel dosya açılmaya çalışılıyordu. Ölçüt yalnız **ilk** parça: `packages/ui/src/a.css` gibi
 * gerçek yolların ilk parçasında nokta olmaz; `desktop.v2/...` gibi ara klasör adları da son
 * parçası harf olmadığı için bu kalıba girmez.
 */
const HOST_SEGMENT =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

function strip(text: string): string {
  // `dosya.ts:12:4` satır/sütun ekleri ve "./" öneki atılır.
  return text.replace(/(:\d+){1,2}$/, "").replace(/^\.\//, "");
}

function baseOf(text: string): string {
  return text.split(/[\\/]/).pop() ?? "";
}

/** İlk parça (`/` ya da `\` öncesi) alan adı gibi mi. */
function startsWithHost(text: string): boolean {
  const first = text.split(/[\\/]/)[0] ?? "";
  return HOST_SEGMENT.test(first);
}

export function looksLikePath(text: string, known: readonly string[] = []): boolean {
  const t = strip(text);
  if (t.length === 0 || t.length > 260) return false;
  if (/\s/.test(t) || /[<>|"'`*=(){}$]/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("-")) return false;
  const base = baseOf(t);
  if (!EXT.test(base) || base.startsWith(".")) return false;
  if (/[\\/]/.test(t)) return !startsWithHost(t);
  if (DOC_EXT.test(base)) return true;
  return known.some((k) => baseOf(k) === base);
}

/**
 * Bahsedilen yolu mutlak yola çevirir. Öncelik: konuşmada geçen (yazılan, okunan, listelenen)
 * dosyalardan sonu uyan; sonra sırayla verilen köklere ekleme. Varlık burada denetlenmez,
 * görüntüleyici okuyamazsa kendisi söyler.
 */
export function resolveMention(
  text: string,
  { home, known, roots }: { home: string; known: readonly string[]; roots: readonly string[] },
): string {
  const t = strip(text);
  if (isAbsolutePath(t)) return t;
  if (t.startsWith("~/") && home) return joinPath(home, t.slice(2));
  const suffix = `/${t.replace(/\\/g, "/")}`;
  const hit = known.find((k) => k.replace(/\\/g, "/").endsWith(suffix));
  if (hit) return hit;
  const root = roots.find((r) => r.length > 0) ?? "";
  return root ? joinPath(root, t) : t;
}
