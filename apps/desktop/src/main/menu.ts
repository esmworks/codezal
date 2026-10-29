import { type AppCommand, resolveAccelerator } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { openExternalSafe } from "./links.js";

function send(command: AppCommand) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send("app:command", { command });
}

/** Sağ tık menüsünün dili; uygulama menüsü yeniden kurulunca güncellenir. */
let current: Locale = "tr";

/**
 * Sağ tık menüsü. Electron'da varsayılan bağlam menüsü yoktur: seçili yanıt metni sağ tıkla
 * kopyalanamıyor, yazma kutusuna yapıştırılamıyordu. Bir kez kurulur, dili menüyle birlikte gelir.
 */
export function installContextMenu(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("context-menu", (_e, params) => {
      const d = dict(current);
      const { editFlags: can, isEditable: editable } = params;
      // Seçim de yazma kutusu da yoksa gösterilecek bir şey kalmaz; menü hiç açılmaz.
      if (!editable && !params.selectionText) return;
      const items: MenuItemConstructorOptions[] = [
        ...(editable ? [{ role: "cut" as const, label: d.menu.cut, enabled: can.canCut }] : []),
        { role: "copy", label: d.menu.copy, enabled: can.canCopy },
        ...(editable
          ? [{ role: "paste" as const, label: d.menu.paste, enabled: can.canPaste }]
          : []),
        { type: "separator" },
        { role: "selectAll", label: d.menu.selectAll },
      ];
      Menu.buildFromTemplate(items).popup();
    });
  });
}

/** Kayıt sırasında menü hızlandırıcıları tamamen kaldırılır (boş string menüde kalmasın). */
function stripAccelerators(items: MenuItemConstructorOptions[]): void {
  for (const item of items) {
    delete item.accelerator;
    if (Array.isArray(item.submenu)) stripAccelerators(item.submenu);
  }
}

/** Uygulama menüsü ve klavye kısayolları (PRD §4.1, TODO 1.2). Dil ya da kısayol değişince yeniden kurulur. */
export function installMenu(
  locale: Locale,
  keybindings?: Record<string, string>,
  suspended = false,
): void {
  const isMac = process.platform === "darwin";
  const d = dict(locale);
  current = locale;
  // Kullanıcı tanımlı kısayollar menüye buradan girer; tanımsız komutlar varsayılanını kullanır.
  const acc = (command: AppCommand): string => resolveAccelerator(command, keybindings);

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about", label: d.menu.about },
            { type: "separator" },
            { label: d.menu.settings, accelerator: acc("settings"), click: () => send("settings") },
            { type: "separator" },
            { role: "services", label: d.menu.services },
            { type: "separator" },
            { role: "hide", label: d.menu.hide },
            { role: "hideOthers", label: d.menu.hideOthers },
            { role: "unhide", label: d.menu.showAll },
            { type: "separator" },
            { role: "quit", label: d.menu.quit },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: d.menu.file,
      submenu: [
        { label: d.menu.newTask, accelerator: acc("new-task"), click: () => send("new-task") },
        { label: d.menu.search, accelerator: acc("search"), click: () => send("search") },
        { type: "separator" },
        ...(isMac
          ? []
          : [
              {
                label: d.menu.settings,
                accelerator: acc("settings"),
                click: () => send("settings"),
              },
            ]),
        ...(isMac
          ? [{ role: "close" as const, label: d.menu.closeWindow }]
          : [{ role: "quit" as const, label: d.menu.quitWin }]),
      ],
    },
    {
      label: d.menu.edit,
      submenu: [
        { role: "undo", label: d.menu.undo },
        { role: "redo", label: d.menu.redo },
        { type: "separator" },
        { role: "cut", label: d.menu.cut },
        { role: "copy", label: d.menu.copy },
        { role: "paste", label: d.menu.paste },
        { role: "selectAll", label: d.menu.selectAll },
        { type: "separator" },
        // Sohbet içi bulma: sanal listede tarayıcının sayfa içi araması ekran dışını göremez,
        // bu yüzden rol değil komut; arayüz veri modelinde arar.
        { label: d.menu.find, accelerator: acc("find"), click: () => send("find") },
      ],
    },
    {
      label: d.menu.view,
      submenu: [
        {
          label: d.menu.toggleSidebar,
          accelerator: acc("toggle-sidebar"),
          click: () => send("toggle-sidebar"),
        },
        {
          label: d.menu.togglePanel,
          accelerator: acc("toggle-panel"),
          click: () => send("toggle-panel"),
        },
        { label: d.menu.terminal, accelerator: acc("terminal"), click: () => send("terminal") },
        { label: d.menu.changes, accelerator: acc("changes"), click: () => send("changes") },
        {
          label: d.menu.commit,
          accelerator: acc("commit"),
          click: () => send("commit"),
        },
        { label: d.menu.model, accelerator: acc("model"), click: () => send("model") },
        { type: "separator" },
        // Geliştirmede yararlı; üretimde Ctrl+R/F12 kazara durumu bozar (sohbet ekranı sıfırlanır).
        ...(app.isPackaged
          ? []
          : [
              { role: "reload" as const, label: d.menu.reload },
              { role: "toggleDevTools" as const, label: d.menu.devTools },
              { type: "separator" as const },
            ]),
        { role: "togglefullscreen", label: d.menu.fullscreen },
      ],
    },
    {
      label: d.menu.git,
      submenu: [
        { label: d.menu.changes, accelerator: acc("changes"), click: () => send("changes") },
        { label: d.menu.commit, accelerator: acc("commit"), click: () => send("commit") },
      ],
    },
    {
      label: d.menu.window,
      submenu: [
        { role: "minimize", label: d.menu.minimize },
        { role: "zoom", label: d.menu.zoom },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const, label: d.menu.front }]
          : []),
      ],
    },
    {
      label: d.menu.help,
      submenu: [
        {
          label: d.menu.docs,
          click: () => void openExternalSafe("https://github.com/esmworks/codezal"),
        },
      ],
    },
  ];

  // Kayıt kipinde hızlandırıcılar tamamen kaldırılır; yoksa tuş renderer'a ulaşmadan menü çalışır.
  if (suspended) stripAccelerators(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
