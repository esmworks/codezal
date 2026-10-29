import type { ProviderQuota } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { formatPercent } from "../lib/format";
import { useLocale } from "../lib/i18n";
import {
  badgeLabel,
  formatAmount,
  formatCredit,
  resetTime,
  toneClass,
  windowLabel,
} from "../settings/QuotaBadge";
import { useModels } from "../stores/models";
import { quotaOf, useQuota } from "../stores/quota";
import { useSessions } from "../stores/sessions";

/**
 * Oturumun seçili modelinin sağlayıcısına ait kota; Kodlama ve Asistan ekranlarının yüzen
 * kutularında durur. Ayarlar > Bağlantı'daki ayrıntının sığdırılmış hâlidir.
 * Kota ucu olmayan sağlayıcıda (ör. xAI) kutu hiç çizilmez: "okunamadı" satırı yer kaplardı.
 * Tazeleme açılışta, sağlayıcı değişince ve her tur bitince yapılır; main 60 sn önbellek tuttuğu
 * için sık tur bitişi uca ek istek atmaz.
 */
export function QuotaBox({ sessionId, active }: { sessionId: string; active: boolean }) {
  const sessionModel = useSessions((s) => s.runtime[sessionId]?.model ?? null);
  const globalModel = useModels((s) => s.model);
  const provider = (sessionModel ?? globalModel)?.provider;
  const providerName = useModels((s) => s.providers.find((p) => p.id === provider)?.name);
  const quota = useQuota((s) => (provider ? quotaOf(s.items, provider) : undefined));
  const load = useQuota((s) => s.load);
  const refresh = useQuota((s) => s.refresh);

  useEffect(() => {
    void load();
  }, [load]);
  // Tur sürerken tazelenmez: tur bitince (`active` false olunca) güncel tüketim okunur.
  useEffect(() => {
    if (provider && !active) void refresh(provider);
  }, [provider, active, refresh]);

  return provider ? <QuotaView quota={quota} providerName={providerName ?? provider} /> : null;
}

/** Kota kartı; store'a dokunmaz, testte doğrudan çizilir. */
export function QuotaView({
  quota,
  providerName,
}: {
  quota: ProviderQuota | undefined;
  providerName: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(true);

  if (!quota || quota.state === "unsupported") return null;

  const lang = i18n.language;
  const problem = quota.state !== "ok";
  const credit = quota.credit;
  const balance = quota.balance;
  // Uç yanıt verdi ama gösterilecek pencere/kredi/bakiye yoksa boş kart çizilmez.
  if (!problem && quota.windows.length === 0 && !credit && !balance) return null;

  return (
    <div className="shrink-0 overflow-hidden rounded-[14px] border border-line2 bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-[14px] py-3 text-left"
      >
        <span className="text-[14px] font-semibold">{t("env.quotaTitle")}</span>
        <span className="min-w-0 truncate text-[14px] text-tx3">{providerName}</span>
        <span className="flex-1" />
        <Icon
          name="chevronDown"
          size={13}
          stroke={2}
          className="shrink-0 text-tx3 transition-transform"
          style={{ transform: open ? undefined : "rotate(-90deg)" }}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line px-[14px] pt-2 pb-[10px]">
          {problem ? (
            <div className="text-[14px] text-amber" title={quota.message}>
              {badgeLabel(t, quota, undefined, locale)}
            </div>
          ) : null}
          {quota.windows.map((w) => (
            <div
              key={w.id}
              title={
                w.resetsAt
                  ? t("settings.quota.resetsAt", { time: resetTime(w.resetsAt, lang) })
                  : undefined
              }
              className="flex items-center gap-[10px] text-[14px]"
            >
              {/* Sağlayıcının kendi adlandırdığı pencere (ör. MCP) sığmazsa tamamı ipucunda. */}
              <span className="w-[64px] shrink-0 truncate text-tx2" title={windowLabel(w, t)}>
                {windowLabel(w, t)}
              </span>
              <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
                <span
                  className={`block h-full rounded-full ${toneClass(w.percent)}`}
                  style={{ width: `${w.percent}%` }}
                />
              </span>
              <span className="w-[40px] shrink-0 text-right text-tx tabular-nums">
                {formatPercent(w.percent, locale)}
              </span>
            </div>
          ))}
          {/* Dolan pencere sıfırlanana kadar istek düşer; ne zaman açılacağı görünür olsun. */}
          {quota.windows
            .filter((w) => w.exceeded && w.resetsAt)
            .map((w) => (
              <div key={`reset-${w.id}`} className="text-[14px] text-red">
                {windowLabel(w, t)} · {t("settings.quota.exceeded")} ·{" "}
                {t("settings.quota.resetsAt", { time: resetTime(w.resetsAt ?? 0, lang) })}
              </div>
            ))}
          {credit ? (
            <div className="flex items-center gap-[10px] text-[14px]">
              <span className="min-w-0 flex-1 truncate text-tx2">
                {t("settings.quota.creditRemaining")}
              </span>
              <span className="shrink-0 text-tx tabular-nums">
                {formatCredit(credit.remaining, locale)}
                {/* Kapasite plan tablosundan türetildiyse (sağlayıcı bildirmiyor) "~" ile yazılır. */}
                {credit.cap === undefined
                  ? ""
                  : ` / ${credit.capEstimated ? "~" : ""}${formatCredit(credit.cap, locale)}`}
              </span>
            </div>
          ) : null}
          {balance ? (
            <div className="flex items-center gap-[10px] text-[14px]">
              <span className="min-w-0 flex-1 truncate text-tx2">
                {t("settings.quota.balance")}
              </span>
              <span className={`shrink-0 tabular-nums ${balance.usable ? "text-tx" : "text-red"}`}>
                {formatAmount(balance.amount, locale)} {balance.currency}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
