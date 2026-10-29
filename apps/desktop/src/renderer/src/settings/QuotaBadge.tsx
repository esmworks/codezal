import type { ProviderQuota, QuotaWindow } from "@codezal/contracts";
import type { Locale } from "@codezal/i18n";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { formatPercent, formatTokens, sep } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { Chip } from "./list";

/** Pencere etiketleri; sözleşmedeki `id` ile birebir. */
const WINDOW_LABEL = {
  rolling: "settings.quota.windowRolling",
  fiveHour: "settings.quota.windowFiveHour",
  weekly: "settings.quota.windowWeekly",
  monthly: "settings.quota.windowMonthly",
} as const;

/**
 * Rozet rengi: hata ve tükenmiş bakiye kırmızı, anahtar sorunu amber, pencere doluluğu kendi
 * eşikleriyle, kredi azaldıysa kalan orana göre renklenir. Veri yokken nötr kalır.
 */
export function badgeTone(quota: ProviderQuota | undefined, peak: QuotaWindow | undefined): string {
  if (!quota) return "bg-tx3";
  if (quota.state === "error") return "bg-red";
  if (quota.state === "unauthenticated") return "bg-amber";
  if (quota.state !== "ok") return "bg-tx3";
  // Kredisi bitmiş hesap (ör. DeepSeek bakiyesi negatif) sessizce yeşil görünmemeli.
  if (quota.balance?.usable === false) return "bg-red";
  if (peak) return toneClass(peak.percent);
  if (quota.credit?.cap) return creditTone(quota.credit.remaining / quota.credit.cap);
  return "bg-tx3";
}

/** Kalan kredi oranı: bol kredi yeşil, azaldıkça amber, bitmeye yakınken kırmızı. */
function creditTone(leftRatio: number): string {
  if (leftRatio <= 0.1) return "bg-red";
  if (leftRatio <= 0.25) return "bg-amber";
  return "bg-green";
}

export function peakOf(quota: ProviderQuota | undefined): QuotaWindow | undefined {
  return quota?.windows.reduce<QuotaWindow | undefined>(
    (best, w) => (best === undefined || w.percent > best.percent ? w : best),
    undefined,
  );
}

/** Doluluk yüzdesi rengi: yeşil < %50, amber < %80, kırmızı ≥ %80. */
export function toneClass(percent: number): string {
  if (percent >= 80) return "bg-red";
  if (percent >= 50) return "bg-amber";
  return "bg-green";
}

/** Pencere etiketi: sağlayıcı kendi adını verdiyse (ör. MCP) o, yoksa id'den çevrilen ad. */
export function windowLabel(window: QuotaWindow, t: TFunction): string {
  return window.label ?? t(WINDOW_LABEL[window.id]);
}

/**
 * Ondalıklı kredi sayısını okunur kısaltır: 65.33 → "65,3" (tr) / "65.3" (en).
 *
 * Ayraç yerel ayara uyar: `toFixed` her zaman nokta üretir ve aynı ekranda Kullanım sayfası
 * virgülle yazarken burada nokta görünürdü.
 */
export function formatCredit(value: number, locale: Locale): string {
  const text = value >= 100 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1);
  return text.replace(".", sep(locale));
}

export function formatAmount(value: number, locale: Locale): string {
  return value.toFixed(2).replace(".", sep(locale));
}

/** Sıfırlanma zamanı: bugünse saat, başka günse gün + saat. */
export function resetTime(ms: number, lang: string): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(lang, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function dayOf(ms: number, lang: string): string {
  return new Date(ms).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
}

/** Satır içi kota rozeti; tıklayınca ayrıntı paneli açılır. */
export function QuotaBadge({
  quota,
  open,
  onToggle,
}: {
  quota: ProviderQuota | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const peak = peakOf(quota);
  const dot = badgeTone(quota, peak);
  const text = badgeLabel(t, quota, peak, locale);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t(open ? "settings.quota.closeDetail" : "settings.quota.openDetail")}
      title={text}
      className="cursor-pointer rounded-full focus-visible:outline focus-visible:outline-1 focus-visible:outline-line2"
    >
      <Chip dot={dot}>{text}</Chip>
    </button>
  );
}

