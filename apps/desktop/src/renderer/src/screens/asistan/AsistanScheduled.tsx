import type { ScheduledTask } from "@codezal/contracts";
import { localeTag } from "@codezal/i18n";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { ErrorBar, splitError } from "../../components/ErrorBar";
import { Icon } from "../../components/Icon";
import { Select, type SelectOption } from "../../components/Select";
import type { IconName } from "../../icons";
import { useLocale } from "../../lib/i18n";
import { matchesFold } from "../../lib/searchText";
import { useApp } from "../../stores/app";
import { useAssistant } from "../../stores/assistant";
import { useMenu } from "../../stores/menu";
import { useModels } from "../../stores/models";
import { useSessions } from "../../stores/sessions";
import { describeSchedule, ScheduleModal, type ScheduleTemplate } from "./ScheduleModal";

type Sort = "next" | "name" | "last";

/** Açık form: yeni (isteğe bağlı şablonla) ya da var olan görevin düzenlemesi. */
type Open = { kind: "new"; template?: ScheduleTemplate } | { kind: "edit"; id: string } | null;

interface Template extends ScheduleTemplate {
  key: string;
  icon: IconName;
  desc: string;
}

/**
 * Sıralama anahtarı "Sonraki çalışma": duraklatılmış ve yalnız elle çalışan görevler sona düşer,
 * onların kendi aralarındaki sırası addır.
 */
const nextKey = (x: ScheduledTask) =>
  x.paused || x.nextRunAt === null ? Number.POSITIVE_INFINITY : x.nextRunAt;

/**
 * Asistan > Zamanlanmış: tüm zamanlanmış görevler projeden bağımsız tek listede. Proje sayfasındaki
 * kutu yalnız o projenin görevlerini gösterir; burada projesiz görev de kurulur.
 */
