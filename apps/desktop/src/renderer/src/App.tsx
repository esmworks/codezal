import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { on } from "./api";
import { ConfirmDialog } from "./components/Confirm";
import { Lightbox } from "./components/Lightbox";
import { MenuLayer } from "./components/MenuLayer";
import { Modal } from "./components/Modal";
import { ModelPickerLayer } from "./components/ModelPickerLayer";
import { PromptDialog } from "./components/Prompt";
import { Toasts } from "./components/Toasts";
import { UpdateCard } from "./components/UpdateCard";
import { layerAboveSession } from "./lib/escapeLayers";
import { formatUsd } from "./lib/format";
import { revealChanges } from "./lib/revealChanges";
import { revealTerminal } from "./lib/revealTerminal";
import { CommitModal } from "./modals/CommitModal";
import { AsistanHome } from "./screens/asistan/AsistanHome";
import { AsistanProject } from "./screens/asistan/AsistanProject";
import { AsistanScheduled } from "./screens/asistan/AsistanScheduled";
import { AsistanTask } from "./screens/asistan/AsistanTask";
import { KodlamaHome } from "./screens/KodlamaHome";
import { SessionScreen } from "./screens/SessionScreen";
import { CommandsScreen } from "./session/CommandsScreen";
import { TracePanel } from "./session/TracePanel";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import { SearchPalette } from "./shell/SearchPalette";
import { Sidebar } from "./shell/Sidebar";
import { TitleBar } from "./shell/TitleBar";
import { Welcome } from "./shell/Welcome";
import { useApp } from "./stores/app";
import { useFind } from "./stores/find";
import { useModels } from "./stores/models";
import { usePanel } from "./stores/panel";
import { useCurrentProject } from "./stores/projects";
import { useSessions } from "./stores/sessions";
import { useSettings } from "./stores/settings";
import { useStartup } from "./stores/startup";
import { reportError, toast } from "./stores/toast";
import { useUpdate } from "./stores/update";

