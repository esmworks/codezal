import { createElement } from "react";
import { ICONS, type IconName } from "../icons";

interface Props {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
  fill?: boolean;
  style?: React.CSSProperties;
}

/**
 * Lucide geometrisini çizen ikon. Şekiller `icons.ts`'te ["etiket", öznitelik] çiftleri
 * olarak durur; tek path yerine çember ve dikdörtgen de çizilebildiği için yuvarlak
 * köşeler ve daireler bozulmadan görünür.
 */
export function Icon({ name, size = 14, stroke = 1.7, className, fill = false, style }: Props) {
  const shapes = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: `${tag}-${i}`, ...attrs }))}
    </svg>
  );
}
