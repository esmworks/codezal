import type { ContextUsage, Usage } from "@codezal/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPercent, formatTokens } from "../lib/format";
import { useLocale } from "../lib/i18n";

/**
 * Bağlam penceresi halkası: doluluk yüzdesi kadar dolan ince çember. %80 üstü amber, %95 üstü kırmızı.
 * Tıklayınca kullanılan / toplam token, doluluk çubuğu ve ortalama önbellek isabetini gösteren kutu açılır.
 * Yüzde metin olarak yazılmaz — composer'da halka yeter; değer tooltip'te ve açılır kutuda durur.
 * Kategori dökümü bilinçli olarak yok: Pi yalnızca toplamı verir, tahmin gösterilmez.
 */
export function ContextRing({
  usage,
  stats = null,
  size = 16,
  align = "left",
}: {
  usage: ContextUsage | null;
  /** Oturum toplam token kullanımı; önbellek isabeti için. */
  stats?: Usage | null;
  size?: number;
  /** Açılır kutunun halkaya göre hizası. */
  align?: "left" | "right";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const lang = useLocale();
  if (!usage || usage.contextWindow <= 0) return null;
  const pct = Math.min(100, Math.max(0, usage.percent));
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const tone = pct >= 95 ? "text-red" : pct >= 80 ? "text-amber" : "text-tx2";
  const bar = pct >= 95 ? "bg-red" : pct >= 80 ? "bg-amber" : "bg-acc";
  const used = formatTokens(usage.tokens, lang);
  const total = formatTokens(usage.contextWindow, lang);
  const cacheHit = cacheHitRate(stats);
  return (
    <span className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={t("context.title", { used, total, pct: Math.round(pct) })}
        aria-label={t("context.title", { used, total, pct: Math.round(pct) })}
        className={`flex items-center rounded-[6px] p-[3px] hover:bg-hov ${tone}`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth={2}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${(c * pct) / 100} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[120]" onClick={() => setOpen(false)} />
          <div
            className={`absolute bottom-[calc(100%+8px)] z-[121] flex w-[300px] flex-col gap-[10px] rounded-[10px] border border-line2 bg-card p-[12px] text-[12px] text-tx2 shadow-panel ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold text-[13px] text-tx">
                {t("context.heading")}
              </span>
              <span className={`font-mono ${tone}`}>
                {t("context.used", { used, total, pct: Math.round(pct) })}
              </span>
            </div>
            <div className="h-[6px] overflow-hidden rounded-full bg-chip">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center gap-2 border-line border-t pt-[10px]">
              <span className="flex-1">{t("context.cacheHit")}</span>
              <span className="font-mono text-tx">
                {cacheHit === null ? t("context.cacheNone") : formatPercent(cacheHit, lang, 1)}
              </span>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}

/** Önbellekten okunan girdinin tüm girdiye oranı; hiç girdi yoksa null. */
export function cacheHitRate(stats: Usage | null): number | null {
  if (!stats) return null;
  const total = stats.input + stats.cacheRead + stats.cacheWrite;
  if (total <= 0) return null;
  return (stats.cacheRead / total) * 100;
}
