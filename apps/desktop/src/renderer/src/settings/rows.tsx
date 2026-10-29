import type { ReactNode } from "react";
import { Select } from "../components/Select";
import { Toggle } from "../components/Toggle";

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[11px]">
      {title ? <div className="text-[13px] font-semibold text-tx2">{title}</div> : null}
      <div className="overflow-hidden rounded-[14px] border border-line bg-card2">{children}</div>
    </div>
  );
}

export function Row({
  label,
  desc,
  children,
  first,
}: {
  label: ReactNode;
  desc?: ReactNode | undefined;
  children?: ReactNode;
  first?: boolean | undefined;
}) {
  return (
    <div
      className={`flex items-center gap-5 px-[18px] py-[14px] ${first ? "" : "border-t border-line"}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {desc ? <div className="pt-[2px] text-[13px] leading-[1.45] text-tx3">{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function ToggleRow({
  label,
  desc,
  on,
  onChange,
  first,
  disabled,
}: {
  label: string;
  desc?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  first?: boolean;
  disabled?: boolean;
}) {
  return (
    <Row label={label} desc={desc} first={first}>
      <Toggle on={on} onChange={onChange} {...(disabled ? { disabled } : {})} />
    </Row>
  );
}

export function SelectRow<T extends string>({
  label,
  desc,
  value,
  options,
  onChange,
  first,
}: {
  label: string;
  desc?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  first?: boolean;
}) {
  return (
    <Row label={label} desc={desc} first={first}>
      <Select size="sm" value={value} options={options} onChange={onChange} />
    </Row>
  );
}

export function ButtonRow({
  label,
  desc,
  value,
  onClick,
  danger,
  first,
  disabled,
  extra,
}: {
  label: ReactNode;
  desc?: ReactNode;
  value: string;
  onClick: () => void;
  danger?: boolean;
  first?: boolean;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  return (
    <Row label={label} desc={desc} first={first}>
      {extra}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`shrink-0 rounded-[9px] border px-[13px] py-[6px] text-[13px] hover:bg-hov disabled:opacity-40 ${
          danger ? "border-red text-red" : "border-line2 text-tx"
        }`}
      >
        {value}
      </button>
    </Row>
  );
}

export function InputRow({
  label,
  desc,
  value,
  onChange,
  placeholder,
  first,
  mono,
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  first?: boolean;
  mono?: boolean;
}) {
  return (
    <Row label={label} desc={desc} first={first}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={`w-[260px] shrink-0 rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] text-[13px] text-tx outline-none placeholder:text-tx3 ${mono ? "font-mono text-[12px]" : ""}`}
      />
    </Row>
  );
}

export function Keys({ keys }: { keys: string[] }) {
  return (
    <div className="flex shrink-0 gap-[5px]">
      {keys.map((k) => (
        <span
          key={k}
          className="rounded-[6px] border border-line2 bg-card px-[7px] py-[2px] font-mono text-[12px] text-tx2"
        >
          {k}
        </span>
      ))}
    </div>
  );
}

export function Bar({ pct, value }: { pct: number; value: string }) {
  return (
    <div className="flex w-[200px] shrink-0 items-center gap-[10px]">
      <span className="h-[7px] flex-1 overflow-hidden rounded-[4px] bg-chip">
        <span
          className="block h-[7px] rounded-[4px] bg-tx3 opacity-50"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="font-mono text-[12px] text-tx2">{value}</span>
    </div>
  );
}