export function AsistanScheduled() {
  const { t } = useTranslation();
  const lang = useLocale();
  const { tasks, projects, load, cwdFor } = useAssistant();
  const openSession = useApp((s) => s.openSession);
  const openMenu = useMenu((s) => s.openAt);
  const { model, permission, thinking } = useModels();
  const create = useSessions((s) => s.create);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("next");
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const collator = new Intl.Collator(localeTag(lang));
    const byName = (a: ScheduledTask, b: ScheduledTask) => collator.compare(a.title, b.title);
    const q = query.trim();
    const list = q ? tasks.filter((x) => matchesFold(`${x.title}\n${x.prompt}`, q)) : [...tasks];
    if (sort === "name") return list.sort(byName);
    if (sort === "last")
      return list.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || byName(a, b));
    return list.sort((a, b) => {
      const ka = nextKey(a);
      const kb = nextKey(b);
      return ka === kb ? byName(a, b) : ka - kb;
    });
  }, [tasks, query, sort, lang]);

  const sorts: SelectOption<Sort>[] = [
    { value: "next", label: t("scheduled.sortNext") },
    { value: "name", label: t("scheduled.sortName") },
    { value: "last", label: t("scheduled.sortLast") },
  ];

  const templates: Template[] = [
    {
      key: "brief",
      icon: "sun",
      title: t("scheduled.templates.briefTitle"),
      desc: t("scheduled.templates.briefDesc"),
      prompt: t("scheduled.templates.briefPrompt"),
      schedule: { kind: "weekdays", time: "08:00" },
    },
    {
      key: "inbox",
      icon: "chat",
      title: t("scheduled.templates.inboxTitle"),
      desc: t("scheduled.templates.inboxDesc"),
      prompt: t("scheduled.templates.inboxPrompt"),
      schedule: { kind: "weekdays", time: "08:00" },
    },
    {
      key: "meeting",
      icon: "clock",
      title: t("scheduled.templates.meetingTitle"),
      desc: t("scheduled.templates.meetingDesc"),
      prompt: t("scheduled.templates.meetingPrompt"),
      schedule: { kind: "weekdays", time: "08:00" },
    },
    {
      key: "weekly",
      icon: "list",
      title: t("scheduled.templates.weeklyTitle"),
      desc: t("scheduled.templates.weeklyDesc"),
      prompt: t("scheduled.templates.weeklyPrompt"),
      schedule: { kind: "weekly", time: "16:00", weekday: 5 },
    },
    {
      key: "content",
      icon: "sparkle",
      title: t("scheduled.templates.contentTitle"),
      desc: t("scheduled.templates.contentDesc"),
      prompt: t("scheduled.templates.contentPrompt"),
      schedule: { kind: "weekly", time: "09:00", weekday: 1 },
    },
    {
      key: "monitor",
      icon: "eye",
      title: t("scheduled.templates.monitorTitle"),
      desc: t("scheduled.templates.monitorDesc"),
      prompt: t("scheduled.templates.monitorPrompt"),
      schedule: { kind: "daily", time: "09:00" },
    },
  ];

  /** "Asistan ile kur": projesiz bir asistan sohbeti açar, görevi soru-cevapla kaydettirir. */
  const setUpWithAssistant = async () => {
    if (starting) return;
    setStarting(true);
    try {
      if (!model) throw new Error(t("asistan.noProviderHome"));
      const s = await create(
        {
          cwd: cwdFor(null),
          mode: "asistan",
          model,
          thinking,
          permission,
          location: "local",
          projectId: null,
        },
        t("asistan.scheduleWithAssistantPrompt"),
        [],
      );
      if (s) openSession(s.id, "asistan");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const newTaskMenu = (e: React.MouseEvent<HTMLButtonElement>) =>
    openMenu(e.currentTarget, {
      minWidth: 280,
      items: [
        {
          label: t("asistan.scheduleWithAssistant"),
          desc: t("asistan.scheduleWithAssistantDesc"),
          icon: "sparkle",
          onSelect: () => void setUpWithAssistant(),
        },
        {
          label: t("asistan.scheduleManually"),
          desc: t("asistan.scheduleManuallyDesc"),
          icon: "pen",
          onSelect: () => setOpen({ kind: "new" }),
        },
      ],
    });

  const editing = open?.kind === "edit" ? tasks.find((x) => x.id === open.id) : undefined;
  const fmt = (ts: number) =>
    new Date(ts).toLocaleString(localeTag(lang), { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-10 pt-[58px] pb-12">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <div className="min-w-[220px] flex-1">
            <h1 className="text-[18px] font-semibold">{t("asistan.scheduledTitle")}</h1>
            <p className="pt-1 text-[13px] text-tx2">{t("scheduled.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-[34px] w-[200px] items-center gap-2 rounded-[10px] border border-line2 bg-card px-[11px] focus-within:border-tx3">
              <Icon name="search" size={14} className="shrink-0 text-tx3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder={t("scheduled.searchPlaceholder")}
                aria-label={t("scheduled.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-tx outline-none placeholder:text-tx3"
              />
            </label>
            <Select size="md" width={170} value={sort} options={sorts} onChange={setSort} />
            <Button variant="primary" size="lg" disabled={starting} onClick={newTaskMenu}>
              <Icon name="plus" size={14} stroke={1.9} />
              {t("scheduled.newTask")}
              <Icon name="chevronDown" size={13} stroke={1.9} />
            </Button>
          </div>
        </header>

        {error ? <ErrorBar {...splitError(error)} onDismiss={() => setError(null)} /> : null}

        {tasks.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-line2 px-5 py-6 text-[14px] leading-[1.55] text-tx2">
            {t("asistan.noScheduled")}
          </div>
        ) : visible.length === 0 ? (
          <div className="text-[14px] text-tx2">{t("scheduled.noMatch")}</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {visible.map((x) => {
              const project = x.projectId ? projects.find((p) => p.id === x.projectId) : undefined;
              const next =
                !x.paused && x.schedule.kind !== "manual" && x.nextRunAt
                  ? t("schedule.nextRun", { when: fmt(x.nextRunAt) })
                  : undefined;
              return (
                <button
                  type="button"
                  key={x.id}
                  onClick={() => setOpen({ kind: "edit", id: x.id })}
                  className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-card2 px-4 pt-[14px] pb-3 text-left hover:border-line2"
                >
                  <div className="truncate text-[15px] font-medium">{x.title}</div>
                  <div className="line-clamp-3 min-h-[calc(3*1.5em)] text-[13px] leading-[1.5] text-tx2">
                    {x.prompt}
                  </div>
                  <div className="flex min-w-0 items-center gap-3 pt-2">
                    <span
                      title={next}
                      className={`shrink-0 rounded-[4px] px-[7px] py-[2px] text-[12px] font-medium ${
                        x.paused ? "bg-chip text-tx3" : "bg-[var(--addBg)] text-add"
                      }`}
                    >
                      {describeSchedule(x)}
                    </span>
                    <span className="flex-1" />
                    <span className="flex min-w-0 items-center gap-[5px] text-[12px] text-tx3">
                      <Icon name="folder" size={13} className="shrink-0" />
                      <span className="truncate">
                        {project ? project.name : t("scheduled.noProject")}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <section className="flex flex-col gap-4 border-t border-line pt-7">
          <h2 className="text-[13px] font-medium text-tx2">{t("scheduled.templatesTitle")}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6 gap-y-2">
            {templates.map((tpl) => (
              <button
                type="button"
                key={tpl.key}
                onClick={() =>
                  setOpen({
                    kind: "new",
                    template: { title: tpl.title, prompt: tpl.prompt, schedule: tpl.schedule },
                  })
                }
                className="flex min-w-0 items-start gap-3 rounded-[12px] px-3 py-3 text-left hover:bg-hov"
              >
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] bg-chip text-tx2">
                  <Icon name={tpl.icon} size={16} stroke={1.6} />
                </span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="text-[14px] font-medium text-tx">{tpl.title}</span>
                  <span className="text-[13px] leading-[1.5] text-tx2">{tpl.desc}</span>
                  <span className="flex items-center gap-[5px] pt-[2px] text-[12px] text-tx3">
                    <Icon name="clock" size={12} className="shrink-0" />
                    {describeSchedule({ schedule: tpl.schedule, paused: false })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Düzenlenen görev bu arada silindiyse (ör. Asistan aracıyla) form boş "yeni" gibi açılmaz. */}
      {open && (open.kind === "new" || editing) ? (
        <ScheduleModal
          // Düzenlenen görev silinirse ya da başka şablona geçilirse form sıfırdan kurulur.
          key={open.kind === "edit" ? open.id : (open.template?.title ?? "new")}
          projectId={null}
          {...(editing ? { initial: editing } : {})}
          {...(open.kind === "new" && open.template ? { template: open.template } : {})}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
