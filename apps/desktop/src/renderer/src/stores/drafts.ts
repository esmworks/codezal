import { create } from "zustand";
import { type ComposerDraft, isDraftEmpty, sameDraft } from "../session/composerParts";

interface DraftsState {
  /** Oturum kimliği ya da giriş ekranı anahtarı → gönderilmemiş yazma kutusu taslağı. */
  drafts: Record<string, ComposerDraft>;
  set: (id: string, draft: ComposerDraft | null) => void;
  /** Oturum silinince taslağı bırakır (taslak base64 görsel taşıyabilir). */
  clear: (id: string) => void;
}

/**
 * Oturum başına gönderilmemiş taslak: metin, yapıştırma parçaları ve görsel ekleri.
 * Ekranlar oturum kimliğiyle yeniden kurulur (App `key`); kutu boşalmasın diye içerik
 * burada tutulur ve dönüşte aynen geri okunur. Görseller de dahil olduğu için oturumlar
 * arasında gidip gelmek artık hiçbir içeriği düşürmez.
 */
export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  set: (id, draft) =>
    set((s) => {
      const cur = s.drafts[id];
      const empty = !draft || isDraftEmpty(draft);
      // Silinecek kayıt yoksa ya da içerik aynıysa store'a dokunma.
      if (!cur && empty) return s;
      if (cur && draft && sameDraft(cur, draft)) return s;
      const drafts = { ...s.drafts };
      if (empty) delete drafts[id];
      else if (draft) drafts[id] = draft;
      return { drafts };
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[id];
      return { drafts };
    }),
}));

/** Ekran kurulurken okunan taslak (yeniden çizim tetiklemez). */
export const draftFor = (id: string): ComposerDraft | null =>
  useDrafts.getState().drafts[id] ?? null;
