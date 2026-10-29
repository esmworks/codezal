import type { Locale } from "@codezal/i18n";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { formatElapsed, formatTokens } from "../lib/format";
import type { AgentJobRow } from "../lib/jobs";
import { KIND_LABEL } from "../session/jobKind";
import { usePanel } from "../stores/panel";

/** Kartın alt satırlarındaki parça: metin ve tonu. */
export interface Part {
  text: string;
  tone?: string;
}

/** Süren iş mi: kuyruktaki ve süren koşu "Çalışıyor" bölümündedir. */
export function isLive(row: AgentJobRow): boolean {
  return row.status === "running" || row.status === "queued";
}

/**
 * Kart başlığı. Ayrık koşunun etiketi ajan adıdır ("general"); ayırt edici olan koşunun adı
 * (görev satırı), bu yüzden başlık odur. Yerli alt ajanda etiket zaten görev başlığıdır.
 */
export function titleOf(row: AgentJobRow): string {
  return row.source === "worker" && row.task ? row.task : row.label;
}

/** İşin süresi: süren işte şimdiye kadar, biten işte başlangıçtan bitişe. */
export function durationOf(row: AgentJobRow, now: number): number | undefined {
  if (row.startedAt === undefined) return undefined;
  const end = isLive(row) ? now : row.endedAt;
  return end === undefined ? undefined : Math.max(0, end - row.startedAt);
}

/**
 * Durum sözcüğü (Claude'daki "Completed"). Süren işte yazılmaz, süre yeter; bekleyen worker ve
 * inceleme kararı ayrıca söylenir. Renk yalnız başarıyı anlatır: hata metinle okunur.
 */
export function statusPart(row: AgentJobRow, lang: Locale, t: TFunction): Part | null {
  const part = rawStatus(row, t);
  // Durum sözcükleri yüzen kartta küçük harfle ("durduruldu") yazılır; kartta "Tamamlandı" ile
  // yan yana büyük harfle başlasın.
  return part
    ? { ...part, text: `${part.text.charAt(0).toLocaleUpperCase(lang)}${part.text.slice(1)}` }
    : null;
}

function rawStatus(row: AgentJobRow, t: TFunction): Part | null {
  if (row.waiting) return { text: t("env.agentWaiting"), tone: "text-tx2" };
  if (row.reviewing) return { text: t("env.agentReview"), tone: "text-accTx" };
  if (row.status === "queued") return { text: t("env.agentQueued") };
  if (row.status === "running") return null;
  if (row.status === "stopped") return { text: t("env.agentStopped") };
  if (row.status === "error") return { text: t("env.agentFailed"), tone: "text-tx2" };
  if (row.code !== undefined && row.code !== 0)
    return { text: t("env.agentExit", { code: row.code }), tone: "text-tx2" };
  return { text: t("jobs.completed") };
}

/** Kartın ikinci satırı: tür, durum ve süre ("Ajan  Tamamlandı  9 sn"). */
export function metaParts(row: AgentJobRow, now: number, lang: Locale, t: TFunction): Part[] {
  const kind =
    row.kind === "background"
      ? t("panel.command")
      : row.kind === "agent" || row.kind === "worker"
        ? t("panel.agent")
        : t(KIND_LABEL[row.kind]);
  const out: Part[] = [{ text: kind, tone: "text-tx2" }];
  const status = statusPart(row, lang, t);
  if (status) out.push(status);
  const ms = durationOf(row, now);
  if (ms !== undefined) out.push({ text: formatElapsed(ms, lang) });
  return out;
}

/** Kartın üçüncü satırı: token, araç kullanımı ve (süren işte) son etkinlik. */
export function usageParts(row: AgentJobRow, lang: Locale, t: TFunction): Part[] {
  const out: Part[] = [];
  if (row.tokens) out.push({ text: t("jobs.tokens", { value: formatTokens(row.tokens, lang) }) });
  if (row.steps) out.push({ text: t("jobs.toolUses", { count: row.steps }) });
  if (row.status === "running" && row.activity && !row.waiting)
    out.push({ text: row.activity, tone: "cz-shimmer" });
  return out;
}

function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => (
        // Parçalar sabit sırada ve aynı işte tekrarlanmaz; sıra anahtar olarak yeter.
        <span key={i} className={`min-w-0 truncate ${p.tone ?? "text-tx3"}`}>
          {p.text}
        </span>
      ))}
    </>
  );
}

