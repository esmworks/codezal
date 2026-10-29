import { Icon } from "../components/Icon";
import type { IconName } from "../icons";

/** Ana ekranlardaki tek bir öneri: ikon, kısa etiket, ipucu ve gönderilecek metin. */
export interface Suggestion {
  icon: IconName;
  label: string;
  /** Üzerine gelince görünen açıklama. */
  hint: string;
  /** Boşsa ekran kendi davranışını uygular (ör. yazma kutusunu temizler). */
  text: string;
}

/**
 * Ana ekranlardaki yazma kutusunun kabı. Gölge burada durur: şerit ve kutu tek siluet
 * olarak yükselir, aralarında gölge izi kalmaz.
 */
export function HomeBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[16px] shadow-home">{children}</div>;
}

/**
 * Yazma kutusunun üstündeki gri şerit: bağlam çipleri (proje, dal, konum) burada durur.
 * Alt kenarı kutunun arkasına girer, böylece gri yalnızca üstte görünür.
 */
export function HomeTray({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mb-[14px] flex items-center gap-2 rounded-t-[16px] bg-tray px-4 pt-[10px] pb-[24px]">
      {children}
    </div>
  );
}

/** Yazma kutusunun altındaki öneri hapları. Tek satır, taşarsa alta sarar. */
export function Suggestions({
  items,
  onPick,
}: {
  items: readonly Suggestion[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-[8px] pt-[18px]">
      {items.map((s) => (
        <button
          type="button"
          key={s.label}
          title={s.hint}
          onClick={() => onPick(s.text)}
          className="flex items-center gap-[7px] rounded-full border border-line px-[13px] py-[7px] text-[13px] text-tx hover:border-line2 hover:bg-hov"
        >
          <Icon name={s.icon} size={14} className="text-tx2" />
          {s.label}
        </button>
      ))}
    </div>
  );
}
