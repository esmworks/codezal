import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shell } from "electron";
import type { AppContext } from "../context.js";
import { i18n } from "../i18n.js";
import { broadcast, handle } from "../ipc.js";
import { renderPdf } from "../pdf.js";

/** Denetim kanalları: durum, başlatma, rapor dışa aktarımı ve run klasörünü açma. */
export function registerAuditIpc({ engine }: AppContext): void {
  handle("audit:state", ({ sessionId }) => engine.auditView(sessionId));

  handle("audit:start", ({ sessionId, options }) => {
    const view = engine.startAudit(sessionId, options);
    broadcast("audit:changed", { sessionId });
    return view;
  });

  handle("audit:export", async ({ sessionId }) => {
    const html = engine.auditReportHtml(sessionId);
    const path = engine.auditPdfPath(sessionId);
    if (!html || !path) throw new Error(i18n.t("prompt.auditNoRun"));
    const bytes = await renderPdf({
      html,
      baseDir: dirname(path),
      pageSize: "A4",
      landscape: false,
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    broadcast("audit:changed", { sessionId });
    return { path };
  });

  handle("audit:reveal", async ({ sessionId }) => {
    const dir = engine.auditRunDir(sessionId);
    if (!dir) throw new Error(i18n.t("prompt.auditNoRun"));
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}
