import { create } from "zustand";
import type { FindTarget } from "../lib/transcriptFind";

/**
 * Sohbet içi bulma çubuğu (⌘F). Durum oturuma bağlıdır: çubuk yalnız `sessionId` oturumunun ana
 * transkriptinde görünür (yan sohbet paneli ve başka oturum etkilenmez).
 *
 * `pending`: ⌘K içerik isabetinden gelen atlama isteği. Palet oturumu açar, transkript
 * bağlanınca isteği tüketir: çubuğu sorguyla açar ve hedef mesaja atlar.
 */
interface FindState {
  open: boolean;
  sessionId: string | null;
  query: string;
  /** Çubuk açıkken ⌘F yeniden basılınca kutu odaklanıp seçilsin diye artar. */
  focusNonce: number;
  pending: { sessionId: string; query: string; target: FindTarget } | null;
  openFor: (sessionId: string, query?: string) => void;
  close: () => void;
  setQuery: (query: string) => void;
  request: (sessionId: string, query: string, target: FindTarget) => void;
  /** Bekleyen isteği alır ve siler; başka oturumun isteğiyse dokunmaz. */
  take: (sessionId: string) => { query: string; target: FindTarget } | null;
}

export const useFind = create<FindState>((set, get) => ({
  open: false,
  sessionId: null,
  query: "",
  focusNonce: 0,
  pending: null,
  openFor: (sessionId, query) =>
    set((s) => ({
      open: true,
      sessionId,
      // Başka oturumdan kalan sorgu taşınmaz; aynı oturumda son sorgu korunur.
      query: query ?? (s.sessionId === sessionId ? s.query : ""),
      focusNonce: s.focusNonce + 1,
    })),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  request: (sessionId, query, target) => set({ pending: { sessionId, query, target } }),
  take: (sessionId) => {
    const pending = get().pending;
    if (!pending || pending.sessionId !== sessionId) return null;
    set({ pending: null });
    return { query: pending.query, target: pending.target };
  },
}));

/** Bulma çubuğu açık mı; oturum ekranının Esc'i önce çubuğu kapatır. */
export function findBarOpen(): boolean {
  return useFind.getState().open;
}
