import type { GitBranch, GitStatus } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface GitState {
  status: Record<string, GitStatus>;
  branches: Record<string, GitBranch[]>;
  refresh: (cwd: string) => Promise<GitStatus | null>;
  loadBranches: (cwd: string) => Promise<GitBranch[]>;
  checkout: (cwd: string, branch: string) => Promise<void>;
}

const inflight = new Map<string, Promise<GitStatus | null>>();
/**
 * Koşu sürerken gelen yenileme istekleri. Uçuştaki istek paylaşıldığı için ajanın bir dosyayı
 * düzenlemesinden sonra gelen `git:changed` eski isteğe ekleniyordu ve sonuç bayat kalıyordu
 * (Değişiklikler sekmesinde yeni dosya görünmüyordu). Bu bayrak, istek bitince bir kez daha
 * koşmayı sağlar.
 */
const pending = new Set<string>();

/** Proje başına git durumu; `git:changed` olayında yenilenir. */
export const useGit = create<GitState>((set, get) => ({
  status: {},
  branches: {},
  refresh: (cwd) => {
    const cur = inflight.get(cwd);
    if (cur) {
      pending.add(cwd);
      return cur;
    }
    const p = invoke("git:status", { cwd })
      .then((status) => {
        set((s) => ({ status: { ...s.status, [cwd]: status } }));
        return status;
      })
      .catch(() => null)
      .finally(() => {
        inflight.delete(cwd);
        // Koşu sırasında gelen istek varsa tazelenir: bayrak düşmezse sekme bayat kalırdı.
        if (pending.delete(cwd)) void get().refresh(cwd);
      });
    inflight.set(cwd, p);
    return p;
  },
  loadBranches: async (cwd) => {
    const list = await invoke("git:branches", { cwd }).catch(() => []);
    set((s) => ({ branches: { ...s.branches, [cwd]: list } }));
    return list;
  },
  checkout: async (cwd, branch) => {
    await invoke("git:checkout", { cwd, branch });
    await get().loadBranches(cwd);
    await get().refresh(cwd);
  },
}));

let timer: ReturnType<typeof setTimeout> | undefined;
on("git:changed", ({ cwd }) => {
  // Ajan araç çıktıları art arda gelir; toplu yenile.
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const st = useGit.getState();
    const targets = cwd ? [cwd] : Object.keys(st.status);
    for (const c of targets) void st.refresh(c);
  }, 400);
});
