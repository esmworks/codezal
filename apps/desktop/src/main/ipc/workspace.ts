import { copyFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { app, shell } from "electron";
import { runChecks } from "../checks.js";
import type { AppContext } from "../context.js";
import { saveDialog } from "../context.js";
import { createFile, listDir, readFile, searchFiles, writeFile } from "../files.js";
import * as git from "../git.js";
import { i18n } from "../i18n.js";
import { broadcast, handle } from "../ipc.js";
import { log } from "../log.js";

/** Çalışma alanı kanalları: terminal, dosyalar, git, worktree, commit öncesi kontroller. */
export function registerWorkspaceIpc({ engine: eng, terminals: term, settings }: AppContext): void {
  handle("terminal:create", ({ cwd, cols, rows }) => term.create(cwd, cols, rows));
  handle("terminal:write", ({ id, data }) => term.write(id, data));
  handle("terminal:resize", ({ id, cols, rows }) => term.resize(id, cols, rows));
  handle("terminal:kill", ({ id }) => term.kill(id));
  handle("terminal:list", () => term.list());

  handle("files:list", async ({ root, dir }) => listDir(root, dir, await git.badges(root)));
  handle("files:read", ({ path }) => readFile(path));
  handle("files:search", ({ root, query }) => searchFiles(root, query));
  handle("files:create", ({ path }) => {
    createFile(path);
  });
  handle("files:write", ({ path, content }) => {
    writeFile(path, content);
  });
  handle("files:reveal", ({ path }) => {
    shell.showItemInFolder(path);
  });
  handle("files:openExternal", async ({ path }) => {
    await shell.openPath(path);
  });
  handle("files:exists", ({ paths }) =>
    paths.map((path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false),
  );
  handle("files:saveCopy", async ({ path }, e) => {
    const target = await saveDialog(e, {
      title: i18n.t("dialog.saveAs"),
      defaultPath: join(app.getPath("documents"), basename(path)),
    });
    if (!target) return null;
    copyFileSync(path, target);
    return target;
  });

  handle("git:status", ({ cwd }) => git.status(cwd));
  handle("git:branches", ({ cwd }) => git.branches(cwd));
  handle("git:checkout", async ({ cwd, branch }) => {
    await git.checkout(cwd, branch);
    broadcast("git:changed", { cwd });
  });
  handle("git:discard", async ({ cwd, path }) => {
    await git.discard(cwd, path);
    broadcast("git:changed", { cwd });
  });
  handle("git:commit", async ({ cwd, message, includeUnstaged }) => {
    const r = await git.commit(cwd, message, includeUnstaged);
    broadcast("git:changed", { cwd });
    return r;
  });
  handle("git:push", async ({ cwd }) => {
    await git.push(cwd);
    broadcast("git:changed", { cwd });
  });
  handle("git:diff", ({ cwd, path }) => git.diff(cwd, path));
  handle("git:suggestMessage", async ({ cwd, includeUnstaged, model: requested }) => {
    const st = await git.status(cwd);
    const s = settings();
    const fallback = git.heuristicMessage(st, s.commitFormat);
    const model = requested ?? s.defaultModel;
    if (st.files.length === 0) return { message: fallback, ai: false };
    if (!model) return { message: fallback, ai: false, error: i18n.t("errors.noModel") };
    try {
      const diff = await git.diffForSummary(cwd, includeUnstaged);
      const format =
        s.commitFormat === "conventional"
          ? i18n.t("prompt.commitConventional")
          : s.commitFormat === "short"
            ? i18n.t("prompt.commitShort")
            : i18n.t("prompt.commitFree");
      const text = await eng.complete(
        model,
        `${i18n.t("prompt.commitBase")} ${i18n.t("prompt.commitLang")}`,
        `${format}\n\n${i18n.t("prompt.commitDiff")}\n${diff}`,
      );
      const message = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
      return message
        ? { message, ai: true }
        : { message: fallback, ai: false, error: i18n.t("errors.emptyResponse") };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.warn("git:suggestMessage", error);
      return { message: fallback, ai: false, error };
    }
  });

  handle("worktree:list", ({ cwd }) => git.worktrees(cwd));
  handle("worktree:create", ({ cwd, name }) =>
    git.createWorktree(cwd, settings().worktreeRoot || undefined, name),
  );
  handle("worktree:remove", ({ cwd, path }) =>
    // Dal yalnız Codezal'ın açtığı worktree'de silinir; kullanıcının kendi worktree dalı kalır.
    git.removeWorktree(cwd, path, {
      deleteBranch: git.isManagedWorktree(path, settings().worktreeRoot),
    }),
  );

  handle("checks:run", ({ cwd, commands }) => runChecks(cwd, commands));
}
