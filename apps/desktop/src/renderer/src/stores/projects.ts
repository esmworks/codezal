import type { ProjectRef } from "@codezal/contracts";
import { create } from "zustand";
import { invoke } from "../api";
import {
  type FolderMode,
  folderMode,
  resolveSelection,
  type Selection,
} from "../lib/projectSelection";
import { loadJson, saveJson } from "../lib/storage";
import { useModels } from "./models";
import { humanizeError, toast } from "./toast";

interface ProjectsState {
  recent: ProjectRef[];
  /** Bölüm başına seçili klasör; bugün yalnız Kodlama klasör seçer, Asistan projelerini kullanır. */
  byMode: Record<FolderMode, ProjectRef | null>;
  load: () => Promise<void>;
  pick: () => Promise<ProjectRef | null>;
  /** Etkin bölüm için projeyi seçer; main'de açılış (taşıma, güven sorusu) arkadan gelir. */
  select: (project: ProjectRef) => Promise<void>;
  /** Güven kararını değiştirir (Ayarlar > Kişiselleştirme). */
  setTrusted: (path: string, trusted: boolean) => Promise<void>;
  /** Klasörü son kullanılanlardan çıkarır; seçili olduğu bölümlerde seçim boşalır. */
  forget: (path: string) => Promise<void>;
  /** Kenar çubuğundaki manuel klasör sırasını yazar (sürükle-bırak). */
  reorder: (paths: string[]) => Promise<void>;
}

const KEY = "codezal.projects";
interface Persisted {
  paths?: Selection;
  /** Tek seçimli eski sürüm; Kodlama seçimi olarak taşınır. */
  currentPath?: string | null;
}

function readSelection(): Selection {
  const raw = loadJson<Persisted>(KEY, {});
  if (raw.paths) return raw.paths;
  return "currentPath" in raw ? { kodlama: raw.currentPath ?? null } : {};
}

/** Yalnızca kullanıcının dokunduğu bölüm yazılır; yazılmamış bölüm "hiç seçilmedi" demektir. */
function saveSelection(mode: FolderMode, path: string | null): void {
  saveJson(KEY, { paths: { ...readSelection(), [mode]: path } });
}

/** Güvenilen projenin `.codezal/ayarlar.json` değerleri yeni oturum varsayılanı olur. */
async function applyProjectConfig(project: ProjectRef): Promise<void> {
  if (!project.trusted) return;
  const config = await invoke("project:config", { cwd: project.path });
  const models = useModels.getState();
  if (config.permission) models.setPermission(config.permission);
  if (config.thinking) models.setThinking(config.thinking);
  const ref = config.model;
  if (ref) {
    // Katalog henüz yüklenmediyse yine yazılır; `load()` geçersiz modeli ilk uygun olanla değiştirir.
    const { catalog } = models;
    const usable =
      catalog.length === 0 ||
      catalog.some((m) => m.provider === ref.provider && m.id === ref.id && m.available);
    if (usable) models.setModel(ref);
  }
}

export const useProjects = create<ProjectsState>((set, get) => ({
  recent: [],
  byMode: { kodlama: null },

  load: async () => {
    const recent = await invoke("project:recent", undefined);
    const stored = readSelection();
    const byMode = { kodlama: resolveSelection(recent, stored, "kodlama") };
    set({ recent, byMode });
    // Açılışta etkin bölümün projesi de "açılır": taşınma ve güven kararı burada işlenir.
    const active = byMode[folderMode()];
    if (active) await get().select(active);
  },
  pick: async () => {
    const project = await invoke("project:pickFolder", undefined);
    if (project) {
      // Main zaten son kullanılanlara ekledi; `load()` çağrılmaz, çünkü o eski seçime geri döner
      // ve oturumsuz yeni klasör seçili olmayınca kenar çubuğunda görünmez.
      set((s) => ({ recent: [project, ...s.recent.filter((p) => p.path !== project.path)] }));
      await get().select(project);
    }
    return project;
  },
  select: async (project) => {
    const mode = folderMode();
    set((s) => ({ byMode: { ...s.byMode, [mode]: project } }));
    saveSelection(mode, project.path);
    try {
      const opened = await invoke("project:open", { path: project.path });
      // Kullanıcı bu arada başka projeye geçtiyse eskisini üzerine yazma.
      if (get().byMode[mode]?.path !== opened.path) return;
      set((s) => ({
        byMode: { ...s.byMode, [mode]: opened },
        recent: s.recent.some((p) => p.path === opened.path)
          ? s.recent.map((p) => (p.path === opened.path ? opened : p))
          : s.recent,
      }));
      await applyProjectConfig(opened);
    } catch (error) {
      toast.error(humanizeError(error));
    }
  },
  setTrusted: async (path, trusted) => {
    const ref = await invoke("project:setTrusted", { path, trusted });
    set((s) => ({
      byMode: {
        kodlama: s.byMode.kodlama?.path === path ? ref : s.byMode.kodlama,
      },
      recent: s.recent.map((p) => (p.path === path ? ref : p)),
    }));
    if (trusted) await applyProjectConfig(ref);
  },
  forget: async (path) => {
    await invoke("project:forget", { path });
    const { byMode } = get();
    // Kaldırılan projenin yerine başkası konmaz: listedeki bir sonraki proje başka bölümün
    // klasörü olabilir ve silinen sanılıp yanlışlıkla kaldırılır.
    for (const mode of ["kodlama"] as const)
      if (byMode[mode]?.path === path) saveSelection(mode, null);
    set((s) => ({
      recent: s.recent.filter((p) => p.path !== path),
      byMode: {
        kodlama: s.byMode.kodlama?.path === path ? null : s.byMode.kodlama,
      },
    }));
  },
  reorder: async (paths) => {
    // Main yeni sıralı listeyi döner: gizli klasörlerin konumu orada korunur, kaynak tek.
    set({ recent: await invoke("project:reorder", { paths }) });
  },
}));

/** Etkin bölümün seçili klasörü. */
export function useCurrentProject(): ProjectRef | null {
  const mode = folderMode();
  return useProjects((s) => s.byMode[mode]);
}

// Bölüm değişince proje açma aboneliği kaldırıldı: tek klasör bölümü (Kodlama) kaldığı için
// bölüm geçişi artık seçili projeyi değiştirmez.
