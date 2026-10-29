import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AppSettings } from "@codezal/contracts";
import { app, Notification, shell } from "electron";
import type { AppContext } from "../context.js";
import { openDialog, saveDialog } from "../context.js";
import { ensureHooksFile, loadHooks } from "../hooks.js";
import { i18n } from "../i18n.js";
import { handle } from "../ipc.js";
import { log, verboseFromEnv } from "../log.js";
import { installMenu } from "../menu.js";
import { contextFilePath, ensureConfigFile } from "../project-local.js";
import { applyLoginItem, applyTray, setKeepAwake } from "../system.js";
import { setAutoDownload } from "../updater.js";
import { isDarkTheme, setThemeDark } from "../window.js";

/** Vekil ve zaman aşımı ayarları Pi'nin kullandığı ortam değişkenlerine yansır. */
export function applyNetwork(s: AppSettings): void {
  if (s.proxy && s.proxyUrl.trim()) {
    process.env.HTTPS_PROXY = s.proxyUrl.trim();
    process.env.HTTP_PROXY = s.proxyUrl.trim();
  } else {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
  }
  // Atlama listesi vekilden bağımsız yazılır; vekil kapalıyken zararsızdır.
  const noProxy = s.noProxy.trim();
  if (noProxy) {
    process.env.NO_PROXY = noProxy;
    process.env.no_proxy = noProxy;
  } else {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
  // Node kök sertifikaları ilk TLS bağlantısında bir kez okur; değişiklik yeniden başlatınca geçer.
  const cert = s.caCertPath.trim();
  if (cert) process.env.NODE_EXTRA_CA_CERTS = cert;
  else delete process.env.NODE_EXTRA_CA_CERTS;
  process.env.PI_REQUEST_TIMEOUT_MS = String(Number(s.timeoutSec) * 1000);
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Ayarlar, kullanım, dosya seçme diyalogları ve bildirim kanalları. */
export function registerSettingsIpc({
  paths,
  engine: eng,
  stores,
  settings,
  projects,
  agentTrace,
}: AppContext): void {
  handle("settings:get", () => settings());
  handle("settings:set", (patch) => {
    let next = stores.settings.update(patch);
    applyNetwork(next);
    // Dil değişince ana süreç metinleri (menü, diyaloglar, menü çubuğu) güncellenir.
    if (next.language !== i18n.language) {
      void i18n.changeLanguage(next.language);
      installMenu(next.language, next.keybindings);
    } else if (patch.keybindings !== undefined) {
      // Yalnız kısayol değiştiyse menüyü tazele (dil aynı kaldı).
      installMenu(next.language, next.keybindings);
    }
    if (patch.menubar !== undefined || patch.language !== undefined)
      applyTray(next.menubar, next.language);
    if (patch.theme !== undefined) setThemeDark(isDarkTheme(next.theme));
    if (patch.keepAwake !== undefined) setKeepAwake(next.keepAwake);
    if (patch.autoUpdate !== undefined) setAutoDownload(next.autoUpdate);
    // Günlük/iz anahtarları çalışma anında uygulanır: yeniden başlatma istemeyiz.
    if (patch.verboseLog !== undefined) log.setVerbose(next.verboseLog || verboseFromEnv());
    if (patch.agentTraceLog !== undefined) agentTrace.setEnabled(next.agentTraceLog);
    // Danışman aracı uzantı fabrikasında kaydedilir; açık oturumlar tazelenince eklenir/düşer.
    if (patch.advisorModel !== undefined) void eng.reloadLiveSessions();
    if (patch.startup !== undefined) {
      // Sistem kaydı reddederse anahtar açık görünmesin.
      const effective = applyLoginItem(next.startup);
      if (effective !== next.startup) next = stores.settings.update({ startup: effective });
    }
    return next;
  });
  // Kısayol kaydı sırasında menü hızlandırıcıları askıya alınır; yoksa mevcut kısayol
  // (ör. ⌘K) tuş renderer'a ulaşmadan menü komutunu tetikler.
  handle("shortcuts:suspend", ({ suspended }) => {
    const current = stores.settings.get();
    installMenu(current.language, current.keybindings, suspended);
  });
  // Ayarlar'daki salt okunur liste: motorun kullandığı aynı yükleyici, aynı güven kapısı.
  handle("hooks:list", ({ cwd }) =>
    loadHooks(paths.userData, cwd, cwd ? projects.isTrusted(cwd) : false),
  );
  handle("settings:openFile", async ({ which, cwd }) => {
    if (which === "hooks") {
      await shell.openPath(ensureHooksFile(paths.userData));
      return;
    }
    if (which === "projectConfig" || which === "projectConfigLocal") {
      if (!cwd) throw new Error(i18n.t("errors.noProject"));
      const path = ensureConfigFile(cwd, which === "projectConfigLocal");
      // Dosyayı kullanıcı kendisi açtı: proje-yerel ayarlar artık güvenilir.
      projects.setTrusted(cwd, true);
      await shell.openPath(path);
      return;
    }
    let path: string;
    if (which === "models") path = join(paths.agentDir, "models.json");
    else if (which === "auth") path = join(paths.agentDir, "keys.json");
    // Proje talimatı: CODEZAL.md ya da AGENTS.md; hangisi varsa o açılır.
    else path = contextFilePath(cwd ?? homedir());
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const seed =
        which === "models"
          ? JSON.stringify({ providers: {} }, null, 2)
          : which === "project"
            ? i18n.t("prompt.codezalSeed")
            : JSON.stringify({ version: 1, providers: {} }, null, 2);
      writeFileSync(path, seed, "utf8");
    }
    await shell.openPath(path);
  });
  handle("files:pickImages", async (_p, e) => {
    const files = await openDialog(e, {
      title: i18n.t("dialog.pickImage"),
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: i18n.t("dialog.images"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    });
    return files.slice(0, 10).flatMap((p) => {
      const mimeType = MIME[extname(p).toLowerCase()];
      if (!mimeType) return [];
      return [{ mimeType, data: readFileSync(p).toString("base64"), name: basename(p) }];
    });
  });
  handle("files:pickFiles", ({ title }, e) =>
    openDialog(e, { title, properties: ["openFile", "multiSelections"] }),
  );
  handle("settings:pickFolder", async ({ title }, e) => {
    const [dir] = await openDialog(e, { properties: ["openDirectory", "createDirectory"], title });
    return dir ?? null;
  });
  handle("settings:exportData", async (_p, e) => {
    const path = await saveDialog(e, {
      title: i18n.t("dialog.exportData"),
      defaultPath: join(app.getPath("documents"), "codezal-verileri.json"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return null;
    const sessions = await eng.listSessions();
    writeFileSync(
      path,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          settings: settings(),
          usage: stores.usageEntries(),
          schedule: stores.tasks(),
          assistantProjects: stores.projects(),
          sessions: sessions.map((s) => ({ ...s, live: undefined })),
        },
        null,
        2,
      ),
    );
    return path;
  });

  handle("usage:list", () => stores.usageEntries());

  // Brave anahtarı main'de kalır; renderer'a yalnız bağlı olup olmadığı döner.
  handle("search:braveKey", () => ({ connected: eng.hasBraveKey() }));
  handle("search:setBraveKey", async ({ apiKey }) => {
    await eng.setBraveKey(apiKey);
    return { connected: eng.hasBraveKey() };
  });
  handle("search:clearBraveKey", async () => {
    await eng.clearBraveKey();
    return { connected: eng.hasBraveKey() };
  });

  handle("notify", ({ title, body }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
}
