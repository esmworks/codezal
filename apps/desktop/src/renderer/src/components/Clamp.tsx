import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { clampText } from "../lib/clamp";
import { Icon } from "./Icon";

/** Katlanmış içeriğin alt kenarını söndüren geçiş yüksekliği (px). */
const FADE = 40;

/**
 * Katlanmış önizlemenin en büyük yüksekliği (px). Satır sınırı sarılan uzun satırları saymaz:
 * yapıştırılmış günlük ya da çıktı, satır sınırında kalsa bile sarmayla ekranı kaplıyordu.
 */
const PREVIEW_MAX_H = 300;

/**
 * Maske ile söndürme: önizlemenin altı kırpılmış gibi değil, devamı varmış gibi görünür.
 * Renk yerine maske kullanıldığı için kart, balon, kod bloğu — her yüzeyde çalışır.
 * `maxHeight` verilirse önizleme o yükseklikte kırpılır; maske kırpmayı kırpık göstermez.
 */
function fadeStyle(open: boolean, maxHeight?: number): CSSProperties | undefined {
  if (open) return undefined;
  const mask = `linear-gradient(to bottom, #000 calc(100% - ${FADE}px), transparent)`;
  const style: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };
  if (maxHeight !== undefined) {
    style.maxHeight = maxHeight;
    style.overflow = "hidden";
  }
  return style;
}

/** Katlanmış içeriğin altını yumuşakça söndüren sarmalayıcı; `open` iken maske uygulanmaz. */
export function ClampFade({
  open,
  maxHeight,
  children,
}: {
  open: boolean;
  maxHeight?: number;
  children: ReactNode;
}) {
  return <div style={fadeStyle(open, maxHeight)}>{children}</div>;
}

/** "Tümünü göster (N satır)" / "Daralt" düğmesi; sayaç 0 ise satır bilgisi yazılmaz. */
export function ClampToggle({
  open,
  count,
  onClick,
}: {
  open: boolean;
  count: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = open
    ? t("transcript.collapseText")
    : count > 0
      ? t("transcript.showAllLines", { count })
      : t("transcript.showAll");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="mx-auto flex items-center gap-[4px] rounded-[6px] px-[8px] py-[3px] text-[12px] text-tx3 hover:bg-hov hover:text-tx"
    >
      <Icon
        name="chevronDown"
        size={11}
        stroke={2}
        className="transition-transform"
        style={{ transform: open ? "rotate(180deg)" : undefined }}
      />
      {label}
    </button>
  );
}

interface ClampProps {
  text: string;
  /** Önizlemede gösterilecek en çok satır (varsayılan 12). */
  lines?: number;
  /** Tek uzun satır için önizleme karakter sınırı (varsayılan 900). */
  chars?: number;
  /** Düz metin yerine özel çizim: görünen metni alır (kod bloğu gibi). */
  render?: (visible: string) => ReactNode;
  /** `render` yokken metnin sınıfları. */
  className?: string;
}

/**
 * Uzun yapıştırılmış metni katlar: kısa metin olduğu gibi, uzun metin önizleme + düğme.
 * Kullanıcı düğmeye basınca tam metin açılır, "Daralt" ile yeniden kapanır.
 */
export function Clamp({ text, lines, chars, render, className = "" }: ClampProps) {
  const [open, setOpen] = useState(false);
  const clamp = useMemo(() => clampText(text, { lines, chars }), [text, lines, chars]);
  const visible = open ? text : clamp.preview;
  const body = render ? render(visible) : <div className={className}>{visible}</div>;
  if (!clamp.clamped) return <>{body}</>;
  return (
    <div className="flex min-w-0 flex-col">
      <ClampFade open={open} maxHeight={PREVIEW_MAX_H}>
        {body}
      </ClampFade>
      <div className="mt-[2px] flex justify-center">
        <ClampToggle open={open} count={clamp.hiddenLines} onClick={() => setOpen((v) => !v)} />
      </div>
    </div>
  );
}
