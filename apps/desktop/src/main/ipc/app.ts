import { PI_VERSION } from "@codezal/agent";
import { app, shell } from "electron";
import type { AppContext } from "../context.js";
import { windowOf } from "../context.js";
import { broadcast, handle } from "../ipc.js";
import { log } from "../log.js";
import { perf } from "../perf.js";
import { checkForUpdates, downloadUpdate, installUpdate, updateStatus } from "../updater.js";

/** Uygulama ve pencere kanalları: sürüm, yollar, günlük, güncelleme, pencere komutları. */
export function registerAppIpc(ctx: AppContext): void {
  handle("app:paths", () => ctx.paths);
  handle("app:version", () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? "",
    pi: PI_VERSION,
  }));
  handle("app:openLogs", async () => {
    const path = log.path();
    if (path) await shell.openPath(path);
  });
  handle("app:openAgentEvents", async () => {
    await shell.openPath(ctx.paths.agentEventsDir);
  });
  handle("app:logTail", ({ lines, level }) => ({ lines: log.tail(lines, level) }));
  // Canlı akış yalnızca izleyen pencere varken yayınlanır: satır başına IPC maliyeti boşa gitmesin.
  const watchers = new Set<number>();
  let unsubscribe: (() => void) | undefined;
  handle("app:logWatch", ({ on }, e) => {
    const id = e.sender.id;
    if (!on) {
      watchers.delete(id);
    } else if (!watchers.has(id)) {
      watchers.add(id);
      e.sender.once("destroyed", () => watchers.delete(id));
      unsubscribe ??= log.subscribe((line) => {
        if (watchers.size > 0) broadcast("app:log", line);
      });
    }
    if (watchers.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  });
  // PRD 11 ölçümleri yalnız yerelde tutulur; renderer bildirir, Tanılama sayfası özetini okur.
  handle("perf:record", (req) => {
    if (req.metric === "firstRender") perf.recordFirstRender(req.at);
    else perf.record("toolCard", req.ms);
  });
  handle("perf:summary", () => perf.summary(app.isPackaged));
  handle("app:logError", ({ scope, message }) => {
    log.error(scope, message);
  });
  handle("app:checkUpdates", () => checkForUpdates());
  handle("app:updateStatus", () => updateStatus());
  handle("app:downloadUpdate", () => downloadUpdate());
  handle("app:installUpdate", () => installUpdate());

  handle("window:close", (_p, e) => {
    windowOf(e)?.close();
  });
  handle("window:minimize", (_p, e) => {
    windowOf(e)?.minimize();
  });
  handle("window:toggleMaximize", (_p, e) => {
    const win = windowOf(e);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  handle("window:state", (_p, e) => {
    const win = windowOf(e);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
}
