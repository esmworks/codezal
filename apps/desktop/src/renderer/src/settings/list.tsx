import type { ReactNode } from "react";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";

/**
 * Liste tarzı ayar sayfalarının (Beceriler, Servisler) ortak parçaları: üst sekmeler ve arama,
 * sayaçlı bölüm başlığı, tek kart içinde satırlar, rozetler, kesikli boş durum.
 */

/**
 * Süzgeç hapları (ör. katalog kategorileri). Sayfayı bölen sekmeler için `SegmentedTabs`. Seçili
 * hap çerçeve alır: açık temada `--sel` beyaz, beyaz sayfada zeminle ayrılmıyordu.
 */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: ReadonlyArray<{ key: T; label: string; count?: number }>;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {items.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`flex shrink-0 items-center gap-[5px] rounded-full px-[10px] py-[5px] text-[13px] transition-colors ${
            value === tab.key
              ? "bg-sel font-medium text-tx shadow-[var(--selSh)] ring-1 ring-line ring-inset"
              : "text-tx2 hover:bg-hov hover:text-tx"
          }`}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="text-[11px] text-tx3">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Sayfayı ikiye bölen üst düzey sekmeler (ör. Bağlı / Hazır). `Tabs` süzgeç haplarıdır; açık temada
 * seçili hap beyaz sayfada kayboluyordu. Burada seçili parça gri zeminden kalkar.
 */
export function SegmentedTabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: ReadonlyArray<{ key: T; label: string; count?: number }>;
  onChange: (key: T) => void;
}) {
  // Toplam 28px: yanındaki arama kutusu ve küçük düğmelerle aynı yükseklik.
  return (
    <div
      role="tablist"
      className="flex shrink-0 items-center gap-[2px] rounded-[9px] bg-chip p-[2px]"
    >
      {items.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={`flex h-[24px] items-center gap-[6px] rounded-[7px] px-[10px] text-[13px] transition-colors ${
            value === tab.key
              ? "bg-sel font-medium text-tx shadow-[var(--selSh)]"
              : "text-tx2 hover:text-tx"
          }`}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="text-[11.5px] font-normal text-tx3">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex h-[28px] w-[190px] shrink-0 items-center gap-2 rounded-[8px] border border-line2 bg-card px-[10px] text-[13px] text-tx3">
      <Icon name="search" size={13} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-tx outline-none placeholder:text-tx3"
      />
    </div>
  );
}

/** Sekmeler solda, arama sağda: sayfanın üst şeridi. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3">{children}</div>;
}

/** Bölüm başlığı: ad, soluk sayaç, isteğe bağlı açıklama ve sağda eylemler. */
export function SectionHead({
  title,
  count,
  desc,
  actions,
}: {
  title: string;
  count?: number;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[15px] font-semibold">
          <span>{title}</span>
          {count !== undefined ? (
            <span className="text-[13px] font-normal text-tx3">{count}</span>
          ) : null}
        </div>
        {desc ? <div className="pt-[2px] text-[13px] text-tx3">{desc}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[12px]">{children}</div>;
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-card2">{children}</div>
  );
}

/** Kart içinde soluk, büyük harfli grup ayracı. */
export function GroupLabel({ label, first }: { label: string; first: boolean }) {
  return (
    <div
      className={`bg-bg2 px-[18px] py-[7px] text-[11px] font-medium uppercase tracking-[0.06em] text-tx3 ${
        first ? "" : "border-t border-line"
      }`}
    >
      {label}
    </div>
  );
}

/** Marka logosu olmayan satırlar için ikonlu kare döşeme. */
export function IconTile({ name, size = 40 }: { name: IconName; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[10px] border border-line bg-chip text-tx2"
      style={{ width: size, height: size }}
    >
      <Icon name={name} size={Math.round(size * 0.45)} />
    </span>
  );
}

/** Rozet: ikonlu, yuvarlak, okunur kontrastta (ZCode'daki "User default" gibi). */
export function Chip({
  icon,
  children,
  title,
  dot,
}: {
  icon?: IconName;
  children: ReactNode;
  title?: string;
  dot?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-[5px] rounded-full border border-line bg-chip px-[8px] py-[2px] text-[11px] font-medium leading-[16px] text-tx2"
    >
      {dot ? <span className={`h-[6px] w-[6px] rounded-full ${dot}`} /> : null}
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

/** Tek liste satırı: sol döşeme, başlık, tek satır açıklama, rozet satırı, sağda eylemler. */
export function ListRow({
  first,
  logo,
  title,
  desc,
  meta,
  actions,
  dim,
  children,
}: {
  first: boolean;
  logo: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  meta?: ReactNode;
  actions: ReactNode;
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`px-[18px] py-[13px] ${first ? "" : "border-t border-line"}`}>
      <div className={`flex items-center gap-[14px] ${dim ? "opacity-60" : ""}`}>
        {logo}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium">{title}</div>
          {desc ? (
            <div className="truncate pt-[2px] text-[13px] leading-[1.45] text-tx3">{desc}</div>
          ) : null}
          {meta ? <div className="flex min-w-0 items-center gap-2 pt-[6px]">{meta}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function IconButton({
  name,
  title,
  onClick,
  disabled,
  spin,
  danger,
  ghost,
}: {
  name: IconName;
  title: string;
  /** Olay, menü açan düğmelerin kendini tutunma noktası olarak vermesi için geçer. */
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  spin?: boolean;
  danger?: boolean;
  /** Çerçevesiz: satır içi ikincil eylemler (⋯ menüsü) satırı kalabalıklaştırmasın. */
  ghost?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] hover:bg-hov disabled:opacity-40 ${
        ghost ? "" : "border border-line2 bg-card"
      } ${danger ? "text-tx3 hover:text-red" : "text-tx2 hover:text-tx"}`}
    >
      <Icon name={name} size={14} className={spin ? "animate-spin" : ""} />
    </button>
  );
}

export function EmptyState({
  title,
  desc,
  action,
  onAction,
}: {
  title: string;
  desc?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-[6px] rounded-[14px] border border-dashed border-line2 px-6 py-9 text-center">
      <div className="text-[14px] font-semibold">{title}</div>
      {desc ? (
        <div className="max-w-[420px] text-[13px] leading-[1.45] text-tx3">{desc}</div>
      ) : null}
      {action && onAction ? (
        <Button variant="primary" className="mt-3" onClick={onAction}>
          <Icon name="plus" size={14} />
          {action}
        </Button>
      ) : null}
    </div>
  );
}

/** Kart içi kısa bilgi satırı (yükleniyor, eşleşme yok vb.). */
export function Note({ children }: { children: ReactNode }) {
  return <div className="px-1 py-2 text-[13px] text-tx3">{children}</div>;
}
