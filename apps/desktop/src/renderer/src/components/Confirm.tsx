import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * Onay penceresi. Electron'un yerel `window.confirm` diyaloğu Windows'ta pencere odak kilidini
 * bırakmıyor: diyalog kapandıktan sonra imleç yanıp sönse de tuşlar renderer'a ulaşmıyor ve
 * kullanıcı başka pencereye geçip dönmeden yazamıyor (electron/electron#41603, #31917).
 * Bu yüzden onay her yerde uygulama içindeki bu pencereden alınır.
 */
export interface ConfirmOptions {
  title: string;
  body?: string;
  okLabel?: string;
  /** Yıkıcı eylemlerde onay düğmesi kırmızı çerçeveli olur. */
  danger?: boolean;
}

interface ConfirmState {
  open: (ConfirmOptions & { resolve: (v: boolean) => void }) | null;
  askConfirm: (o: ConfirmOptions) => Promise<boolean>;
  close: (v: boolean) => void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  open: null,
  askConfirm: (o) =>
    new Promise((resolve) => {
      // Üst üste soru gelirse önceki iptal sayılır; iki pencere aynı anda durmaz.
      get().open?.resolve(false);
      set({ open: { ...o, resolve } });
    }),
  close: (v) => {
    const o = get().open;
    set({ open: null });
    o?.resolve(v);
  },
}));

export const askConfirm = (o: ConfirmOptions) => useConfirm.getState().askConfirm(o);

export function ConfirmDialog() {
  const { t } = useTranslation();
  const open = useConfirm((s) => s.open);
  const close = useConfirm((s) => s.close);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Yerel confirm gibi: Enter onaylar (varsayılan düğme odakta), Escape iptal eder.
      // Kompozisyon (IME) sürerken Enter onaylamasın.
      if (e.key !== "Enter" || e.isComposing) return;
      // Odak bir düğmedeyse tarayıcının kendi click'i çalışsın: "İptal"e odaklı Enter iptal eder.
      if (e.target instanceof Element && e.target.closest("button")) return;
      e.preventDefault();
      close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const danger = open.danger ?? false;

  return (
    <Modal
      title={open.title}
      width={440}
      onClose={() => close(false)}
      footer={
        <>
          <span className="flex-1" />
          <Button size="lg" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            autoFocus
            variant={danger ? "danger" : "primary"}
            size="lg"
            onClick={() => close(true)}
          >
            {open.okLabel ?? (danger ? t("common.delete") : t("common.ok"))}
          </Button>
        </>
      }
    >
      {open.body ? <div className="text-[13px] leading-[1.6] text-tx2">{open.body}</div> : null}
    </Modal>
  );
}
