import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";

/** Menünün seçimden uzaklığı ve pencere kenarından en az payı. */
const GAP = 6;
const EDGE = 8;
/** Menünün yaklaşık yüksekliği; seçimin üstüne sığmazsa altına açılır. */
const HEIGHT = 32;

interface Anchor {
  text: string;
  x: number;
  y: number;
}

/** Düğümün içinde durduğu alıntılanabilir blok (asistan metni); kök dışındaysa `null`. */
function quotableOf(node: Node, root: HTMLElement): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  const block = el?.closest("[data-quotable]") ?? null;
  return block && root.contains(block) ? block : null;
}

/**
 * Seçim geçerliyse menünün konumu. Seçimin iki ucu da **aynı** asistan metninde olmalı: araya
 * kullanıcı balonu ya da araç satırı girerse alıntı modelin yazmadığı metni de taşırdı.
 */
function readAnchor(root: HTMLElement): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const block = quotableOf(range.startContainer, root);
  if (!block || block !== quotableOf(range.endContainer, root)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rects = range.getClientRects();
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  // Seçimin ilk satırının üstü; başlık şeridine taşarsa son satırın altı.
  const above = first.top - GAP - HEIGHT;
  const y = above >= EDGE ? above : last.bottom + GAP;
  return { text, x: first.left, y };
}

/**
 * Asistan metninde seçim yapılınca üstünde açılan küçük menü: "Yanıtla" seçili metni yazma
 * kutusuna alıntı olarak ekler. Konum sabit (`fixed`) ve belgeye taşınır: sanallaştırılmış satırlar
 * dönüşüm taşıyabilir, `fixed` onların içinde pencereye göre konumlanmazdı.
 */
export function SelectionReply({
  root,
  onReply,
  onSideChat,
}: {
  root: RefObject<HTMLElement | null>;
  onReply: (text: string) => void;
  /** Verilirse menünün başında "Yan sohbet" de çıkar; yan sohbetin kendi panelinde verilmez. */
  onSideChat?: ((text: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Seçim fare bırakıldıktan sonra kesinleşir (çift/üçlü tıklama dahil); bir kare beklenir.
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAnchor(readAnchor(el)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") read();
    };
    // Seçim kalkınca menü de kalkar; yeni seçim sürerken (sürükleme) menü açılmaz.
    const onChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setAnchor(null);
    };
    // Kaydırmada seçim yerinde kalır ama ekrandaki yeri değişir: konum yeniden okunur.
    const onScroll = () => setAnchor((cur) => (cur ? readAnchor(el) : cur));
    // Fare kolonun dışında (kenar boşluğunda) bırakılabilir; bırakma belgeden dinlenir, seçimin
    // kolona ait olup olmadığına `readAnchor` bakar.
    document.addEventListener("mouseup", read);
    el.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mouseup", read);
      el.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [root]);

  if (!anchor) return null;
  const left = Math.max(EDGE, Math.min(anchor.x, window.innerWidth - (onSideChat ? 220 : 120)));
  const pick = (act: (text: string) => void) => () => {
    act(anchor.text);
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };
  const btn =
    "flex items-center gap-[6px] rounded-[6px] px-2 py-[4px] text-[12.5px] text-tx hover:bg-hov";
  return createPortal(
    <div
      role="toolbar"
      className="fixed z-[130] flex rounded-[8px] border border-line2 bg-card p-[3px] shadow-panel"
      style={{ left, top: anchor.y }}
      // Tıklama seçimi bozmasın: odak düğmeye geçerse seçim kalkar ve menü kapanırdı.
      onMouseDown={(e) => e.preventDefault()}
    >
      {onSideChat ? (
        <button
          type="button"
          title={t("transcript.sideChatTitle")}
          onClick={pick(onSideChat)}
          className={btn}
        >
          <Icon name="chat" size={13} stroke={1.8} className="text-tx2" />
          {t("transcript.sideChat")}
        </button>
      ) : null}
      <button
        type="button"
        title={t("transcript.replyTitle")}
        onClick={pick(onReply)}
        className={btn}
      >
        <Icon name="reply" size={13} stroke={1.8} className="text-tx2" />
        {t("transcript.reply")}
      </button>
    </div>,
    document.body,
  );
}
