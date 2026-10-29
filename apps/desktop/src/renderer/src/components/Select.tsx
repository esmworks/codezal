import type { IconName } from "../icons";
import { useMenu } from "../stores/menu";
import { Icon } from "./Icon";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  desc?: string;
  icon?: IconName;
}

interface Props<T extends string> {
  value: T | null;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** Seçim yokken gösterilen metin; soluk renkte çizilir. */
  placeholder?: string;
  /** Seçili seçeneğin ikonu yoksa tetikleyicide gösterilecek ikon. */
  icon?: IconName;
  /** `md` tasarımdaki 34px form denetimi; `sm` ayar satırlarındaki sıkı ölçü. */
  size?: "sm" | "md";
  width?: number;
  minMenuWidth?: number;
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}

/**
 * Uygulama geneli açılır seçim: tetikleyici düğme + `MenuLayer` menüsü. Yerel `<select>`
 * yerine kullanılır; menü pencere kenarına göre yön seçer ve uzun listelerde kaydırılır.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  icon,
  size = "md",
  width,
  minMenuWidth,
  disabled,
  mono,
  className = "",
}: Props<T>) {
  const openAt = useMenu((s) => s.openAt);
  const current = options.find((o) => o.value === value);
  const leading = current?.icon ?? icon;
  const dims =
    size === "md"
      ? "h-[34px] rounded-[10px] pl-[11px] pr-[9px] text-[14px]"
      : "h-[30px] rounded-[9px] pl-[10px] pr-[8px] text-[13px]";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) =>
        openAt(e.currentTarget, {
          minWidth: minMenuWidth ?? Math.max(160, width ?? 0),
          items: options.map((o) => ({
            label: o.label,
            ...(o.desc ? { desc: o.desc } : {}),
            ...(o.icon ? { icon: o.icon } : {}),
            check: o.value === value,
            active: o.value === value,
            onSelect: () => onChange(o.value),
          })),
        })
      }
      style={width ? { width } : undefined}
      className={`flex shrink-0 items-center gap-2 border border-line2 bg-card text-left hover:bg-hov disabled:opacity-40 ${dims} ${className}`}
    >
      {leading ? <Icon name={leading} size={14} className="text-tx2" /> : null}
      <span
        className={`min-w-0 flex-1 truncate ${current ? "text-tx" : "text-tx3"} ${mono ? "font-mono text-[12px]" : ""}`}
      >
        {current?.label ?? placeholder ?? ""}
      </span>
      <Icon name="chevronDown" size={size === "md" ? 14 : 12} stroke={1.8} className="text-tx3" />
    </button>
  );
}
