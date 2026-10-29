import { isAbsolute, relative, resolve, sep } from "node:path";
import { dict, type Locale } from "@codezal/i18n";
import {
  editedFile,
  FILE_CREATE_TOOLS,
  FILE_EDIT_TOOLS,
  resolveCreatedFile,
} from "./create-tools.js";

/**
 * Asistan çıktı kapısı: `write` (ve `pdf_create`/`docx_create`/`xlsx_create`) çıktı klasörü ve çalışma klasörü dışına yazmak isteyince ilk
 * denemede engellenir ve doğru klasör gerekçe olarak modele iletilir. Aynı yola ikinci deneme
 * bilinçli sayılır ve geçer (kullanıcı açıkça başka bir konum istemiş olabilir).
 */
export function createOutputsGuard(cwd: string, outputsDir: string, lang: Locale = "tr") {
  const warned = new Set<string>();
  const root = resolve(outputsDir);
  const scratch = resolve(cwd);
  // Ayraç ve büyük/küçük harf farkını platforma bırakmak için relative: Windows'ta düz metin
  // karşılaştırması "\" yüzünden kendi çıktı klasörünü bile dışarıda sanıyordu.
  const under = (path: string, dir: string) => {
    const rel = relative(dir, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };

  return (toolName: string, input: Record<string, unknown>): string | undefined => {
    // Yerinde belge düzenlemesi `edit` gibidir (kapı yok); `output` ise yeni dosya üretir.
    const editOutput =
      FILE_EDIT_TOOLS.has(toolName) && typeof input.output === "string" && input.output !== "";
    if (toolName !== "write" && !FILE_CREATE_TOOLS.has(toolName) && !editOutput) return undefined;
    const raw = typeof input.path === "string" ? input.path : "";
    if (!raw) return undefined;
    const path = editOutput
      ? (editedFile(toolName, input, cwd) ?? resolve(cwd, raw))
      : (resolveCreatedFile(toolName, raw, cwd, root) ??
        (isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)));
    if (under(path, root) || under(path, scratch)) return undefined;
    if (warned.has(path)) return undefined;
    warned.add(path);
    const d = dict(lang);
    return d.errors.outsideOutputs.replace("{{dir}}", root);
  };
}
