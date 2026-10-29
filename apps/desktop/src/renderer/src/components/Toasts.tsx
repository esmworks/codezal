import { useTranslation } from "react-i18next";
import type { IconName } from "../icons";
import { type ToastKind, useToast } from "../stores/toast";
import { Icon } from "./Icon";

/*
 * Bildirim kartı. Hata da bilgi de aynı nötr yüzeyde durur: türü kenarlık rengi değil ikon söyler
 * (ZCode'un hata çubuğunda olduğu gibi). Yeşil yalnız "başarıyla bitti" için kalır.
 */
const STYLE: Record<ToastKind, string> = {
  error: "border-line2",
  info: "border-line2",
  success: "border-green",
};

const ICON: Record<ToastKind, { name: IconName; tone: string }> = {
  error: { name: "bug", tone: "text-tx2" },
  info: { name: "sparkle", tone: "text-tx3" },
  success: { name: "check", tone: "text-green" },
};

export function Toasts() {
  const { t: tr } = useTranslation();
  const items = useToast((s) => s.items);
  const dismiss = useToast((s) => s.dismiss);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((t) => {
        const icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-[12px] border bg-card px-4 py-3 text-[13px] leading-[1.45] text-tx shadow-panel ${STYLE[t.kind]}`}
          >
            <Icon name={icon.name} size={14} className={`mt-[2px] shrink-0 ${icon.tone}`} />
            <div className="min-w-0 flex-1 break-words">
              {t.text}
              {t.action ? (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                  className="ml-2 underline decoration-tx3 underline-offset-2 hover:text-accTx"
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              // İkon `aria-hidden`: ekran okuyucu için ad burada verilir.
              aria-label={tr("common.close")}
              onClick={() => dismiss(t.id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-tx3 hover:bg-hov hover:text-tx"
            >
              <Icon name="x" size={11} stroke={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
