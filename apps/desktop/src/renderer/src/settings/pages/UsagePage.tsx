import type { UsageEntry } from "@codezal/contracts";
import { localeTag } from "@codezal/i18n";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { formatPercent, formatTokens, formatUsd } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { summaryCallCost, summaryModelsByCost } from "../../lib/modelPicker";
import {
  cumulativeHeatmap,
  dayKey,
  type HeatCell,
  type Heatmap,
  heatmap,
  lastDays,
  type MonthSlice,
  monthSlices,
  niceMax,
  parseDay,
  parseUsdBudget,
  type Share,
  share,
  smoothPath,
  summarize,
  type Trend,
  trend,
} from "../../lib/usageStats";
import { useModels } from "../../stores/models";
import { Card, SectionHead, SegmentedTabs } from "../list";
import { Bar, Row, Section, SelectRow, ToggleRow } from "../rows";
import type { Patch, S } from "./common";

// ---------- Kullanım ve model ----------

type Range = "7" | "30";
type HeatView = "yil" | "haftalik" | "kumulatif";
type Lang = "tr" | "en";

/** Seri renkleri: tek renkli tasarımın kendi tonları; sırayla en çok kullanılan modele. */
const SERIES_COLORS = [
  "var(--tx)",
  "var(--green)",
  "var(--amber)",
  "var(--red)",
  "var(--tx2)",
  "var(--tx3)",
];

const HEAT_OPACITY = [0, 0.22, 0.42, 0.66, 1];
const CELL = 11;
const GAP = 3;

