import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { floatingLayerOpen, isTopModal, popModal, pushModal } from "../stores/layers";
import { Icon } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, onClose, width = 520, children, footer }: Props) {
  const { t } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  // Yığın kimliği ilk çizimde alınır: Esc dinleyicisi "en üstteki ben miyim" diye buna bakar.
  const layer = useRef(0);
  useEffect(() => {
    const id = pushModal();
    layer.current = id;
    return () => popModal(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc'i başka katman aldıysa ya da üstte menü/iç içe modal varsa bu modal kapanmaz.
        if (e.defaultPrevented || !isTopModal(layer.current) || floatingLayerOpen()) return;
        // Alttaki pencere dinleyicileri (oturum, Ayarlar) Esc'in işlendiğini buradan anlar.
        e.preventDefault();
        onClose();
        return;
      }
      // Sekme kartın içinde döner: tuzağa alınmazsa odak perdenin arkasındaki kenar çubuğuna
      // kaçıp Enter'la görünmeyen düğmeleri çalıştırıyordu.
      if (e.key !== "Tab") return;
      const el = card.current;
      if (!el) return;
      const focusables = el.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Açılışta odak karta girer (kullanıcı Tab'a bastığında kartın içinden başlar); kapanınca
  // açan öğeye döner, yoksa klavye kullanıcısı sayfanın başına düşüp yerini kaybediyordu.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    // Perde tasarımdaki ince sıcak siyah; backdrop-blur yok, arkayı grileştirip kartı soluk gösteriyordu.
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-[var(--scrim)]"
      onMouseDown={onClose}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="cz-modal flex max-h-[86vh] flex-col overflow-hidden rounded-[16px] border border-line2 bg-card shadow-panel outline-none"
        style={{ width, maxWidth: "92vw" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Başlık ve alt bar çizgisiz: ayrımı boşluk taşır. */}
        <div className="flex items-center gap-2 px-[18px] pt-4 pb-1">
          <div className="flex-1 text-[16px] font-semibold tracking-[-0.01em] text-tx">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
          >
            <Icon name="x" size={14} stroke={1.9} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-2">{children}</div>
        {footer ? (
          <div className="flex items-center gap-[10px] px-[18px] pt-3 pb-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
