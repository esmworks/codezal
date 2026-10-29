import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { escapeClosesFind } from "../lib/escapeLayers";
import { MAX_FIND_MATCHES } from "../lib/transcriptFind";
import { useFind } from "../stores/find";

/**
 * Sohbet içi bulma çubuğu. Eşleşme hesabı ve atlama transkriptte durur; burada yalnız kutu,
 * sayaç ("3/12") ve önceki/sonraki/kapat düğmeleri var. Enter sonraki, Shift+Enter önceki,
 * Esc kapatır (odak kutudayken de dışındayken de).
 */
export function FindBar({
  current,
  total,
  onStep,
  right,
}: {
  /** Geçerli eşleşme (0'dan); eşleşme yoksa -1. */
  current: number;
  total: number;
  onStep: (delta: 1 | -1) => void;
  /** Sağ kenardan uzaklık (px): yüzen panel açıksa onun soluna yerleşir. */
  right: number;
}) {
  const { t } = useTranslation();
  const query = useFind((s) => s.query);
  const focusNonce = useFind((s) => s.focusNonce);
  const setQuery = useFind((s) => s.setQuery);
  const close = useFind((s) => s.close);
  const input = useRef<HTMLInputElement>(null);

  // ⌘F her basıldığında (çubuk zaten açık olsa da) kutu odaklanır ve metin seçilir.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tetikleyici sayaç, gövde okumaz
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  // Odak kutunun dışındayken de Esc çubuğu kapatır; üstte katman varsa önce o kapanır.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!escapeClosesFind(e)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const hasQuery = query.trim().length > 0;
  const totalLabel = total >= MAX_FIND_MATCHES ? `${MAX_FIND_MATCHES}+` : String(total);
  const counter = !hasQuery
    ? ""
    : total === 0
      ? t("find.none")
      : t("find.count", { current: current + 1, total: totalLabel });
  const iconBtn =
    "flex h-6 w-6 items-center justify-center rounded-[6px] text-tx3 hover:bg-hov hover:text-tx disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <search
      aria-label={t("find.label")}
      className="absolute top-2 z-20 flex w-[340px] max-w-[calc(100%-32px)] items-center gap-1 rounded-[10px] border border-line2 bg-card py-1 pr-1 pl-3 shadow-panel"
      style={{ right }}
    >
      <Icon name="search" size={14} className="shrink-0 text-tx3" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Çubuğu kapatan Esc oturum ekranına ulaşıp turu durdurmasın.
            e.preventDefault();
            close();
            return;
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder={t("find.placeholder")}
        aria-label={t("find.label")}
        className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-tx outline-none placeholder:text-tx3"
      />
      <span aria-live="polite" className="shrink-0 px-1 text-[12px] text-tx3 tabular-nums">
        {counter}
      </span>
      <button
        type="button"
        title={t("find.previous")}
        aria-label={t("find.previous")}
        disabled={total === 0}
        onClick={() => onStep(-1)}
        className={iconBtn}
      >
        <Icon name="chevronUp" size={14} />
      </button>
      <button
        type="button"
        title={t("find.next")}
        aria-label={t("find.next")}
        disabled={total === 0}
        onClick={() => onStep(1)}
        className={iconBtn}
      >
        <Icon name="chevronDown" size={14} />
      </button>
      <button
        type="button"
        title={t("find.close")}
        aria-label={t("find.close")}
        onClick={close}
        className={iconBtn}
      >
        <Icon name="x" size={14} />
      </button>
    </search>
  );
}
