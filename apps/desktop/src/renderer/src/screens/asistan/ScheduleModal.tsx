import type { PermissionMode, ScheduledTask } from "@codezal/contracts";
import { localeTag, type TranslationKey } from "@codezal/i18n";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { Select, type SelectOption } from "../../components/Select";
import { Toggle } from "../../components/Toggle";
import { i18n, useLocale } from "../../lib/i18n";
import { Chip, PERMISSION_ICONS } from "../../session/chips";
import { useApp } from "../../stores/app";
import { uid, useAssistant } from "../../stores/assistant";
import { useMenu } from "../../stores/menu";
import { useModelPicker } from "../../stores/modelPicker";
import { useModels } from "../../stores/models";

const DAY_KEYS = [
  "days.sunday",
  "days.monday",
  "days.tuesday",
  "days.wednesday",
  "days.thursday",
  "days.friday",
  "days.saturday",
] as const;

type Kind = ScheduledTask["schedule"]["kind"];
const KIND_KEYS: Record<Kind, TranslationKey> = {
  daily: "schedule.kindDaily",
  weekdays: "schedule.kindWeekdays",
  weekly: "schedule.kindWeekly",
  monthly: "schedule.kindMonthly",
  interval: "schedule.kindInterval",
  manual: "schedule.kindManual",
};
const PERMISSION_KEYS: Record<PermissionMode, TranslationKey> = {
  ask: "permissionMode.ask",
  "auto-edit": "permissionMode.auto-edit",
  plan: "permissionMode.plan",
  full: "permissionMode.full",
};
const PERMISSION_HELP: Record<PermissionMode, TranslationKey> = {
  ask: "schedule.permHelpAsk",
  "auto-edit": "schedule.permHelpAuto",
  plan: "schedule.permHelpPlan",
  full: "schedule.permHelpFull",
};

export function describeSchedule(t: Pick<ScheduledTask, "schedule" | "paused">): string {
  const s = t.schedule;
  if (t.paused) return i18n.t("schedule.paused");
  if (s.kind === "daily") return i18n.t("schedule.daily", { time: s.time });
  if (s.kind === "weekdays") return i18n.t("schedule.weekdays", { time: s.time });
  if (s.kind === "weekly")
    return i18n.t("schedule.weekly", {
      day: i18n.t(DAY_KEYS[s.weekday ?? 1] ?? "days.sunday"),
      time: s.time,
    });
  if (s.kind === "monthly")
    return i18n.t("schedule.monthly", { day: s.monthDay ?? 1, time: s.time });
  if (s.kind === "manual") return i18n.t("schedule.manual");
  return i18n.t("schedule.interval", { min: s.intervalMin ?? 60 });
}

/** Tasarımdaki 34px form denetimi çerçevesi; Select ile aynı ölçüde. */
const CONTROL =
  "h-[34px] rounded-[10px] border border-line2 bg-card text-[14px] text-tx outline-none focus-within:border-tx3 focus-within:shadow-[0_0_0_3px_var(--accSoft)]";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <div className="text-[13px] font-medium text-tx2">
        {label}
        {required ? <span className="text-red"> *</span> : null}
      </div>
      {children}
    </div>
  );
}

/** Ayar satırı: 120px etiket, denetimler, altında yardım metni. */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-x-4">
      <div className="flex h-[34px] items-center text-[14px] text-tx">{label}</div>
      <div className="flex flex-col gap-[6px]">
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        {help ? <div className="text-[12px] leading-[1.5] text-tx3">{help}</div> : null}
      </div>
    </div>
  );
}

function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className={`flex w-[104px] items-center gap-2 px-[11px] ${CONTROL}`}>
      <Icon name="clock" size={14} className="text-tx2" />
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent tabular-nums outline-none [&::-webkit-calendar-picker-indicator]:hidden"
      />
    </label>
  );
}

function NumberField({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`w-[72px] px-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${CONTROL}`}
    />
  );
}

/** Yeni görev formunu ön dolduran hazır şablon (Zamanlanmış sayfasındaki öneriler). */
export type ScheduleTemplate = Pick<ScheduledTask, "title" | "prompt" | "schedule">;

