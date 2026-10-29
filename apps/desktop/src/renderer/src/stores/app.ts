import type { AppMode } from "@codezal/contracts";
import { applyTheme, type Theme } from "@codezal/ui";
import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";

/** "scheduled": Asistan kipindeki Zamanlanmış görevler sayfası. */
export type Screen = "home" | "session" | "project" | "scheduled";

interface Persisted {
  theme: Theme;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  /** Asistan görev ekranındaki yüzen kutular (İlerleme, Çıktılar…); varsayılan görünür. */
  taskBoxesOpen: boolean;
  /** Görev ekranından eklenen bağlam proje bağlamına da kaydedilsin mi; menüdeki onay işareti. */
  contextToProject: boolean;
  userName: string;
}

interface AppState extends Persisted {
  mode: AppMode;
  screen: Screen;
  activeSessionId: string | null;
  activeProjectId: string | null;
  settingsOpen: boolean;
  settingsPage: string;
  searchOpen: boolean;
  modal: "commit" | "trace" | null;
  skillsOpen: boolean;
  /** Komut ekranı (`/yardım`) açık mı; `commandsQuery` ekranın arama kutusunu doldurur. */
  commandsOpen: boolean;
  commandsQuery: string;
  setMode: (mode: AppMode) => void;
  goHome: () => void;
  /** Ana ekrana yalnız `id` hâlâ açık sohbetse döner (gecikmiş açılış hatası için). */
  leaveSession: (id: string) => void;
  openSession: (id: string, mode?: AppMode) => void;
  openProject: (id: string) => void;
  openScheduled: () => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (w: number) => void;
  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  toggleTaskBoxes: () => void;
  setContextToProject: (on: boolean) => void;
  setSettingsOpen: (open: boolean, page?: string) => void;
  setSearchOpen: (open: boolean) => void;
  setModal: (modal: AppState["modal"]) => void;
  setSkillsOpen: (open: boolean) => void;
  setCommandsOpen: (open: boolean, query?: string) => void;
}

const KEY = "codezal.app";
const persisted = loadJson<Persisted>(KEY, {
  theme: "koyu",
  sidebarOpen: true,
  sidebarWidth: 250,
  panelOpen: false,
  panelWidth: 372,
  taskBoxesOpen: true,
  contextToProject: false,
  userName: "",
});

function persist(state: AppState) {
  const {
    theme,
    sidebarOpen,
    sidebarWidth,
    panelOpen,
    panelWidth,
    taskBoxesOpen,
    contextToProject,
    userName,
  } = state;
  saveJson(KEY, {
    theme,
    sidebarOpen,
    sidebarWidth,
    panelOpen,
    panelWidth,
    taskBoxesOpen,
    contextToProject,
    userName,
  });
}

const prefersLight = () => window.matchMedia("(prefers-color-scheme: light)").matches;

export const useApp = create<AppState>((set, get) => ({
  ...persisted,
  mode: "kodlama",
  screen: "home",
  activeSessionId: null,
  activeProjectId: null,
  settingsOpen: false,
  settingsPage: "genel",
  searchOpen: false,
  modal: null,
  skillsOpen: false,
  commandsOpen: false,
  commandsQuery: "",

  setMode: (mode) =>
    set({ mode, screen: "home", activeSessionId: null, activeProjectId: null, skillsOpen: false }),
  goHome: () => set({ screen: "home", activeSessionId: null, skillsOpen: false }),
  leaveSession: (id) => {
    if (get().activeSessionId === id) get().goHome();
  },
  // Oturum açılışında kenar çubuğu açık kalır; daraltma kullanıcının kendi tercihi.
  openSession: (id, mode) =>
    set((s) => ({
      screen: "session",
      activeSessionId: id,
      mode: mode ?? s.mode,
      skillsOpen: false,
      searchOpen: false,
    })),
  openProject: (id) =>
    set({ screen: "project", activeProjectId: id, activeSessionId: null, mode: "asistan" }),
  openScheduled: () =>
    set({
      screen: "scheduled",
      activeProjectId: null,
      activeSessionId: null,
      mode: "asistan",
      skillsOpen: false,
    }),
  setTheme: (theme) => {
    applyTheme(theme, prefersLight());
    set({ theme });
    persist(get());
  },
  toggleTheme: () => get().setTheme(get().theme === "koyu" ? "açık" : "koyu"),
  toggleSidebar: () => {
    set({ sidebarOpen: !get().sidebarOpen });
    persist(get());
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
    persist(get());
  },
  setSidebarWidth: (sidebarWidth) => {
    set({ sidebarWidth });
    persist(get());
  },
  toggleTaskBoxes: () => {
    set({ taskBoxesOpen: !get().taskBoxesOpen });
    persist(get());
  },
  setContextToProject: (contextToProject) => {
    set({ contextToProject });
    persist(get());
  },
  togglePanel: () => {
    set({ panelOpen: !get().panelOpen });
    persist(get());
  },
  setPanelWidth: (panelWidth) => {
    set({ panelWidth });
    persist(get());
  },
  setSettingsOpen: (settingsOpen, page) =>
    set(page ? { settingsOpen, settingsPage: page } : { settingsOpen }),
  setModal: (modal) => set({ modal }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSkillsOpen: (skillsOpen) => set({ skillsOpen }),
  // `/yardım <komut>` ekranı süzülmüş açar: sorgu her açılışta yazılır, kapanışta temizlenir.
  setCommandsOpen: (commandsOpen, query = "") => set({ commandsOpen, commandsQuery: query }),
}));

applyTheme(persisted.theme, prefersLight());
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  const { theme } = useApp.getState();
  if (theme === "sistem") applyTheme(theme, prefersLight());
});
