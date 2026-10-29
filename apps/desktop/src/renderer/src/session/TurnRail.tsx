import { type RefObject, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RAIL_STRIP_CLASS } from "../lib/floatPanel";
import type { TurnPreviewKind } from "../lib/turnPreview";

export interface RailItem {
  id: string;
  /** Kullanıcı mesajı sırası (1'den). */
  ordinal: number;
  /** Balonun ilk satırı: kullanıcı sorgusunun özeti. */
  userPreview: string;
  /** Balonun ikinci satırı: asistan yanıtının özeti ya da ikame metin. */
  assistantPreview: string;
  assistantPreviewKind: TurnPreviewKind;
}

interface Props {
  items: RailItem[];
  /** Transkriptin kaydırma kabı; öğeler `msg-<id>` kimlikleriyle onun içindedir. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * Mesaja atlama. Sanallaştırmada satır DOM'da olmadığı için transkript kendi yükseklik
   * modeliyle atlar; verilmezse aşağıdaki DOM yolu kullanılır.
   */
  onJump?: ((id: string) => void) | undefined;
}

/** Kaç kullanıcı mesajından sonra çubuk görünür; kısa sohbette gürültü olmasın. */
const MIN_ITEMS = 4;
/** Kaydırma kabının üst iç boşluğu; mesaja giderken bu kadar pay bırakılır. */
const TOP_PAD = 26;
/** Bir mesaj görünür alanın bu oranının üstüne çıkınca "etkin" sayılır. */
const ACTIVE_LINE = 0.35;

function messageTop(container: HTMLElement, id: string): number | undefined {
  const el = document.getElementById(`msg-${id}`);
  if (!el) return undefined;
  return (
    el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  );
}

/**
 * Tur çubuğu: sol kenarda her kullanıcı mesajı için bir çizgi. Üzerine gelince mesajın başı,
 * tıklayınca oraya kaydırma. Yalnızca en az dört mesajlı ve taşan sohbetlerde görünür.
 */
export function TurnRail({ items, scrollRef, onJump }: Props) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setVisible(items.length >= MIN_ITEMS && el.scrollHeight > el.clientHeight + 40);
    const line = el.scrollTop + el.clientHeight * ACTIVE_LINE;
    let current: string | null = items[0]?.id ?? null;
    for (const it of items) {
      const top = messageTop(el, it.id);
      if (top !== undefined && top <= line) current = it.id;
    }
    setActive(current);
  }, [items, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [update, scrollRef]);

  const jump = (id: string) => {
    // Sanallaştırmada hedef satır çizilmemiş olabilir: atlamayı transkript kendi modelinden yapar.
    if (onJump) {
      onJump(id);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const top = messageTop(el, id);
    if (top !== undefined) el.scrollTo({ top: Math.max(0, top - TOP_PAD), behavior: "smooth" });
  };

  const hovered = hover ? items.find((it) => it.id === hover) : undefined;
  const hoverIndex = hovered ? items.indexOf(hovered) : 0;

  if (!visible) return <div className={RAIL_STRIP_CLASS} />;
  const focusIndex = hovered ? hoverIndex : undefined;
  // Çizginin uzunluğu ve parlaklığı fareye olan uzaklığa göre: üzerindeki tam boy, komşuları
  // kademeli. ZCode'un tur gezgini de böyle ölçekler (2,6 / 1,7 / 1,25) ve `scaleX` kullanır —
  // genişlik değil dönüşüm olduğu için satırlar oynamaz.
  const visual = (index: number, active: boolean) => {
    if (focusIndex === undefined)
      return { scale: 1, opacity: active ? 0.95 : 0.58, strong: active };
    const distance = Math.abs(index - focusIndex);
    if (distance === 0) return { scale: 2.6, opacity: 1, strong: true };
    if (distance === 1) return { scale: 1.7, opacity: 0.86, strong: false };
    if (distance === 2) return { scale: 1.25, opacity: 0.72, strong: false };
    return { scale: 1, opacity: 0.58, strong: false };
  };

  return (
    // Çubuk sohbet kolonunun solundaki **kendi şeridinde** durur (ZCode'un tur gezgini gibi):
    // kaydırma kabının içinde mutlak konumla durduğunda çizgiler metnin üzerine biniyordu,
    // kolona hizalandığında ise kabın dışına taşıp kırpılıyordu. Şerit akışın parçasıdır ve
    // **dar**dır; çubuk kapalıyken de yer tutar ki sohbet kolonu kaymasın.
    <div className={`${RAIL_STRIP_CLASS} relative`}>
      {/* Çizgiler şeridin **dikey ortasında** durur (tepede dururken sohbetin ilk satırının
          hizasına düşüyordu) ve soldan 12px boşluk bırakır: kenar çubuğuna yapışmaz. */}
      <div className="flex h-full items-center pl-3">
        <div className="relative flex flex-col" onMouseLeave={() => setHover(null)}>
          {items.map((it, index) => {
            const v = visual(index, it.id === active);
            return (
              <button
                key={it.id}
                type="button"
                aria-label={t("transcript.railMessage", { n: it.ordinal })}
                onClick={() => jump(it.id)}
                onMouseEnter={() => setHover(it.id)}
                className="flex h-[10px] w-8 items-center"
              >
                <span
                  style={{ transform: `scaleX(${v.scale})`, opacity: v.opacity }}
                  className={`block h-[2px] w-[10px] origin-left rounded-full transition-[transform,opacity] duration-150 ${
                    v.strong ? "bg-tx" : "bg-tx3"
                  }`}
                />
              </button>
            );
          })}
          {hovered ? (
            <div
              className="pointer-events-none absolute left-[34px] w-80 rounded-[10px] border border-line2 bg-card px-[12px] py-[9px] shadow-home"
              style={{ top: hoverIndex * 10 - 8 }}
            >
              {/* ZCode'un tur gezgini gibi iki satır: kullanıcı sorgusu (medium) ve asistan
                  yanıtının özeti (soluk). İkame metinler (boş / sürüyor) daha da soluk kalır. */}
              <div className="space-y-2">
                <p className="line-clamp-2 whitespace-pre-line text-[12.5px] font-medium leading-5 text-tx">
                  {hovered.userPreview}
                </p>
                <p
                  className={`line-clamp-3 whitespace-pre-line text-[12.5px] leading-5 ${
                    hovered.assistantPreviewKind === "text" ? "text-tx2" : "text-tx3"
                  }`}
                >
                  {hovered.assistantPreview}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