export function UsagePage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const lang: Lang = useLocale();
  const [entries, setEntries] = useState<UsageEntry[]>([]);
  const [range, setRange] = useState<Range>("7");
  const [heatView, setHeatView] = useState<HeatView>("yil");
  const [refreshing, setRefreshing] = useState(false);
  const { model, catalog, setModel } = useModels();
  useEffect(() => {
    void invoke("usage:list", undefined).then(setEntries);
  }, []);
  const today = dayKey(new Date());
  const stats = useMemo(() => summarize(entries, today), [entries, today]);
  const heat = useMemo(() => heatmap(entries, today), [entries, today]);
  const cumulative = useMemo(() => cumulativeHeatmap(entries, today), [entries, today]);
  const weekly = useMemo(
    () => heat.weeks.map((week) => week.reduce((sum, cell) => sum + cell.tokens, 0)),
    [heat],
  );
  const weeklyMax = Math.max(...weekly, 1);
  const refresh = async () => {
    setRefreshing(true);
    try {
      setEntries(await invoke("usage:list", undefined));
    } finally {
      setRefreshing(false);
    }
  };
  const days = useMemo(() => lastDays(today, Number(range)), [today, range]);
  const otherLabel = t("settings.usage.other");
  const tr = useMemo(() => trend(entries, days, otherLabel), [entries, days, otherLabel]);
  const shares = useMemo(() => share(tr), [tr]);

  const month = today.slice(0, 7);
  const slices = useMemo(
    () => monthSlices(entries, month, otherLabel),
    [entries, month, otherLabel],
  );
  const sum = slices.reduce((a, r) => a + r.tokens, 0);
  const cost = slices.reduce((a, r) => a + r.cost, 0);
  const budget =
    s.monthlyBudget === "unlimited" ? 0 : Number(s.monthlyBudget.replace("M", "")) * 1_000_000;
  const pct = budget ? Math.round((sum / budget) * 100) : 0;
  const usdBudget = s.monthlyBudgetUsd;
  const usdPct = usdBudget > 0 ? Math.round((cost / usdBudget) * 100) : 0;
  const defaultModel = s.defaultModel ?? model;
  // Özet modeli listesi tahmini özet maliyetine göre (girdi + çıktı fiyatı) ucuzdan pahalıya.
  const summaryOptions = useMemo(
    () => [
      { value: "", label: t("settings.usage.summaryModelSame") },
      ...summaryModelsByCost(catalog).map((m) => ({
        value: `${m.provider}/${m.id}`,
        label:
          summaryCallCost(m) === undefined
            ? `${m.provider}/${m.id}`
            : `${m.provider}/${m.id} · ${t("settings.usage.perMillionPrices", {
                input: formatUsd(m.cost.input, lang),
                output: formatUsd(m.cost.output, lang),
              })}`,
      })),
    ],
    [catalog, lang, t],
  );
  // Danışman: önce sağlayıcı, sonra o sağlayıcının anahtarı olan modelleri (katalog sırasıyla).
  const advisor = s.advisorModel;
  const advisorProviders = useMemo(() => {
    const ids = [...new Set(catalog.filter((m) => m.available).map((m) => m.provider))];
    // Anahtarı silinmiş seçim de listede kalsın; yoksa seçici boş görünür ve ayar gizlenir.
    if (advisor && !ids.includes(advisor.provider)) ids.push(advisor.provider);
    return [
      { value: "", label: t("settings.usage.advisorModelOff") },
      ...ids.map((id) => ({ value: id, label: id })),
    ];
  }, [catalog, advisor, t]);
  const advisorModels = useMemo(() => {
    const models = catalog
      .filter((m) => m.available && m.provider === advisor?.provider)
      .map((m) => ({
        value: m.id,
        label: m.id,
        ...(m.cost.input > 0 || m.cost.output > 0
          ? {
              desc: t("settings.usage.perMillionPrices", {
                input: formatUsd(m.cost.input, lang),
                output: formatUsd(m.cost.output, lang),
              }),
            }
          : {}),
      }));
    if (advisor && !models.some((m) => m.value === advisor.id))
      models.push({ value: advisor.id, label: advisor.id });
    return models;
  }, [catalog, advisor, lang, t]);
  const dayCount = (n: number) => t("settings.usage.dayCount", { count: n });

  return (
    <>
      <StatStrip
        items={[
          { label: t("settings.usage.statsTotal"), value: formatTokens(stats.total, lang) },
          { label: t("settings.usage.statsMonth"), value: formatTokens(stats.month, lang) },
          {
            label: t("settings.usage.statsPeak"),
            value: stats.peak ? formatTokens(stats.peak.tokens, lang) : "–",
            ...(stats.peak ? { hint: shortDate(stats.peak.day, lang) } : {}),
          },
          { label: t("settings.usage.statsStreak"), value: dayCount(stats.currentStreak) },
          { label: t("settings.usage.statsLongest"), value: dayCount(stats.longestStreak) },
        ]}
      />

      <div className="flex flex-col gap-[12px]">
        <SectionHead
          title={t("settings.usage.activityTitle")}
          desc={t(
            heatView === "kumulatif"
              ? "settings.usage.cumulativeDesc"
              : "settings.usage.activityDesc",
          )}
          actions={
            <>
              <SegmentedTabs<HeatView>
                value={heatView}
                items={[
                  { key: "yil", label: t("settings.usage.viewYear") },
                  { key: "haftalik", label: t("settings.usage.viewWeekly") },
                  { key: "kumulatif", label: t("settings.usage.viewCumulative") },
                ]}
                onChange={setHeatView}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? t("settings.usage.refreshing") : t("settings.usage.refresh")}
              </Button>
            </>
          }
        />
        <Card>
          {heatView === "yil" ? (
            <HeatmapView
              weeks={heat.weeks}
              months={heat.months}
              lang={lang}
              less={t("settings.usage.less")}
              more={t("settings.usage.more")}
              cellTitle={(c, date) =>
                t("settings.usage.cellTitle", { date, tokens: formatTokens(c.tokens, lang) })
              }
            />
          ) : heatView === "kumulatif" ? (
            <HeatmapView
              weeks={cumulative.weeks}
              months={cumulative.months}
              lang={lang}
              less={formatPercent(0, lang)}
              more={formatPercent(100, lang)}
              cellTitle={(c, date) =>
                t("settings.usage.cumulativeCellTitle", {
                  date,
                  tokens: formatTokens(c.tokens, lang),
                  cumulative: formatTokens(c.cumulative, lang),
                })
              }
              footer={
                <>
                  {t("settings.usage.cumulativeSummary", {
                    total: formatTokens(cumulative.total, lang),
                    window: formatTokens(cumulative.windowTotal, lang),
                    days: cumulative.activeDays,
                  })}
                  {cumulative.firstDay
                    ? ` · ${t("settings.usage.cumulativeSince", {
                        date: longDate(cumulative.firstDay, lang),
                      })}`
                    : null}
                </>
              }
            />
          ) : (
            <WeeklyBars values={weekly} max={weeklyMax} label={t("settings.usage.activityTitle")} />
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-[12px]">
        <SectionHead
          title={t("settings.usage.trendTitle")}
          actions={
            <SegmentedTabs<Range>
              value={range}
              items={[
                { key: "7", label: t("settings.usage.range7") },
                { key: "30", label: t("settings.usage.range30") },
              ]}
              onChange={setRange}
            />
          }
        />
        <Card>
          {tr.series.length === 0 ? (
            <div className="px-[18px] py-9 text-center text-[13px] text-tx3">
              {t("settings.usage.trendEmpty")}
            </div>
          ) : (
            <TrendChart
              data={tr}
              lang={lang}
              title={t("settings.usage.trendTitle")}
              pointTitle={(date, name, tokens) =>
                t("settings.usage.pointTitle", { date, name, tokens })
              }
            />
          )}
        </Card>
      </div>

      {shares.length > 0 ? (
        <div className="flex flex-col gap-[12px]">
          <SectionHead
            title={t("settings.usage.shareTitle")}
            desc={t(range === "7" ? "settings.usage.range7" : "settings.usage.range30")}
          />
          <Card>
            <ShareView shares={shares} lang={lang} unit={t("settings.usage.tokensUnit")} />
          </Card>
        </div>
      ) : null}

      <Section title={t("settings.usage.monthTitle")}>
        {slices.length === 0 ? (
          <Row
            first
            label={t("settings.usage.noUsageLabel")}
            desc={t("settings.usage.noUsageDesc")}
          />
        ) : (
          <PieView
            slices={slices}
            lang={lang}
            title={t("settings.usage.monthTitle")}
            line={(tokens, count) => t("settings.usage.tokenLine", { tokens, count })}
          />
        )}
        {cost > 0 ? (
          <Row label={t("settings.usage.estCostLabel")} desc={t("settings.usage.estCostDesc")}>
            <span className="font-mono text-[13px]">{formatUsd(cost, lang)}</span>
          </Row>
        ) : null}
        {budget ? (
          <Row
            label={t("settings.usage.budgetLabel")}
            desc={t("settings.usage.budgetDesc", {
              used: formatTokens(sum, lang),
              limit: s.monthlyBudget,
            })}
          >
            <Bar pct={pct} value={formatPercent(pct, lang)} />
          </Row>
        ) : null}
        {budget && pct >= 80 ? (
          <div className="border-t border-line px-[18px] py-3 text-[13px] text-amber">
            {t("settings.usage.budgetWarn", { pct })}
          </div>
        ) : null}
        {usdBudget > 0 ? (
          <Row
            label={t("settings.usage.budgetUsdLabel")}
            desc={t("settings.usage.budgetUsdDesc", {
              used: formatUsd(cost, lang),
              limit: formatUsd(usdBudget, lang),
            })}
          >
            <Bar pct={usdPct} value={formatPercent(usdPct, lang)} />
          </Row>
        ) : null}
        {usdBudget > 0 && usdPct >= 80 ? (
          <div className="border-t border-line px-[18px] py-3 text-[13px] text-amber">
            {t("settings.usage.budgetUsdWarn", { pct: usdPct })}
          </div>
        ) : null}
      </Section>
      <Section title={t("settings.usage.defaultModelTitle")}>
        <Row first label={t("settings.usage.modelLabel")} desc={t("settings.usage.modelDesc")}>
          <Select
            size="sm"
            mono
            width={280}
            minMenuWidth={280}
            value={defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : null}
            placeholder={t("settings.usage.selectPlaceholder")}
            options={catalog
              .filter((m) => m.available)
              .map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }))}
            onChange={(v) => {
              const [provider, ...rest] = v.split("/");
              const ref = { provider: provider ?? "", id: rest.join("/") };
              patch({ defaultModel: ref });
              setModel(ref);
            }}
          />
        </Row>
        <Row
          label={t("settings.usage.summaryModelLabel")}
          desc={t("settings.usage.summaryModelDesc")}
        >
          <Select
            size="sm"
            mono
            width={280}
            minMenuWidth={480}
            value={s.webSummaryModel ? `${s.webSummaryModel.provider}/${s.webSummaryModel.id}` : ""}
            options={summaryOptions}
            onChange={(v) => {
              if (!v) {
                patch({ webSummaryModel: null });
                return;
              }
              const [provider, ...rest] = v.split("/");
              patch({ webSummaryModel: { provider: provider ?? "", id: rest.join("/") } });
            }}
          />
        </Row>
        <Row
          label={t("settings.usage.advisorModelLabel")}
          desc={t("settings.usage.advisorModelDesc")}
        >
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              mono
              width={140}
              minMenuWidth={200}
              value={advisor?.provider ?? ""}
              options={advisorProviders}
              onChange={(provider) => {
                if (!provider) {
                  patch({ advisorModel: null });
                  return;
                }
                if (provider === advisor?.provider) return;
                // Sağlayıcı değişince ilk modeli seç: ayar hep geçerli bir çift tutar.
                const first = catalog.find((m) => m.available && m.provider === provider);
                if (first) patch({ advisorModel: { provider, id: first.id } });
              }}
            />
            {advisor ? (
              <Select
                size="sm"
                mono
                width={220}
                minMenuWidth={360}
                value={advisor.id}
                options={advisorModels}
                onChange={(id) => patch({ advisorModel: { provider: advisor.provider, id } })}
              />
            ) : null}
          </div>
        </Row>
        {advisor ? (
          <ToggleRow
            label={t("settings.usage.advisorScheduledLabel")}
            desc={t("settings.usage.advisorScheduledDesc")}
            on={s.advisorScheduled}
            onChange={(v) => patch({ advisorScheduled: v })}
          />
        ) : null}
      </Section>
      <Section title={t("settings.usage.limitsTitle")}>
        <SelectRow
          first
          label={t("settings.usage.budgetSelectLabel")}
          desc={t("settings.usage.budgetSelectDesc")}
          value={s.monthlyBudget}
          options={[
            { value: "10M", label: "10M" },
            { value: "30M", label: "30M" },
            { value: "60M", label: "60M" },
            { value: "unlimited", label: t("settings.usage.unlimited") },
          ]}
          onChange={(v) => patch({ monthlyBudget: v })}
        />
        <UsdBudgetRow value={s.monthlyBudgetUsd} onCommit={(v) => patch({ monthlyBudgetUsd: v })} />
      </Section>
    </>
  );
}