/** Rozet metni: durum > en dolu pencere > kredi > bakiye. */
export function badgeLabel(
  t: TFunction,
  quota: ProviderQuota | undefined,
  peak: QuotaWindow | undefined,
  locale: Locale,
): string {
  if (!quota) return t("settings.quota.badgeLoading");
  if (quota.state === "unsupported") return t("settings.quota.badgeUnsupported");
  if (quota.state === "unauthenticated") return t("settings.quota.needsConnect");
  if (quota.state === "error") return t("settings.quota.badgeUnavailable");
  if (peak) return `${formatPercent(peak.percent, locale)} · ${windowLabel(peak, t)}`;
  if (quota.credit) {
    return `${formatCredit(quota.credit.remaining, locale)} ${t("settings.quota.creditRemaining")}`;
  }
  if (quota.balance) {
    return `${formatAmount(quota.balance.amount, locale)} ${quota.balance.currency}`;
  }
  return t("settings.quota.badgeUnavailable");
}

/** Kota ayrıntısı: pencereler, kredi/bakiye, plan ve tazelik. */
export function QuotaPanel({
  quota,
  busy,
  onRefresh,
}: {
  quota: ProviderQuota | undefined;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const locale = useLocale();
  const rows: { label: string; value: string }[] = [];
  if (quota?.plan) rows.push({ label: t("settings.quota.plan"), value: quota.plan });
  if (quota?.credit) {
    const cap = quota.credit.cap;
    const suffix = cap === undefined ? "" : ` / ${formatCredit(cap, locale)}`;
    const estimate = quota.credit.capEstimated ? ` (${t("settings.quota.creditEstimated")})` : "";
    rows.push({
      label: t("settings.quota.creditRemaining"),
      value: `${formatCredit(quota.credit.remaining, locale)}${suffix}${estimate}`,
    });
  }
  if (quota?.balance) {
    rows.push({
      label: t("settings.quota.balance"),
      value: quota.balance.usable
        ? `${formatAmount(quota.balance.amount, locale)} ${quota.balance.currency}`
        : `${formatAmount(quota.balance.amount, locale)} ${quota.balance.currency} · ${t("settings.quota.balanceEmpty")}`,
    });
  }
  if (quota?.periodEnd) {
    rows.push({ label: t("settings.quota.periodEnd"), value: dayOf(quota.periodEnd, lang) });
  }
  const usageBits: string[] = [];
  if (quota?.usage?.requests !== undefined) {
    usageBits.push(t("settings.quota.requests", { count: quota.usage.requests }));
  }
  if (quota?.usage?.tokens !== undefined) {
    usageBits.push(t("settings.quota.tokens", { value: formatTokens(quota.usage.tokens, locale) }));
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-line bg-bg px-[14px] py-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-tx">{t("settings.quota.detailTitle")}</span>
        <span className="flex-1" />
        {quota ? (
          <span className="text-[11px] text-tx3">
            {t("settings.quota.updatedAt", {
              time: new Date(quota.fetchedAt).toLocaleTimeString(lang, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
          {t("settings.quota.refresh")}
        </Button>
      </div>

      {quota?.windows.map((w) => (
        <div key={w.id} className="flex items-center gap-2">
          <span className="w-[92px] shrink-0 text-[11px] text-tx2">{windowLabel(w, t)}</span>
          <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
            <span
              className={`block h-full rounded-full ${toneClass(w.percent)}`}
              style={{ width: `${w.percent}%` }}
            />
          </span>
          <span className="w-[40px] shrink-0 text-right font-mono text-[11px] text-tx">
            {formatPercent(w.percent, locale)}
          </span>
          <span className="w-[110px] shrink-0 text-right font-mono text-[11px] text-tx3">
            {w.used === undefined || w.cap === undefined
              ? ""
              : `${formatCredit(w.used, locale)} / ${formatCredit(w.cap, locale)}`}
          </span>
          <span className="w-[130px] shrink-0 text-[11px] text-tx3">
            {w.exceeded
              ? t("settings.quota.exceeded")
              : w.resetsAt
                ? t("settings.quota.resetsAt", { time: resetTime(w.resetsAt, lang) })
                : ""}
          </span>
        </div>
      ))}

      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 text-[11px]">
          <span className="w-[92px] shrink-0 text-tx2">{row.label}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-tx">{row.value}</span>
        </div>
      ))}
      {usageBits.length > 0 ? (
        <div className="text-[11px] text-tx3">{usageBits.join(" · ")}</div>
      ) : null}
      {quota?.message ? <div className="text-[11px] text-amber">{quota.message}</div> : null}
      {quota?.state === "unsupported" ? (
        <div className="text-[11px] text-tx3">{t("settings.quota.badgeUnsupported")}</div>
      ) : null}
    </div>
  );
}