export function App() {
  const { t } = useTranslation();
  const { mode, screen, activeSessionId, activeProjectId, modal, setModal, settingsOpen } =
    useApp();
  const searchOpen = useApp((s) => s.searchOpen);
  const commandsOpen = useApp((s) => s.commandsOpen);
  const activeSession = useSessions((s) => s.list.find((x) => x.id === activeSessionId));
  const currentProject = useCurrentProject();
  const modalCwd = activeSession?.cwd ?? currentProject?.path ?? "";

  useEffect(() => {
    // Açılış yüklemeleri yakalanır: düşen IPC sessizce boş ekran bırakmasın. Kenar çubuğunun
    // listeleri `useStartup` üzerinden gelir; o, hatayı "Yeniden dene" satırıyla gösterir.
    void useSettings.getState().load().catch(reportError);
    void useUpdate.getState().load().catch(reportError);
    void useModels.getState().load().catch(reportError);
    void useStartup.getState().load();
  }, []);

  // Para bütçesi eşiği (ayda eşik başına bir kez; main kaydeder). Tur durdurulmaz, yalnız uyarı.
  useEffect(
    () =>
      on("usage:budget", ({ threshold, cost, limit }) => {
        const lang = useSettings.getState().settings?.language ?? "tr";
        const values = { cost: formatUsd(cost, lang), limit: formatUsd(limit, lang) };
        if (threshold >= 100) toast.error(t("settings.usage.budgetUsdToastOver", values));
        else toast.info(t("settings.usage.budgetUsdToastWarn", values));
      }),
    [t],
  );

  // Ayara göre gömülü tarayıcıda açılacak bağlantı: sekmeyi açar ve paneli görünür yapar.
  useEffect(
    () =>
      on("link:open", ({ url }) => {
        const app = useApp.getState();
        usePanel.getState().setBrowserUrl(url);
        usePanel.getState().openTab("Tarayıcı");
        if (!app.panelOpen) app.togglePanel();
      }),
    [],
  );

  useEffect(
    () =>
      on("app:command", ({ command }) => {
        const app = useApp.getState();
        switch (command) {
          case "new-task":
            app.goHome();
            break;
          case "settings":
            app.setSettingsOpen(true);
            break;
          case "toggle-sidebar":
            app.toggleSidebar();
            break;
          case "toggle-panel":
            app.togglePanel();
            break;
          case "changes":
            revealChanges();
            break;
          case "commit":
            app.setModal("commit");
            break;
          case "terminal": {
            // Terminal projeye bağlıdır: aktif oturumun kökündeki terminal açılır (⌘J).
            const cwd = useSessions.getState().list.find((x) => x.id === app.activeSessionId)?.cwd;
            revealTerminal(cwd ?? "");
            break;
          }
          case "model":
            document.querySelector<HTMLButtonElement>("[data-model-chip]")?.click();
            break;
          case "search":
            app.setSearchOpen(!app.searchOpen);
            break;
          case "find":
            // Sohbet içi bulma yalnız açık oturumda ve üstte katman yokken (Ayarlar, palet).
            if (app.screen === "session" && app.activeSessionId && !layerAboveSession())
              useFind.getState().openFor(app.activeSessionId);
            break;
        }
      }),
    [],
  );

  const sessionMode = activeSession?.mode ?? mode;
  // Giriş ekranları (Kodlama/Asistan karşılaması) kendi başlık şeridini çizmez; üstteki
  // sürüklenebilir şerit App'ten gelir, yoksa pencere oradan sürüklenmez ve çift tıkla büyümez.
  // Üstte bir katman açıkken şerit kalkar: sürüklenebilir bölge örtüldüğü yerde de tıklama yutar.
  const atHome =
    !(screen === "session" && activeSessionId) &&
    !(screen === "project" && activeProjectId) &&
    !settingsOpen &&
    !searchOpen &&
    !modal;
  let body: React.ReactNode;
  if (screen === "session" && activeSessionId) {
    // `key`: oturum değişince ekran (ve yazma kutusu) sıfırdan kurulur; taslak useDrafts'ta saklanır.
    if (sessionMode === "asistan")
      body = <AsistanTask key={activeSessionId} id={activeSessionId} />;
    else body = <SessionScreen key={activeSessionId} id={activeSessionId} />;
  } else if (screen === "project" && activeProjectId)
    body = <AsistanProject key={activeProjectId} id={activeProjectId} />;
  else if (screen === "scheduled" && mode === "asistan") body = <AsistanScheduled />;
  else if (mode === "asistan") body = <AsistanHome />;
  else body = <KodlamaHome />;

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-tx">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* Şerit içerik kutusunun dışında durur: giriş ekranları kayan kutular, şerit onların
            içinde olsaydı sayfa kaydıkça yukarı kaçardı. */}
        {atHome ? (
          <div className="absolute inset-x-0 top-0 z-10 h-[34px] [-webkit-app-region:drag]" />
        ) : null}
        {body}
      </main>
      <MenuLayer />
      <ModelPickerLayer />
      <Lightbox />
      {searchOpen ? <SearchPalette /> : null}
      {commandsOpen ? <CommandsScreen /> : null}
      {modal === "commit" && modalCwd ? <CommitModal cwd={modalCwd} /> : null}
      {modal === "trace" && activeSessionId ? (
        <TracePanel sessionId={activeSessionId} onClose={() => setModal(null)} />
      ) : null}
      {modal === "commit" && !modalCwd ? (
        <Modal title={t("common.noProjectTitle")} onClose={() => setModal(null)}>
          <div className="text-[13px] text-tx3">{t("errors.noProject")}</div>
        </Modal>
      ) : null}
      {settingsOpen ? <SettingsOverlay /> : null}
      {!settingsOpen ? <Welcome /> : null}
      {/* Metin ve onay pencereleri en sonda: aynı z-130'u kullanan Commit/Trace
          modal'larının üstünde kalmalı; eşit z-index'te kardeş sırası kazananı belirler. */}
      <PromptDialog />
      <ConfirmDialog />
      {/* Sağ alt yığın: güncelleme kartı ile bildirimler çakışmasın, tostlar üstte durur. */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <Toasts />
        <UpdateCard />
      </div>
      {/* En sonda: sürüklenebilir bölge sırası için, bkz. TitleBar. */}
      <TitleBar />
    </div>
  );
}
