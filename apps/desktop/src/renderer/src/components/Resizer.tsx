import { useCallback } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  /** Sürükleme yönü: sağ kenar (+1) ya da sol kenar (-1). */
  sign: 1 | -1;
  value: number;
  min: number;
  max: number;
  onChange: (w: number) => void;
  side: "left" | "right";
}

/** Genişlik ayarlama tutamacı (tasarımdaki dragSidebar/dragPanel). */
export function Resizer({ sign, value, min, max, onChange, side }: Props) {
  const { t } = useTranslation();
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = value;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // Sürüklerken kayma geçişi kapansın; kenar imleci geriden takip etmesin.
      document.body.dataset.czResizing = "1";
      const move = (ev: MouseEvent) => {
        onChange(Math.max(min, Math.min(max, w0 + sign * (ev.clientX - x0))));
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = "";
        delete document.body.dataset.czResizing;
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [value, min, max, sign, onChange],
  );
  return (
    <div
      onMouseDown={onMouseDown}
      title={t("common.resize")}
      className="absolute top-0 bottom-0 z-40 w-[6px] cursor-col-resize"
      style={side === "right" ? { right: -3 } : { left: -3 }}
    />
  );
}
