import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type MenuPos, menuPos } from "../lib/menuPos";
import { type MenuEntry, type MenuItem, useMenu } from "../stores/menu";
import { Icon } from "./Icon";

const MONO = "font-mono text-[12px]";

function isLabel(e: MenuEntry): e is { label: string; isLabel: true } {
  return "isLabel" in e && e.isLabel === true;
}

function Row({
  item,
  onHover,
  hovered,
}: {
  item: MenuItem;
  onHover?: () => void;
  hovered?: boolean;
}) {
  const cls = [
    "flex items-center gap-[9px] rounded-[6px] px-[9px] text-[13px] select-none",
    item.desc ? "py-[7px]" : "py-[6px]",
    item.danger ? "text-red" : "text-tx",
    item.active || hovered ? "bg-chip" : "",
    item.disabled ? "opacity-40" : "hover:bg-hov",
    item.top ? "mt-1 border-t border-line pt-[9px] rounded-t-none" : "",
  ].join(" ");
  return (
    <div
      className={cls}
      onMouseEnter={onHover}
      onClick={() => {
        if (item.disabled) return;
        item.onSelect?.();
        if (!item.sub) useMenu.getState().close();
      }}
    >
      {item.iconSrc ? (
        <img
          src={item.iconSrc}
          alt=""
          draggable={false}
          className={`h-[15px] w-[15px] shrink-0 object-contain ${item.desc ? "self-start mt-[2px]" : ""}`}
        />
      ) : item.icon ? (
        <Icon
          name={item.icon}
          size={14}
          className={`text-tx2 ${item.desc ? "self-start mt-[2px]" : ""}`}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{item.label}</span>
        {item.desc ? <span className="truncate text-[12px] text-tx3">{item.desc}</span> : null}
      </div>
      {item.check ? (
        <span className="text-[13px] text-tx2">✓</span>
      ) : item.sub ? (
        <span className="text-[13px] text-tx2">›</span>
      ) : item.key ? (
        <span className={`${MONO} text-tx3`}>{item.key}</span>
      ) : null}
    </div>
  );
}

/**
 * Bağlam menüsü katmanı: tek menü + isteğe bağlı alt menü, dışarı tıklayınca kapanır.
 * Modalın (z-130) üstünde durur: form modallarındaki Select ve çipler de bu katmanı kullanır.
 */
export function MenuLayer() {
  const open = useMenu((s) => s.open);
  const close = useMenu((s) => s.close);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);

  // Yerleşim çizimden önce ölçülür: açıklamalı satırlar iki satırlık olduğundan satır
  // sayısından yükseklik tahmin etmek yanılıyor ve menünün alt ucu pencere dışında kalıyordu.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) {
      setPos(null);
      return;
    }
    setPos(
      menuPos(
        open.anchor,
        { width: el.offsetWidth, height: el.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: menü değişince alt menüyü sıfırla
  useEffect(() => {
    setSubIdx(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc yalnız menüyü kapatır: alttaki modal/Ayarlar/oturum dinleyicileri bunu görüp durur.
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const { spec } = open;
  const width = spec.minWidth ?? 200;
  const subItem = subIdx !== null ? spec.items[subIdx] : undefined;
  const sub = subItem && !isLabel(subItem) ? subItem.sub : undefined;

  return (
    <>
      <div
        className="fixed inset-0 z-[140]"
        onMouseDown={close}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={ref}
        className="fixed z-[141] flex flex-col gap-[1px] overflow-y-auto rounded-[10px] border border-line2 bg-card p-[5px] shadow-panel"
        style={{
          // Ölçüm çizimden önce bittiği için ham konum ekrana yansımaz; yalnızca yedektir.
          left: pos?.left ?? open.anchor.left,
          top: pos?.top ?? open.anchor.bottom + 4,
          minWidth: width,
          ...(pos ? { maxHeight: pos.maxHeight } : {}),
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {spec.search ? (
          <div className="flex items-center gap-2 px-[9px] py-[6px] text-[13px] text-tx3">
            <Icon name="search" size={13} />
            {spec.search}
          </div>
        ) : null}
        {spec.items.map((e, i) =>
          isLabel(e) ? (
            <div
              key={`l-${e.label}`}
              className="px-[9px] pt-[7px] pb-[3px] text-[11px] uppercase tracking-[0.06em] text-tx3"
            >
              {e.label}
            </div>
          ) : (
            <Row
              key={`${e.label}-${i}`}
              item={e}
              hovered={subIdx === i}
              onHover={() => setSubIdx(e.sub ? i : null)}
            />
          ),
        )}
      </div>
      {sub ? (
        <div
          className="fixed z-[142] flex min-w-[186px] flex-col gap-[1px] rounded-[10px] border border-line2 bg-card p-[5px] shadow-panel"
          style={{
            left: (pos?.left ?? 0) + width - 6,
            top: (pos?.top ?? 0) + 4 + (subIdx ?? 0) * 28,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sub.map((e, i) => (
            <Row key={`${e.label}-${i}`} item={e} />
          ))}
        </div>
      ) : null}
    </>
  );
}
