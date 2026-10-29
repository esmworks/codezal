import { create } from "zustand";

export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /** İsteğe bağlı eylem (ör. "Günlüğü aç"). */
  action?: { label: string; run: () => void };
}

interface ToastState {
  items: Toast[];
  push: (kind: ToastKind, text: string, action?: Toast["action"]) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
const TTL: Record<ToastKind, number> = { error: 8000, info: 4000, success: 3000 };

/** Sağ altta kısa süreli bildirimler. IPC ve yakalanmamış hatalar da buraya düşer. */
export const useToast = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, text, action) => {
    const id = ++seq;
    // Aynı metin art arda gelirse (ör. tekrarlayan IPC hatası) tek kart göster.
    if (get().items.some((t) => t.text === text && t.kind === kind)) return;
    set((s) => ({
      items: [...s.items.slice(-4), { id, kind, text, ...(action ? { action } : {}) }],
    }));
    setTimeout(() => get().dismiss(id), TTL[kind]);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = {
  error: (text: string, action?: Toast["action"]) =>
    useToast.getState().push("error", text, action),
  info: (text: string) => useToast.getState().push("info", text),
  success: (text: string, action?: Toast["action"]) =>
    useToast.getState().push("success", text, action),
};

/** "[sessions:prompt] Oturum açık değil: x" → "Oturum açık değil: x" (kanal adı kullanıcıya gereksiz). */
export function humanizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error: /, "")
    .replace(/^\[[a-z]+:[a-zA-Z]+\] /, "")
    .trim();
}

/** Yakalanan hatayı bildirimle gösterir; `promise.catch(reportError)` kalıbı için. */
export function reportError(error: unknown): void {
  toast.error(humanizeError(error));
}
