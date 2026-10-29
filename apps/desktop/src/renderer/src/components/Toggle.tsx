interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ on, onChange, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px] transition-colors ${
        on ? "justify-end bg-tx" : "justify-start bg-line2"
      } ${disabled ? "opacity-40" : ""}`}
    >
      <span className="h-[18px] w-[18px] rounded-full bg-bg shadow-[0_1px_2px_rgba(0,0,0,0.2)]" />
    </button>
  );
}
