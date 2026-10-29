import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectRef } from "@codezal/contracts";
import { app, dialog, type IpcMainInvokeEvent } from "electron";
import type { AppContext } from "../context.js";
import { openDialog, saveDialog, windowOf } from "../context.js";
import * as git from "../git.js";
import { i18n } from "../i18n.js";
import { broadcast, handle } from "../ipc.js";
import { log } from "../log.js";
import { hasLocalConfig, readProjectConfig, savePlanToProject } from "../project-local.js";
import { openInTerminal } from "../shell.js";
import { sessionGone } from "../system.js";
import { forgetTurnSnapshot, rewindTurnSnapshots, undoTurn } from "../turn-backup.js";

/** Proje ve oturum kanalları; izin yanıtı da burada. */
export function registerSessionsIpc({
  agentTrace,
  engine: eng,
  projects,
  paths,
  recentAgentEvents,
  settings,
}: AppContext): void {
  /**
   * "Bitince temizle": silinen oturumların worktree'si, başka oturum (arşivdekiler dahil)
   * kullanmıyorsa ve kaybolacak iş yoksa kaldırılır (bkz. `git.cleanupWorktree`).
   */
  const cleanWorktrees = async (cwds: Iterable<string>): Promise<void> => {
    const { worktreeClean, worktreeRoot } = settings();
    if (!worktreeClean) return;
    const managed = [...new Set(cwds)].filter((cwd) => git.isManagedWorktree(cwd, worktreeRoot));
    if (managed.length === 0) return;
    const inUse = new Set((await eng.listSessions()).map((s) => s.cwd));
    for (const cwd of managed) {
      if (inUse.has(cwd)) continue;
      if (await git.cleanupWorktree(cwd, worktreeRoot)) log.info("worktree", `kaldırıldı: ${cwd}`);
    }
  };
  const cleanLater = (cwds: Iterable<string>): void => {
    // Silme yanıtı temizliği beklemez; git işlemi birkaç yüz ms sürebilir.
    void cleanWorktrees(cwds).catch((e) => log.warn("worktree", String(e)));
  };

  /** Güven sorusu: proje-yerel ayar var ve daha önce sorulmadıysa bir kez sorulur. */
  const askTrust = async (ref: ProjectRef, e: IpcMainInvokeEvent): Promise<ProjectRef> => {
    if (ref.trusted !== undefined || !hasLocalConfig(ref.path)) return ref;
    const options: Electron.MessageBoxOptions = {
      type: "question",
      title: i18n.t("dialog.trustTitle"),
      message: i18n.t("dialog.trustMessage", { name: ref.name }),
      detail: i18n.t("dialog.trustDetail"),
      buttons: [i18n.t("dialog.trustYes"), i18n.t("dialog.trustNo")],
      defaultId: 0,
      cancelId: 1,
    };
    const win = windowOf(e);
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return projects.setTrusted(ref.path, response === 0) ?? ref;
  };

  /**
   * Klasör açılışı: taşınmış proje tespiti (parmak izi eşleşen, yolu kaybolmuş kayıt), son
   * kullanılanlar ve güven sorusu. Taşımada oturum, bellek ve plan klasörleri yeni slug'a geçer.
   */
  const openProject = async (path: string, e: IpcMainInvokeEvent): Promise<ProjectRef> => {
    const fingerprint = await git.rootCommit(path);
    const moved =
      fingerprint && !projects.get(path) ? projects.findMoved(fingerprint, path) : undefined;
    if (moved) {
      const { sessions } = eng.relocateProject(moved.path, path);
      projects.relocate(moved.path, path);
      log.info("project:open", `taşındı: ${moved.path} → ${path} (${sessions} oturum)`);
    }
    return askTrust(projects.touch(path, fingerprint), e);
  };

  handle("project:pickFolder", async (_p, e) => {
    const [path] = await openDialog(e, {
      properties: ["openDirectory", "createDirectory"],
      title: i18n.t("dialog.pickProject"),
    });
    return path ? openProject(path, e) : null;
  });
  handle("project:open", ({ path }, e) => openProject(path, e));
  handle("project:setTrusted", ({ path, trusted }) => {
    projects.touch(path);
    return projects.setTrusted(path, trusted) ?? projects.touch(path);
  });
  handle("project:config", ({ cwd }) => (projects.isTrusted(cwd) ? readProjectConfig(cwd) : {}));
  handle("plans:saveToProject", ({ path, cwd }) => {
    const target = savePlanToProject(cwd, path, paths.plansDir);
    // Kullanıcı `.codezal/` klasörünü kendi eliyle açtı: proje güvenilir; git görünümü yenilensin.
    projects.setTrusted(cwd, true);
    broadcast("git:changed", { cwd });
    return target;
  });
  handle("project:recent", () => projects.recent());
  handle("project:forget", ({ path }) => {
    projects.forget(path);
  });
  handle("project:reorder", ({ paths }) => projects.reorder(paths));
  handle("project:openTerminal", ({ path }) => openInTerminal(path));

  handle("sessions:list", ({ cwd }) => eng.listSessions(cwd));
  handle("sessions:search", ({ query, ids }) => eng.searchSessions(ids, query));
  handle("sessions:create", async (options) => {
    if (options.mode === "kodlama") projects.touch(options.cwd);
    // Asistan çalışma klasörü (userData/asistan/<proje>) ilk görevde oluşturulur; yoksa bash çalışmaz.
    if (options.mode === "asistan") mkdirSync(options.cwd, { recursive: true });
    return eng.createSession(options);
  });
  // Snapshot + kaçırılan olaylar tek yanıtta: renderer sırayı seq ile uzlaştırır, çift kayıt oluşmaz.
  handle("sessions:open", async ({ id }) => {
    const opened = await eng.openSession(id);
    const buffered = recentAgentEvents.get(id) ?? [];
    return {
      ...opened,
      // Yalnızca snapshot'ın kapsamadığı olaylar telafi edilir; seq filtresi renderer'da da savunma katmanıdır.
      buffered: buffered.filter((event) => event.seq > opened.lastSeq),
    };
  });
  handle("sessions:prompt", ({ id, text, images }) => eng.prompt(id, text, images));
  handle("sessions:steer", ({ id, text, images }) => eng.steer(id, text, images));
  handle("sessions:compact", ({ id }) => eng.compactNow(id));
  handle("sessions:followUp", ({ id, text, images }) => eng.followUp(id, text, images));
  handle("sessions:clearQueue", ({ id }) => {
    eng.clearQueue(id);
  });
  handle("sessions:abort", ({ id }) => eng.abort(id));
  handle("sessions:goal", ({ id, action, text, maxIter }) => eng.goal(id, action, text, maxIter));
  handle("sessions:setModel", ({ id, model }) => eng.setModel(id, model));
  handle("sessions:setThinking", ({ id, thinking }) => eng.setThinking(id, thinking));
  handle("sessions:setPermission", ({ id, permission }) => eng.setPermission(id, permission));
  handle("sessions:rename", ({ id, name }) => eng.rename(id, name));
  handle("sessions:regenerateTitle", async ({ id }) => ({ name: await eng.regenerateTitle(id) }));
  handle("sessions:delete", async ({ id }) => {
    // Oturum silinince izi, tur kaydı ve olay tamponu da gider; sahipsiz dosya ya da bellek kalmaz.
    // Tampon düşmezse her oturum kimliği 500 olayla (araç çıktıları dahil) süreç ömrü boyunca
    // bellekte kalıyordu.
    agentTrace.remove(id);
    forgetTurnSnapshot(id);
    recentAgentEvents.delete(id);
    // Tur sürerken silinen oturumun `run_end`'i gelmeyebilir; uyanık tutma sayacı takılı kalmasın.
    sessionGone(id);
    // Oturumun klasörü silmeden önce okunur; silindikten sonra listede yer almaz.
    const cwd = settings().worktreeClean
      ? (eng.cwdOf(id) ?? (await eng.listSessions()).find((s) => s.id === id)?.cwd)
      : undefined;
    await eng.deleteSession(id);
    if (cwd) cleanLater([cwd]);
  });
  handle("sessions:setPinned", ({ id, pinned }) => eng.setPinned(id, pinned));
  handle("sessions:setArchived", ({ id, archived }) => eng.setArchived(id, archived));
  handle("sessions:purgeArchived", async () => {
    // Arşivden kalıcı silme de oturum silme yolundan geçer: iz, tur kaydı ve olay tamponu bırakılır.
    const cwds: string[] = [];
    for (const s of await eng.listSessions()) {
      if (!s.archived) continue;
      agentTrace.remove(s.id);
      forgetTurnSnapshot(s.id);
      recentAgentEvents.delete(s.id);
      sessionGone(s.id);
      cwds.push(s.cwd);
    }
    const purged = await eng.purgeArchived();
    cleanLater(cwds);
    return purged;
  });
  handle("sessions:fork", ({ id, assistantOrdinal, userOrdinal }) =>
    eng.forkSession(id, assistantOrdinal, userOrdinal),
  );
  handle("sessions:side", ({ id }) => eng.openSideChat(id));
  handle("sessions:promoteSide", ({ id }) => eng.promoteSideChat(id));
  handle("sessions:rewind", async ({ id, userOrdinal }) => {
    const result = await eng.rewindSession(id, userOrdinal);
    // Dal bu noktaya kesildi: sonraki turların dosya kayıtları da düşer, yoksa "Geri al"
    // silinmiş bir turun kaydına düşer (bkz. `rewindTurnSnapshots`).
    rewindTurnSnapshots(id, userOrdinal);
    return result;
  });
  handle("sessions:undoFiles", async ({ id, userOrdinal }) => {
    const cwd = eng.cwdOf(id);
    if (cwd) {
      // Git deposu varsa tur geneli geri alma (terminal değişiklikleri dahil) önce denenir;
      // kayıt yoksa ya da depo değilse dosya bazlı yedeklere düşülür. Sıra numarası turun
      // kendisini seçer: eskiden kayıt oturum başına tekti ve her turda üzerine yazıldığı için
      // eski bir turu geri almak son turun çalışmasını siliyordu.
      const full = await undoTurn(id, cwd, userOrdinal);
      if (full.restored.length > 0 || full.removed.length > 0) {
        // Git'in kapsamadığı değişiklikler motorun dosya yedeğinden tamamlanır: tur mühürlendikten
        // sonra yazan arka plan alt ajanı, `.gitignore`'daki dosyaya yazma araçlarıyla yapılan
        // değişiklik. Git'in döndürdüğü yollara dokunulmaz (iki kaynak aynı dosyayı yazmasın).
        const handled = new Set([...full.restored, ...full.removed].map((p) => resolve(cwd, p)));
        const rest = eng.undoTurnFiles(id, userOrdinal, handled);
        broadcast("git:changed", { cwd });
        return {
          restored: [...full.restored, ...rest.restored],
          removed: [...full.removed, ...rest.removed],
          skipped: rest.skipped,
          partial: rest.partial,
          outside: full.outside,
        };
      }
      const result = eng.undoTurnFiles(id, userOrdinal);
      broadcast("git:changed", { cwd });
      return { ...result, outside: full.outside };
    }
    return { ...eng.undoTurnFiles(id, userOrdinal), outside: [] };
  });
  handle("sessions:export", async ({ id }, e) => {
    const md = await eng.exportSession(id);
    const path = await saveDialog(e, {
      title: i18n.t("dialog.exportSession"),
      defaultPath: join(app.getPath("documents"), "codezal-oturum.md"),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return null;
    writeFileSync(path, md, "utf8");
    return path;
  });

  handle("permissions:respond", ({ requestId, decision }) => {
    if (!eng.respondPermission(requestId, decision)) {
      throw new Error(i18n.t("errors.noPendingRequest"));
    }
  });
  handle("plans:respond", ({ requestId, decision }) => {
    if (!eng.respondPlan(requestId, decision)) throw new Error(i18n.t("errors.noPendingPlan"));
  });
  handle("questions:respond", ({ requestId, answers }) => {
    if (!eng.respondQuestion(requestId, answers)) {
      throw new Error(i18n.t("errors.noPendingQuestion"));
    }
  });
  // Eklenti `ctx.ui` kartı cevabı; istek bu arada iptal edilmişse sessizce yutulur.
  handle("sessions:respondExtensionUi", ({ sessionId, requestId, value }) => {
    eng.respondExtensionUi(sessionId, requestId, value);
  });
}
