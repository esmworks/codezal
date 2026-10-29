import { DOCX_TOOL, resolveDocxPath } from "./docx-create.js";
import { resolveDocxEditTarget } from "./docx-edit.js";
import { DOCX_EDIT_TOOL } from "./docx-edit-tool.js";
import { PDF_TOOL, resolvePdfPath } from "./pdf-create.js";
import { resolvePdfEditTargets } from "./pdf-edit.js";
import { PDF_EDIT_TOOL } from "./pdf-edit-tool.js";
import { resolveXlsxPath, XLSX_TOOL } from "./xlsx-create.js";
import { resolveXlsxEditTarget } from "./xlsx-edit.js";
import { XLSX_EDIT_TOOL } from "./xlsx-edit-tool.js";

/**
 * Dosya üreten araçlar (`pdf_create`, `docx_create`, `xlsx_create`): göreli adı Asistan'da çıktı
 * klasörüne, diğer modlarda cwd'ye yazar ve uzantı ekler. İzin, çıktı kapısı ve tur yedeği aynı
 * yolu çözmeli; yeni bir üretim aracı buraya eklenince üçü birden onu tanır.
 */
export const FILE_CREATE_TOOLS: ReadonlySet<string> = new Set([PDF_TOOL, DOCX_TOOL, XLSX_TOOL]);

export function resolveCreatedFile(
  tool: string,
  raw: string,
  cwd: string,
  outputsDir?: string,
): string | undefined {
  if (tool === PDF_TOOL) return resolvePdfPath(raw, cwd, outputsDir);
  if (tool === DOCX_TOOL) return resolveDocxPath(raw, cwd, outputsDir);
  if (tool === XLSX_TOOL) return resolveXlsxPath(raw, cwd, outputsDir);
  return undefined;
}

/**
 * Var olan belgeyi düzenleyen araçlar (`docx_edit`, `xlsx_edit`, `pdf_edit`): `path` kaynaktır,
 * `output` verilince sonuç kaynağın klasörüne göre başka dosyaya yazılır. İzin kapısı, tur yedeği
 * ve çıktı kapısı yazılan yolu `editedFile`'dan alır. `pdf_edit` girdiyi örtük olarak değiştirmez:
 * `output` yoksa kaynağın yanında ekli yeni bir ad seçer.
 */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  DOCX_EDIT_TOOL,
  XLSX_EDIT_TOOL,
  PDF_EDIT_TOOL,
]);

/** Düzenleme aracının yazdığı dosya: `output` verilince o, yoksa kaynağın kendisi. */
export function editedFile(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const path = typeof input.path === "string" && input.path ? input.path : undefined;
  if (!path) return undefined;
  const output = typeof input.output === "string" ? input.output : undefined;
  if (tool === DOCX_EDIT_TOOL) return resolveDocxEditTarget(path, output, cwd).target;
  if (tool === XLSX_EDIT_TOOL) return resolveXlsxEditTarget(path, output, cwd).target;
  if (tool === PDF_EDIT_TOOL) {
    // Yalnız okuyan `list_fields` dosya yazmaz; kapı o zaman kaynağa bakar.
    const { source, targets } = resolvePdfEditTargets({ ...input, path }, cwd);
    return targets[0] ?? source;
  }
  return undefined;
}

/**
 * Düzenleme aracının yazacağı bütün dosyalar (tur yedeği için): `pdf_edit` `split`'te birden çok
 * parça yazar, `list_fields`'ta hiç yazmaz. Diğer araçlarda `editedFile` ile aynı tek yol.
 */
export function editedFiles(tool: string, input: Record<string, unknown>, cwd: string): string[] {
  const path = typeof input.path === "string" && input.path ? input.path : undefined;
  if (!path) return [];
  if (tool === PDF_EDIT_TOOL) return resolvePdfEditTargets({ ...input, path }, cwd).targets;
  const one = editedFile(tool, input, cwd);
  return one ? [one] : [];
}