/** Parçaları tek satırda yan yana dizer (ayrıntı başlığının altındaki durum satırı). */
export function PartLine({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-[8px] text-[12.5px] tabular-nums">
      <Parts parts={parts} />
    </div>
  );
}

/**
 * İş kartı (Claude'daki "Background tasks" kartı): başlık, altında tür · durum · süre, en altta
 * kullanım ve "Dökümü gör". Kartın tamamı ayrıntıyı açar; Durdur sağ üstte ayrı katmandadır ki
 * tıklaması kartı açmasın. Biten işin başlığı soluk yazılır.
 */
export function JobCard({
  title,
  hint,
  mono,
  live,
  meta,
  usage,
  link,
  onOpen,
  onStop,
}: {
  title: string;
  /** Kırpılan ya da kısaltılan başlığın tamamı (tam komut). */
  hint?: string | undefined;
  /** Açıklaması olmayan komutun başlığı: kod yazısıyla, tek satır. */
  mono?: boolean;
  live: boolean;
  meta: Part[];
  usage: Part[];
  link: string;
  onOpen: () => void;
  onStop?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <li className="relative rounded-[10px] bg-card px-3 py-[10px] hover:bg-sel">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${link}: ${title}`}
        title={hint ?? title}
        className="absolute inset-0 rounded-[10px]"
      />
      <div className="pointer-events-none relative flex min-w-0 items-start gap-2">
        <p
          className={`min-w-0 flex-1 ${
            // Açıklamasız komut başlığı tek satır: uzun kabuk dizisi kartı paragrafa çevirmesin.
            mono
              ? "truncate font-code text-[12.5px] leading-[1.55]"
              : "line-clamp-2 break-words text-[13.5px] leading-[1.45]"
          } ${live ? "text-tx" : "text-tx2"}`}
        >
          {title}
        </p>
        {onStop ? (
          <button
            type="button"
            onClick={onStop}
            title={t("background.stopTitle")}
            aria-label={t("background.stop")}
            className="pointer-events-auto relative z-[2] -mt-[2px] -mr-[4px] flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] border border-line2 text-tx2 hover:bg-hov hover:text-tx"
          >
            <Icon name="stop" size={10} fill />
          </button>
        ) : null}
      </div>
      <div className="pointer-events-none relative mt-[5px] flex min-w-0 items-center gap-[8px] text-[12.5px] tabular-nums">
        <Parts parts={meta} />
      </div>
      <div className="pointer-events-none relative mt-[3px] flex min-w-0 items-center gap-[8px] text-[12.5px] tabular-nums">
        <Parts parts={usage} />
        <span className="shrink-0 text-link">{link}</span>
      </div>
    </li>
  );
}

/**
 * Ayrıntı başlığı (Claude'daki "‹ Test agent çağrısı"): geri oku listeye döner, sağda süren işte
 * Durdur. Başlık tek satır; tamamı ipucunda.
 */
export function DetailHeader({
  title,
  onStop,
  stopDisabled,
}: {
  title: string;
  onStop?: (() => void) | undefined;
  stopDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const showJob = usePanel((s) => s.showJob);
  return (
    <div className="flex h-10 shrink-0 items-center gap-[6px] pr-3 pl-[6px]">
      <button
        type="button"
        onClick={() => showJob(null)}
        title={t("jobs.back")}
        aria-label={t("jobs.back")}
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
      >
        <Icon name="chevronLeft" size={15} stroke={2} />
      </button>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-tx" title={title}>
        {title}
      </span>
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          disabled={stopDisabled}
          title={t("background.stopTitle")}
          aria-label={t("background.stop")}
          className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] border border-line2 text-tx2 hover:bg-hov hover:text-tx disabled:opacity-50"
        >
          <Icon name="stop" size={10} fill />
        </button>
      ) : null}
    </div>
  );
}

/** Ayrıntıdaki "Model Opus 5.5"-tipi ölçüm satırı: soluk etiket, ardından değer. */
export function StatLine({ stats }: { stats: { label: string; value: string; title?: string }[] }) {
  if (stats.length === 0) return null;
  return (
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px] tabular-nums">
      {stats.map((s) => (
        <div key={s.label} className="flex min-w-0 items-baseline gap-[5px]">
          <dt className="shrink-0 text-tx3">{s.label}</dt>
          <dd className="min-w-0 truncate text-tx2" title={s.title ?? s.value}>
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