/**
 * Para bütçesi alanı. Yerel metin tutulur ve odak çıkınca (ya da Enter'da) kaydedilir: her tuşta
 * sayıya çevirmek "12," yazarken virgülü silerdi.
 */
function UsdBudgetRow({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value > 0 ? String(value) : "");
  useEffect(() => setText(value > 0 ? String(value) : ""), [value]);
  const commit = () => {
    const next = parseUsdBudget(text);
    if (next === null) {
      setText(value > 0 ? String(value) : "");
      return;
    }
    if (next !== value) onCommit(next);
    else setText(value > 0 ? String(value) : "");
  };
  return (
    <Row
      label={t("settings.usage.budgetUsdInputLabel")}
      desc={t("settings.usage.budgetUsdInputDesc")}
    >
      <div className="flex shrink-0 items-center gap-[6px]">
        <span className="font-mono text-[13px] text-tx3">$</span>
        <input
          value={text}
          inputMode="decimal"
          placeholder="0"
          aria-label={t("settings.usage.budgetUsdInputLabel")}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          spellCheck={false}
          className="w-[110px] rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] text-right font-mono text-[12px] text-tx outline-none placeholder:text-tx3"
        />
      </div>
    </Row>
  );
}

function shortDate(day: string, lang: Lang): string {
  return new Intl.DateTimeFormat(localeTag(lang), { day: "numeric", month: "short" }).format(
    parseDay(day),
  );
}

