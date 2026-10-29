import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import type { SlashSuggestion } from "../../lib/slashSearch";

export interface SlashSection {
  id: string;
  title: string;
  items: SlashSuggestion[];
}

/**
 * `/` paneli (ZCode'un `MentionPanel`'i): bölüm başlıkları, satırda yalnız `/ad` ve soluk açıklama,
 * sorgu yokken altta arama ipucu. Ayrı kart değil, yazma kutusunun üst uzantısıdır: alt kenarı
 * açıktır ve kutunun yan çizgileriyle birleşir (Command Code'daki gibi tek kart). Liste kısa tutulur (en çok ~7 satır) ki sohbeti örtmesin; seçili
 * satır klavyeyle gezilirken görünür alana kaydırılır. Satırlar `mousedown`da seçer: `click`
 * beklenirse editör odağı kaybeder ve panel seçimden önce kapanır.
 */
export function SlashPanel({
  sections,
  selected,
  query,
  onPick,
  onHover,
}: {
  sections: SlashSection[];
  /** Bütün bölümler boyunca düz sıra. */
  selected: number;
  query: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const visible = sections.filter((s) => s.items.length > 0);
  // Tek bölüm kaldıysa başlık gürültü olur (ZCode da tek bölümde başlık çizmez).
  const titled = visible.length > 1;

  // Yalnız liste kaydırılır: `scrollIntoView` kırpılmış ata kutuları da (açılış animasyonundaki
  // `overflow: hidden` sarmalayıcı, ekran düzeni) kaydırıyor, panelin üstü kesik görünüyordu.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-slash-index="${selected}"]`);
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [selected]);

  let index = 0;
  return (
    <div className="overflow-hidden rounded-t-[16px] border border-b-0 border-line2 bg-card">
      {visible.length > 0 ? (
        <div
          ref={listRef}
          role="listbox"
          aria-label={t("composer.slash.title")}
          className="relative max-h-[252px] overflow-y-auto px-[5px] py-[4px]"
        >
          {visible.map((section) => (
            <div key={section.id}>
              {titled ? (
                <div className="flex h-8 items-center px-[10px] text-[11px] font-medium uppercase tracking-[0.06em] text-tx3">
                  {section.title}
                </div>
              ) : null}
              {section.items.map((item) => {
                const at = index++;
                const active = at === selected;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-slash-index={at}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(at);
                    }}
                    onMouseEnter={() => onHover(at)}
                    className={`flex h-8 w-full items-center gap-3 rounded-[8px] px-[10px] text-left ${
                      active ? "bg-sel" : ""
                    }`}
                  >
                    <span className="max-w-[40%] shrink-0 truncate text-[13px] font-medium text-tx">
                      {item.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-tx3">
                      {item.description}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-3 text-[13px] text-tx3">{t("composer.slash.empty")}</div>
      )}
      {query.trim() === "" ? (
        <div className="flex items-center gap-2 border-t border-line px-4 py-[10px] text-[12px] text-tx3">
          <Icon name="info" size={13} className="text-tx2" />
          <span>{t("composer.slash.hint")}</span>
        </div>
      ) : null}
    </div>
  );
}
