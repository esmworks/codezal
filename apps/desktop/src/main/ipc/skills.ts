import { existsSync, mkdirSync, statSync } from "node:fs";
import { shell } from "electron";
import type { AppContext } from "../context.js";
import { broadcast, handle } from "../ipc.js";

/** Beceri kanalları; her değişiklikten sonra `skills:changed` yayınlanır. */
export function registerSkillsIpc({ engine: eng }: AppContext): void {
  // Kaynak değişikliği açık oturumlara da yansısın: yayın arayüzü, reload oturumları tazeler.
  const changed = () => {
    broadcast("skills:changed", {});
    void eng.reloadLiveSessions();
  };
  const resources = eng.resources;

  handle("skills:list", ({ cwd }) => resources.list(cwd));
  handle("skills:setEnabled", async ({ cwd, path, enabled }) => {
    await resources.setEnabled(cwd, path, enabled);
    changed();
  });
  handle("skills:addSource", async ({ path }) => {
    await resources.addSource(path);
    changed();
  });
  handle("skills:removeSource", async ({ path }) => {
    await resources.removeSource(path);
    changed();
  });
  handle("skills:reveal", async ({ path }) => {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    if (statSync(path).isDirectory()) await shell.openPath(path);
    else shell.showItemInFolder(path);
  });
}
