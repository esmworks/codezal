import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
}

/*
 * Ana eylem tasarımdaki gibi --tx zemin / --bg yazı: açık temada --acc'ten daha siyah, daha net
 * durur. Pasif hâl solma değil ayrı bir yüzey: opacity, koyu zemini çamur grisine çeviriyordu.
 * hover yalnızca `enabled:` ile, yoksa pasif düğme de imlece tepki veriyordu.
 */
const styles: Record<Variant, string> = {
  primary: "bg-tx font-medium text-bg enabled:hover:opacity-90 disabled:bg-chip disabled:text-tx3",
  secondary:
    "border border-line2 bg-card text-tx enabled:hover:bg-hov disabled:border-line disabled:text-tx3",
  ghost: "text-tx2 enabled:hover:bg-hov enabled:hover:text-tx disabled:text-tx3",
  danger: "border border-red text-red enabled:hover:bg-hov disabled:opacity-45",
};

export function Button({ variant = "secondary", size = "md", className = "", ...rest }: Props) {
  const pad =
    size === "sm"
      ? "h-[26px] rounded-[8px] px-[10px] text-[12px]"
      : size === "lg"
        ? "h-[34px] rounded-[10px] px-[15px] text-[14px]"
        : "h-[30px] rounded-[9px] px-[13px] text-[13px]";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-[7px] whitespace-nowrap transition-colors ${pad} ${styles[variant]} ${className}`}
      {...rest}
    />
  );
}
