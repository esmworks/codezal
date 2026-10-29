import { access, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { shell } from "electron";

/**
 * Bağlam kopyalama: kullanıcı bir bağlamı proje klasörüne aldığında kaynak buraya kopyalanır.
 * Kopyalar proje klasöründe durur (`<proje>/Bağlam`), böylece iCloud'daki kaynağa bağımlılık
 * kalmaz; kaldırma kalıcı değildir, çöp kutusuna taşınır.
 */

/** Bu boyutun üstündeki kopya kullanıcı onayı ister. */
export const COPY_CONFIRM_BYTES = 500 * 1024 * 1024;
/** Bu boyutun üstündeki kopya reddedilir; kullanıcı dosyayı elle taşımalı. */
export const COPY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** Dosya ya da klasör ağacının toplam baytı; erişilemeyen girdiler sayılmaz. */
export async function measure(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      // Sembolik bağ izlenmez: döngü ve kopya dışına taşma riski olmasın (`cp` de izlemez).
      if (entry.isSymbolicLink()) continue;
      total += entry.isDirectory() ? await measure(child) : (await stat(child)).size;
    }
    return total;
  } catch {
    // Yarışta silinen dosya vb.: ölçüm kararı sınırlamasın, kopyalama sırasında hata görülür.
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path` gerçekten `dir` altında mı. Kayda geçen kopya yoluna güvenmeden önce doğrulanır:
 * `copy.path` renderer'dan gelen projeyle yazılabildiği için keyfi bir dosya çöpe atılmasın.
 */
export function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  // `..` ile başlayan ama üst dizine çıkmayan adlar meşrudur (`..notes`); yalnız tam `..` ya da
  // `../` öneki dışarı çıkar.
  const escapes = rel === ".." || rel.startsWith(`..${sep}`);
  return rel !== "" && !escapes && !isAbsolute(rel);
}

/** Hedef yol: kaynağın kendi adı; klasörde doluysa `rapor (2).pdf` gibi numaralanır. */
export async function freeTarget(destDir: string, src: string): Promise<string> {
  const name = basename(src) || "Bağlam";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = join(destDir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * Kaynağı bağlam klasörüne kopyalar; oluşturulan hedefin tam yolunu döner.
 *
 * `replace` verilirse hedef o yol olur (yenileme): önce geçici ada kopyalanır ve yalnız kopyalama
 * başarılıysa eski kopya çöpe gider, ardından geçici ad hedefe taşınır. Böylece kaynak artık
 * okunamıyorsa kullanıcının elindeki eski kopya da kaybolmaz.
 */
export async function copyContext(
  src: string,
  contextDir: string,
  replace?: string,
): Promise<string> {
  await mkdir(contextDir, { recursive: true });
  const staging = join(
    contextDir,
    `.kopyalaniyor-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  // dereference:false → sembolik bağlar bağ olarak kopyalanır, ağacın dışına taşınmaz.
  await cp(src, staging, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
  });
  const target = replace ?? (await freeTarget(contextDir, src));
  try {
    if (replace) await trashContext(replace);
    // rename aynı klasör içinde atomiktir; hedef boşsa doğrudan yerleşir.
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

/** Kopyayı çöp kutusuna taşır (kalıcı silme yok); yoksa ya da başarısızsa false. */
export async function trashContext(path: string): Promise<boolean> {
  try {
    await shell.trashItem(path);
    return true;
  } catch {
    return false;
  }
}
