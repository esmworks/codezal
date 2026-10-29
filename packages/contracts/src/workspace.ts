import { z } from "zod";

/** Çalışma alanı sözleşmeleri: terminal, dosyalar, git, worktree (PRD 2. aşama). */

export const TerminalInfo = z.object({
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const FileBadge = z.enum(["A", "M", "D", "R", "?"]);
export type FileBadge = z.infer<typeof FileBadge>;

export const FileNode = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  badge: FileBadge.optional(),
  /** Son değişim (ms); Çıktılar kutusu görev başlangıcından sonraki dosyaları bununla seçer. */
  modifiedAt: z.number().optional(),
});
export type FileNode = z.infer<typeof FileNode>;

export const FileContent = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  binary: z.boolean(),
  /**
   * Önizlemesi Markdown'a çevrilen ikili belge (Word): izli değişiklik ve yorumlar CriticMarkup
   * ile. Dönüştürülemeyen ya da çok büyük belgede yoktur; görüntüleyici "Uygulamada aç"a düşer.
   */
  markdown: z.string().optional(),
});
export type FileContent = z.infer<typeof FileContent>;

export const GitFileChange = z.object({
  path: z.string(),
  status: FileBadge,
  /** Yeniden adlandırmada eski yol; diğer durumlarda null. */
  renamedFrom: z.string().nullable().default(null),
  staged: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

export const GitStatus = z.object({
  isRepo: z.boolean(),
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  hasRemote: z.boolean(),
  files: z.array(GitFileChange),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type GitStatus = z.infer<typeof GitStatus>;

export const GitBranch = z.object({ name: z.string(), current: z.boolean() });
export type GitBranch = z.infer<typeof GitBranch>;

export const WorktreeInfo = z.object({
  path: z.string(),
  branch: z.string(),
  name: z.string(),
  isMain: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  createdAt: z.number().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfo>;

export const CheckResult = z.object({
  command: z.string(),
  ok: z.boolean(),
  code: z.number().int(),
  output: z.string(),
  durationMs: z.number().nonnegative(),
});
export type CheckResult = z.infer<typeof CheckResult>;