function longDate(day: string, lang: Lang): string {
  return new Intl.DateTimeFormat(localeTag(lang), { dateStyle: "medium" }).format(parseDay(day));
}

/** Üst özet şeridi: beş büyük sayı, aralarında ince ayraç. */
function StatStrip({ items }: { items: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <Card>
      <div className="grid grid-cols-5">
        {items.map((it, i) => (
          <div
            key={it.label}
            className={`flex flex-col items-center gap-[3px] px-3 py-[16px] text-center ${
              i === 0 ? "" : "border-l border-line"
            }`}
          >
            <span className="font-semibold text-[20px] leading-none tracking-[-0.01em]">
              {it.value}
            </span>
            <span className="pt-[3px] text-[12px] text-tx3">
              {it.label}
              {it.hint ? <span className="text-tx3"> · {it.hint}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** GitHub tarzı yıl ısı haritası: sütun hafta, satır gün; ton en yoğun güne göre. */
/** Haftalık toplamlar: ısı haritasıyla aynı sütun düzeninde ince çubuklar. */
function WeeklyBars({ values, max, label }: { values: number[]; max: number; label: string }) {
  const width = values.length * (CELL + GAP);
  const height = 96;
  const base = height - 18;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      {values.map((value, index) => {
        const bar = max > 0 && value > 0 ? Math.max(3, (value / max) * (base - 8)) : 0;
        return (
          <rect
            key={index}
            x={index * (CELL + GAP)}
            y={base - bar}
            width={CELL}
            height={bar}
            rx={2}
            style={{ fill: "var(--green)" }}
            opacity={value > 0 ? 0.75 : 0.15}
          />
        );
      })}
    </svg>
  );
}

/**
 * Gün ızgarası: yıl görünümü ve kümülatif görünüm aynı düzeni paylaşır; yalnız hücre değeri
 * (günlük ya da birikmiş) ve ipucu metni değişir. Ton her ikisinde de `level` ile çizilir.
 */
function HeatmapView<C extends HeatCell>({
  weeks,
  months,
  lang,
  less,
  more,
  cellTitle,
  footer,
}: {
  weeks: C[][];
  months: Heatmap["months"];
  lang: Lang;
  less: string;
  more: string;
  cellTitle: (cell: C, date: string) => string;
  footer?: ReactNode;
}) {
  const monthName = new Intl.DateTimeFormat(localeTag(lang), { month: "short" });
  const dateName = new Intl.DateTimeFormat(localeTag(lang), { dateStyle: "medium" });
  const step = CELL + GAP;
  const width = weeks.length * step - GAP;
  return (
    <div className="overflow-x-auto px-[18px] py-[16px]">
      <div className="flex flex-col gap-[6px]" style={{ width }}>
        <div className="relative h-[14px] text-[11px] text-tx3">
          {months.map((m) => (
            <span
              key={`${m.col}-${m.month}`}
              className="absolute top-0"
              style={{ left: m.col * step }}
            >
              {monthName.format(new Date(2026, m.month, 1))}
            </span>
          ))}
        </div>
        <div className="flex" style={{ gap: GAP }}>
          {weeks.map((week) => (
            <div key={week[0]?.day} className="flex flex-col" style={{ gap: GAP }}>
              {week.map((c) => (
                <span
                  key={c.day}
                  title={c.future ? undefined : cellTitle(c, dateName.format(parseDay(c.day)))}
                  className={`block rounded-[2px] ${
                    c.future ? "border border-line" : c.level === 0 ? "bg-chip" : ""
                  }`}
                  style={{
                    width: CELL,
                    height: CELL,
                    ...(c.level > 0
                      ? { background: "var(--tx)", opacity: HEAT_OPACITY[c.level] }
                      : {}),
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-[4px] pt-[2px] text-[11px] text-tx3">
          {footer ? <span className="mr-auto">{footer}</span> : null}
          {less}
          {HEAT_OPACITY.map((o, i) => (
            <span
              key={o}
              className={`block rounded-[2px] ${i === 0 ? "bg-chip" : ""}`}
              style={{
                width: 9,
                height: 9,
                ...(i > 0 ? { background: "var(--tx)", opacity: o } : {}),
              }}
            />
          ))}
          {more}
        </div>
      </div>
    </div>
  );
}

/** Günlük eğilim: model başına yumuşak çizgi, dört yatay kılavuz, sağda ölçek. */
function TrendChart({
  data,
  lang,
  title,
  pointTitle,
}: {
  data: Trend;
  lang: Lang;
  title: string;
  pointTitle: (date: string, name: string, tokens: string) => string;
}) {
  const W = 760;
  const H = 230;
  const L = 12;
  const R = 52;
  const TOP = 14;
  const B = 30;
  const innerW = W - L - R;
  const innerH = H - TOP - B;
  const max = niceMax(Math.max(...data.series.flatMap((s) => s.values), 0));
  const n = data.days.length;
  const x = (i: number) => L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => TOP + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = n <= 7 ? 1 : n <= 14 ? 2 : 5;
  const dateName = new Intl.DateTimeFormat(localeTag(lang), { day: "numeric", month: "short" });
  return (
    <div className="flex flex-col gap-[6px] px-[18px] pt-[14px] pb-[10px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-tx2">
        {data.series.map((s, i) => (
          <span key={s.name} className="flex items-center gap-[6px]">
            <span
              className="block h-[8px] w-[8px] rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span className="font-mono">{s.name}</span>
            <span className="text-tx3">{formatTokens(s.total, lang)}</span>
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title}>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={L + innerW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line2)"
              strokeDasharray={v === 0 ? undefined : "3 4"}
            />
            <text
              x={W - R + 8}
              y={y(v) + 4}
              fontSize={11}
              fill="var(--tx3)"
              fontFamily="var(--font-mono)"
            >
              {formatTokens(v, lang)}
            </text>
          </g>
        ))}
        {data.days.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text
              key={d}
              x={x(i)}
              y={H - 8}
              fontSize={11}
              fill="var(--tx3)"
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            >
              {dateName.format(parseDay(d))}
            </text>
          ) : null,
        )}
        {data.series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) }));
          return (
            <g key={s.name}>
              <path
                d={smoothPath(pts)}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {pts.map((p, i) => (
                <circle key={data.days[i]} cx={p.x} cy={p.y} r={7} fill="transparent">
                  <title>
                    {pointTitle(
                      dateName.format(parseDay(data.days[i] ?? "")),
                      s.name,
                      formatTokens(s.values[i] ?? 0, lang),
                    )}
                  </title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Model payı: halka + sağda liste. Halka dilimleri `stroke-dasharray` ile çizilir. */
function ShareView({ shares, lang, unit }: { shares: Share[]; lang: Lang; unit: string }) {
  const size = 150;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = shares.reduce((a, s) => a + s.tokens, 0);
  let offset = 0;
  const arcs = shares.map((s, i) => {
    const len = (s.pct / 100) * c;
    const arc = { key: s.name, len, offset, color: SERIES_COLORS[i % SERIES_COLORS.length] };
    offset += len;
    return arc;
  });
  return (
    <div className="flex items-center gap-8 px-[18px] py-[18px]">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--chip)"
            strokeWidth={stroke}
          />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, a.len - 1.5)} ${c}`}
              strokeDashoffset={-a.offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {/* Ölçek dışı 17px yerine 18px: tip ölçeği `docs/DESIGN.md`de tanımlı ve kapı testi
              (`designScale.test.ts`) ölçek dışı değer eklenmesini engelliyor. */}
          <span className="font-semibold text-[18px] leading-none">
            {formatTokens(total, lang)}
          </span>
          <span className="pt-[4px] text-[11px] text-tx3">{unit}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
        {shares.map((s, i) => (
          <div key={s.name} className="flex items-center gap-[10px] text-[13px]">
            <span
              className="block h-[8px] w-[8px] shrink-0 rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
            <span className="text-tx3">{formatTokens(s.tokens, lang)}</span>
            <span className="w-[44px] text-right font-mono text-tx2">
              {formatPercent(s.pct, lang)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pasta grafiği: dilimler SVG yayı, sağda gösterge; dilim araları kart rengiyle ayrılır. */
function PieView({
  slices,
  lang,
  title,
  line,
}: {
  slices: MonthSlice[];
  lang: Lang;
  title: string;
  line: (tokens: string, count: number) => string;
}) {
  const size = 170;
  const c = size / 2;
  const r = c - 2;
  const point = (angle: number) => ({
    x: c + r * Math.cos(angle),
    y: c + r * Math.sin(angle),
  });
  let start = -Math.PI / 2;
  const arcs = slices.map((sl, i) => {
    const sweep = (sl.pct / 100) * 2 * Math.PI;
    const end = start + sweep;
    const p1 = point(start);
    const p2 = point(end);
    // Tek dilim %100 ise yay kendi üstüne kapanır; onu tam daire olarak çiz.
    const d =
      sl.pct >= 99.999
        ? `M${c - r},${c} A${r},${r} 0 1 1 ${c + r},${c} A${r},${r} 0 1 1 ${c - r},${c}`
        : `M${c},${c} L${p1.x},${p1.y} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${p2.x},${p2.y} Z`;
    start = end;
    return { key: sl.name, d, color: SERIES_COLORS[i % SERIES_COLORS.length], slice: sl };
  });
  return (
    <div className="flex items-center gap-8 px-[18px] py-[18px]">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={title}
        className="shrink-0"
      >
        {arcs.map((a) => (
          <path key={a.key} d={a.d} fill={a.color} stroke="var(--card2)" strokeWidth={1.5}>
            <title>
              {a.slice.name} · {line(formatTokens(a.slice.tokens, lang), a.slice.requests)} ·{" "}
              {formatPercent(a.slice.pct, lang)}
            </title>
          </path>
        ))}
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
        {arcs.map((a) => (
          <div key={a.key} className="flex items-center gap-[10px] text-[13px]">
            <span
              className="block h-[8px] w-[8px] shrink-0 rounded-full"
              style={{ background: a.color }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono">{a.slice.name}</div>
              <div className="text-[12px] text-tx3">
                {line(formatTokens(a.slice.tokens, lang), a.slice.requests)}
              </div>
            </div>
            <span className="w-[44px] text-right font-mono text-tx2">
              {formatPercent(a.slice.pct, lang)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
