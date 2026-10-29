import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * Metin soran küçük pencere. Electron `window.prompt`i desteklemez ("prompt() is not supported"),
 * bu yüzden ad verme, not ekleme gibi tek satırlık girişler buradan geçer. Boş bırakılırsa
 * ya da vazgeçilirse `null` döner.
 */
export interface PromptOptions {
  title: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
}

interface PromptState {
  open: (PromptOptions & { resolve: (v: string | null) => void }) | null;
  askText: (o: PromptOptions) => Promise<string | null>;
  close: (v: string | null) => void;
}

export const usePrompt = create<PromptState>((set, get) => ({
  open: null,
  askText: (o) =>
    new Promise((resolve) => {
      get().open?.resolve(null);
      set({ open: { ...o, resolve } });
    }),
  close: (v) => {
    const o = get().open;
    set({ open: null });
    o?.resolve(v);
  },
}));

export const askText = (o: PromptOptions) => usePrompt.getState().askText(o);

export function PromptDialog() {
  const { t } = useTranslation();
  const open = usePrompt((s) => s.open);
  const close = usePrompt((s) => s.close);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(open.initial ?? "");
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;
  const trimmed = value.trim();
  const submit = () => close(trimmed ? trimmed : null);

  return (
    <Modal
      title={open.title}
      width={440}
      onClose={() => close(null)}
      footer={
        <>
          <span className="flex-1" />
          <Button size="lg" onClick={() => close(null)}>
            {t("common.dismiss")}
          </Button>
          <Button variant="primary" size="lg" onClick={submit} disabled={!trimmed}>
            {open.okLabel ?? t("common.ok")}
          </Button>
        </>
      }
    >
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={open.placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="h-[38px] w-full rounded-[10px] border border-line2 bg-card px-3 text-[14px] text-tx outline-none placeholder:text-tx3 focus:border-tx3 focus:shadow-[0_0_0_3px_var(--accSoft)]"
      />
    </Modal>
  );
}
