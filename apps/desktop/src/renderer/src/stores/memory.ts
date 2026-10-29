import type { MemoryDraft, MemoryEntry, MemoryScope } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

/** Kapsam anahtarı: liste önbelleği ve yeniden yükleme için. */
export function parseScopeKey(key: string): MemoryScope {
  if (key.startsWith("proje:")) return { kind: "proje", cwd: key.slice("proje:".length) };
  if (key.startsWith("asistan:"))
    return { kind: "asistan", projectId: key.slice("asistan:".length) };
  return { kind: "genel" };
}

export function scopeKey(scope: MemoryScope): string {
  if (scope.kind === "genel") return "genel";
  if (scope.kind === "proje") return `proje:${scope.cwd}`;
  return `asistan:${scope.projectId}`;
}

interface MemoryState {
  byScope: Record<string, MemoryEntry[]>;
  load: (scope: MemoryScope) => Promise<void>;
  save: (scope: MemoryScope, draft: MemoryDraft) => Promise<void>;
  remove: (scope: MemoryScope, name: string) => Promise<void>;
  openFolder: (scope: MemoryScope) => Promise<void>;
}

const watched = new Map<string, MemoryScope>();

export const useMemory = create<MemoryState>((set, get) => ({
  byScope: {},
  load: async (scope) => {
    watched.set(scopeKey(scope), scope);
    const entries = await invoke("memory:list", { scope });
    set((s) => ({ byScope: { ...s.byScope, [scopeKey(scope)]: entries } }));
  },
  save: async (scope, draft) => {
    await invoke("memory:save", { scope, draft });
    await get().load(scope);
  },
  remove: async (scope, name) => {
    await invoke("memory:remove", { scope, name });
    await get().load(scope);
  },
  openFolder: (scope) => invoke("memory:openFolder", { scope }),
}));

// Ajan bellek yazınca açık kapsamlar yenilensin.
on("memory:changed", () => {
  for (const scope of watched.values()) void useMemory.getState().load(scope);
});
