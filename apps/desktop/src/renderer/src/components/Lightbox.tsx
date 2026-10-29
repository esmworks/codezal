import { useEffect } from "react";
import { create } from "zustand";

interface LightboxState {
  src: string | null;
  open: (src: string) => void;
  close: () => void;
}

export const useLightbox = create<LightboxState>((set) => ({
  src: null,
  open: (src) => set({ src }),
  close: () => set({ src: null }),
}));

/** Tam ekran görsel önizleme; tıklayınca ya da Esc ile kapanır. */
export function Lightbox() {
  const src = useLightbox((s) => s.src);
  const close = useLightbox((s) => s.close);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Alttaki katmanlar (oturum turu, Ayarlar) aynı basışla kapanmasın.
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, close]);

  if (!src) return null;
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-8"
      onClick={close}
    >
      <img src={src} alt="" className="max-h-full max-w-full rounded-[10px] shadow-panel" />
    </div>
  );
}