/** Zamanlanmış görev tanımı / düzenleme; tasarım: "Zamanlanmış Görev Modalı" kanvası. */
export function ScheduleModal({
  initial,
  template,
  projectId,
  onClose,
}: {
  initial?: ScheduledTask;
  template?: ScheduleTemplate;
  projectId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  const { projects, saveTask, deleteTask, runNow } = useAssistant();
  const openMenu = useMenu((s) => s.openAt);
  const openPicker = useModelPicker((s) => s.openAt);
  const openSession = useApp((s) => s.openSession);
  const catalog = useModels((s) => s.catalog);
  const defaultModel = useModels((s) => s.model);
  const [task, setTask] = useState<ScheduledTask>(
    initial ?? {
      id: uid(),
      title: "",
      prompt: "",
      projectId,
      schedule: { kind: "daily", time: "09:00" },
      paused: false,
      model: null,
      permission: "full",
      allowWeb: false,
      lastRunAt: null,
      lastResult: null,
      lastSessionId: null,
      nextRunAt: null,
      ...template,
    },
  );
  const sch = task.schedule;
  const setSch = (patch: Partial<ScheduledTask["schedule"]>) =>
    setTask({ ...task, schedule: { ...sch, ...patch } });
  const modelName = (ref: { provider: string; id: string } | null) =>
    ref
      ? (catalog.find((c) => c.provider === ref.provider && c.id === ref.id)?.name ?? ref.id)
      : "";
  const project = projects.find((p) => p.id === task.projectId);
  const fmt = (ts: number) => new Date(ts).toLocaleString(localeTag(lang));

  const kinds = (Object.keys(KIND_KEYS) as Kind[]).map<SelectOption<Kind>>((k) => ({
    value: k,
    label: t(KIND_KEYS[k]),
  }));
  const modes = (Object.keys(PERMISSION_KEYS) as PermissionMode[]).map<
    SelectOption<PermissionMode>
  >((m) => ({ value: m, label: t(PERMISSION_KEYS[m]), icon: PERMISSION_ICONS[m] }));
  const days = DAY_KEYS.map<SelectOption<string>>((k, i) => ({ value: String(i), label: t(k) }));

  const pickProject = (e: React.MouseEvent<HTMLButtonElement>) =>
    openMenu(e.currentTarget, {
      minWidth: 200,
      items: [
        {
          label: t("schedule.noProject"),
          check: !task.projectId,
          active: !task.projectId,
          onSelect: () => setTask({ ...task, projectId: null }),
        },
        ...projects.map((p) => ({
          label: p.name,
          icon: "folder" as const,
          check: p.id === task.projectId,
          active: p.id === task.projectId,
          onSelect: () => setTask({ ...task, projectId: p.id }),
        })),
      ],
    });
  const pickModel = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    openMenu(anchor, {
      minWidth: 240,
      items: [
        {
          label: t("schedule.defaultModel"),
          desc: modelName(defaultModel),
          check: !task.model,
          active: !task.model,
          onSelect: () => setTask({ ...task, model: null }),
        },
        {
          label: t("schedule.pickModel"),
          ...(task.model ? { desc: modelName(task.model) } : {}),
          check: !!task.model,
          onSelect: () => openPicker(anchor, (ref) => setTask({ ...task, model: ref }), task.model),
        },
      ],
    });
  };

  const save = () => saveTask({ ...task, title: task.title.trim() });
  const nextWhen =
    !task.paused && sch.kind !== "manual" && task.nextRunAt
      ? t("schedule.nextRun", { when: fmt(task.nextRunAt) })
      : null;

  return (
    <Modal
      width={640}
      title={initial ? t("schedule.editTitle") : t("schedule.newTitle")}
      onClose={onClose}
      footer={
        <>
          {initial ? (
            <>
              <Button
                variant="ghost"
                size="lg"
                className="text-red hover:text-red"
                onClick={() => void deleteTask(task.id).then(onClose)}
              >
                {t("common.delete")}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => {
                  // Çalışma dakikalar sürebilir; modal beklemez, sonuç bildirimle ve listeyle gelir.
                  void save().then(() => runNow(task.id));
                  onClose();
                }}
              >
                <Icon name="play" size={13} />
                {t("schedule.runNow")}
              </Button>
            </>
          ) : null}
          <span className="flex-1" />
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t("common.dismiss")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!task.title.trim() || !task.prompt.trim()}
            onClick={() => void save().then(onClose)}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <Field label={t("schedule.titleLabel")} required>
          <input
            value={task.title}
            onChange={(e) => setTask({ ...task, title: e.target.value })}
            placeholder={t("schedule.titlePlaceholder")}
            className={`h-[38px] w-full px-3 placeholder:text-tx3 ${CONTROL}`}
          />
        </Field>
        <Field label={t("schedule.promptLabel")} required>
          <div className={`flex flex-col overflow-hidden ${CONTROL} h-auto`}>
            <textarea
              value={task.prompt}
              onChange={(e) => setTask({ ...task, prompt: e.target.value })}
              placeholder={t("schedule.promptPlaceholder")}
              className="min-h-[124px] w-full resize-none bg-transparent px-3 py-[10px] text-[14px] leading-[1.5] text-tx outline-none placeholder:text-tx3"
            />
            <div className="flex items-center gap-[6px] border-t border-line bg-tray px-2 py-[6px]">
              <Chip
                muted
                icon="folder"
                label={project ? project.name : t("schedule.selectProject")}
                onClick={pickProject}
              />
              <span className="flex-1" />
              <Chip
                mono={!!task.model}
                label={task.model ? modelName(task.model) : t("schedule.defaultModel")}
                {...(task.model ? { title: `${task.model.provider}/${task.model.id}` } : {})}
                onClick={pickModel}
              />
            </div>
          </div>
        </Field>

        <div className="h-px bg-line" />

        <div className="flex flex-col gap-[14px]">
          <Row
            label={t("schedule.frequency")}
            {...(sch.kind === "manual" ? { help: t("schedule.manualHelp") } : {})}
          >
            <Select
              width={160}
              value={sch.kind}
              options={kinds}
              onChange={(kind) => setSch({ kind })}
            />
            {sch.kind === "weekly" ? (
              <Select
                width={140}
                value={String(sch.weekday ?? 1)}
                options={days}
                onChange={(d) => setSch({ weekday: Number(d) })}
              />
            ) : null}
            {sch.kind === "monthly" ? (
              <>
                <NumberField
                  value={sch.monthDay ?? 1}
                  min={1}
                  max={28}
                  onChange={(monthDay) => setSch({ monthDay })}
                />
                <span className="text-[14px] text-tx2">{t("schedule.monthDaySuffix")}</span>
              </>
            ) : null}
            {sch.kind === "interval" ? (
              <>
                <NumberField
                  value={sch.intervalMin ?? 60}
                  min={5}
                  onChange={(intervalMin) => setSch({ intervalMin })}
                />
                <span className="text-[14px] text-tx2">{t("schedule.everyMinutes")}</span>
              </>
            ) : null}
            {sch.kind !== "interval" && sch.kind !== "manual" ? (
              <TimeField value={sch.time} onChange={(time) => setSch({ time })} />
            ) : null}
          </Row>
          <Row label={t("schedule.permission")} help={t(PERMISSION_HELP[task.permission])}>
            <Select
              width={188}
              value={task.permission}
              options={modes}
              onChange={(permission) => setTask({ ...task, permission })}
            />
          </Row>
          {/* Web yalnız Sor/Plan modunda sorulur; diğer modlarda satır anlamsız, gizlenir. */}
          {task.permission === "ask" || task.permission === "plan" ? (
            <Row label={t("schedule.web")} help={t("schedule.webHelp")}>
              <Toggle on={task.allowWeb} onChange={(allowWeb) => setTask({ ...task, allowWeb })} />
              <span className="text-[14px] text-tx">{t("schedule.webOn")}</span>
            </Row>
          ) : null}
          {initial ? (
            <Row label={t("schedule.status")}>
              <Toggle on={!task.paused} onChange={(on) => setTask({ ...task, paused: !on })} />
              <span className="text-[14px] text-tx">
                {task.paused ? t("schedule.inactive") : t("schedule.active")}
              </span>
              {nextWhen ? <span className="text-[13px] text-tx3">· {nextWhen}</span> : null}
            </Row>
          ) : null}
        </div>

        {initial && task.lastResult && task.lastRunAt ? (
          <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-card2 px-[14px] py-3">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-green" />
              <span className="flex-1 text-[13px] font-medium text-tx2">
                {t("schedule.lastRun", { when: fmt(task.lastRunAt) })}
              </span>
              {task.lastSessionId ? (
                <button
                  type="button"
                  className="text-[13px] text-accTx hover:text-tx"
                  onClick={() => {
                    if (task.lastSessionId) openSession(task.lastSessionId, "asistan");
                    onClose();
                  }}
                >
                  {t("schedule.openSession")}
                </button>
              ) : null}
            </div>
            <div className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-[1.55] text-tx2">
              {task.lastResult}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
