import {
  type AssistantProject,
  joinPath,
  outputsDirFor,
  type ScheduledTask,
} from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface AssistantState {
  projects: AssistantProject[];
  tasks: ScheduledTask[];
  userData: string;
  documents: string;
  load: () => Promise<void>;
  saveProject: (p: AssistantProject) => Promise<void>;
  /** Adı verilen boş projeyi oluşturur, kimliğini döner. */
  createProject: (name: string) => Promise<string>;
  deleteProject: (id: string) => Promise<void>;
  /** Asistan projelerinin manuel sırasını yazar (sürükle-bırak). */
  reorderProjects: (ids: string[]) => Promise<void>;
  saveTask: (t: ScheduledTask) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  /** Asistan oturumları için çalışma klasörü (userData/asistan/<proje>|genel). */
  cwdFor: (projectId: string | null) => string;
  /** Kullanıcının göreceği çıktı klasörü (Belgeler/Codezal Asistan/<proje>/Çıktılar). */
  outputsDirFor: (projectId: string | null) => string;
  /** Bağlamı proje klasörüne kopyalar; büyük kopyada onay ister (`needsConfirm`). */
  copyContext: (
    projectId: string,
    value: string,
    confirm?: boolean,
  ) => Promise<{ bytes: number; needsConfirm: boolean }>;
  /** Bağlamı projeden çıkarır; kopyası varsa çöp kutusuna taşınır. */
  removeContext: (projectId: string, value: string) => Promise<void>;
}

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Projeyi listede bulunduğu yerde değiştirir; yeni proje başa eklenir. Main'in sıra kuralıyla
 * birebir aynıdır, aksi halde her kayıtta sıra iki taraf arasında gidip gelir.
 */
function upsertProject(projects: AssistantProject[], p: AssistantProject): AssistantProject[] {
  return projects.some((x) => x.id === p.id)
    ? projects.map((x) => (x.id === p.id ? p : x))
    : [p, ...projects];
}

export const useAssistant = create<AssistantState>((set, get) => ({
  projects: [],
  tasks: [],
  userData: "",
  documents: "",
  load: async () => {
    const [projects, tasks, paths] = await Promise.all([
      invoke("assistant:projects", undefined),
      invoke("schedule:list", undefined),
      invoke("app:paths", undefined),
    ]);
    set({
      // Sıra dosyadaki dizinin sırasıdır; kullanıcı sürükledikçe kalıcılaşır.
      projects,
      tasks,
      userData: paths.userData,
      documents: paths.documents,
    });
  },
  saveProject: async (p) => {
    const saved = await invoke("assistant:saveProject", p);
    set((s) => ({ projects: upsertProject(s.projects, saved) }));
  },
  createProject: async (name) => {
    const id = uid();
    await get().saveProject({
      id,
      name: name.trim(),
      description: "",
      instructions: "",
      memory: [],
      context: [],
      createdAt: Date.now(),
    });
    return id;
  },
  deleteProject: async (id) => {
    await invoke("assistant:deleteProject", { id });
    set((s) => ({ projects: s.projects.filter((x) => x.id !== id) }));
  },
  reorderProjects: async (ids) => {
    set({ projects: await invoke("assistant:reorderProjects", { ids }) });
  },
  saveTask: async (t) => {
    const saved = await invoke("schedule:save", t);
    set((s) => ({ tasks: [...s.tasks.filter((x) => x.id !== t.id), saved] }));
  },
  deleteTask: async (id) => {
    await invoke("schedule:delete", { id });
    set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
  },
  runNow: async (id) => {
    await invoke("schedule:runNow", { id });
    await get().load();
  },
  cwdFor: (projectId) => joinPath(get().userData, "asistan", projectId ?? "genel"),
  outputsDirFor: (projectId) => {
    const name = projectId ? get().projects.find((p) => p.id === projectId)?.name : null;
    return outputsDirFor(get().documents, name ?? null);
  },
  copyContext: async (projectId, value, confirm = false) => {
    const r = await invoke("assistant:copyContext", { projectId, value, confirm });
    set((s) => ({ projects: upsertProject(s.projects, r.project) }));
    return { bytes: r.bytes, needsConfirm: r.needsConfirm };
  },
  removeContext: async (projectId, value) => {
    const r = await invoke("assistant:removeContext", { projectId, value });
    set((s) => ({ projects: upsertProject(s.projects, r.project) }));
  },
}));

on("schedule:ran", () => void useAssistant.getState().load());
on("schedule:changed", () => void useAssistant.getState().load());
