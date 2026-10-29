import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Tasarım kaynağındaki onay kutusu: 16px kutu, işaretliyken tx zemin ve onAcc tik.
 * Gerçek `<input type="checkbox">` görünmez durur; klavye ve erişilebilirlik ondan gelir.
 */
export function Checkbox({ checked, onChange, label, disabled, className = "" }: Props) {
  return (
    <label
      className={`flex items-center gap-[9px] text-[13px] text-tx ${disabled ? "opacity-40" : "cursor-default"} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
          checked ? "border-tx bg-tx" : "border-line2 bg-card"
        }`}
      >
        {checked ? <Icon name="check" size={11} stroke={3} className="text-onAcc" /> : null}
      </span>
      {label ? <span className="min-w-0">{label}</span> : null}
    </label>
  );
}
