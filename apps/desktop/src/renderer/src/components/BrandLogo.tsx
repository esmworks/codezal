interface Props {
  size?: number;
  className?: string;
}

/**
 * Codezal logosu (C işareti). Koyu temada beyaz, açık temada siyah sürüm gösterilir; iki
 * görsel de yüklenir, tema `body[data-cz-light]` ile hangisinin görüneceğini seçer.
 */
export function BrandLogo({ size = 96, className }: Props) {
  return (
    <div className={className} style={{ width: size, height: size }} aria-hidden="true">
      <img
        src="./brand/glyph-light.png"
        alt=""
        width={size}
        height={size}
        draggable={false}
        className="block [body[data-cz-light]_&]:hidden"
      />
      <img
        src="./brand/glyph-dark.png"
        alt=""
        width={size}
        height={size}
        draggable={false}
        className="hidden [body[data-cz-light]_&]:block"
      />
    </div>
  );
}
