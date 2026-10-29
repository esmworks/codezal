import type { ScheduleToolTask, ToolCallItem } from "@codezal/contracts";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { describeSchedule, ScheduleModal } from "../screens/asistan/ScheduleModal";
import { useAssistant } from "../stores/assistant";
import { humanizeError, toast } from "../stores/toast";
import { PERMISSION_ICONS } from "./chips";

/** Asistanın zamanlanmış görev aracı (`packages/agent/src/schedule-tool.ts` ile aynı ad). */
export const SCHEDULE_TOOL = "schedule_task";

/** Kartta çizilecek tek görev: son eylem ve aracın döndürdüğü anlık görüntü. */
export interface ScheduleEntry {
  action: "create" | "update" | "delete";
  task: ScheduleToolTask;
}

/**
 * Turun `schedule_task` çağrılarından kart listesi. Aynı görev turda birden çok kez değiştiyse
 * (kur, sonra güncelle) yalnız son hâli kalır, ilk görüldüğü sırada. Listeleme kart üretmez:
 * çalışma dizisindeki araç satırı yeter, kart yalnız bir şey değiştiğinde anlamlıdır.
 */
export function scheduleEntries(tools: readonly ToolCallItem[]): ScheduleEntry[] {
  const byId = new Map<string, ScheduleEntry>();
  for (const item of tools) {
    if (item.toolName !== SCHEDULE_TOOL || item.status !== "done" || !item.schedule) continue;
    const { action, tasks } = item.schedule;
    if (action === "list") continue;
    for (const task of tasks) {
      // Silinip yeniden eklenmesin diye sıra ilk görülen yerde kalır; Map anahtar sırasını korur.
      byId.set(task.id, { action, task });
    }
  }
  return [...byId.values()];
}

/**
 * Tur sonundaki zamanlanmış görev kartları. Çalışma dizisi tur bitince katlanır; kart onun
 * dışında, belge kartları gibi yanıtın altında durur ki "Düzenle" ve "Şimdi çalıştır" görünür kalsın.
 */
export function ScheduleCards({ tools }: { tools: readonly ToolCallItem[] }) {
  const entries = scheduleEntries(tools);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e) => (
        <ScheduleCard key={e.task.id} entry={e} />
      ))}
    </div>
  );
}

export function ScheduleCard({ entry }: { entry: ScheduleEntry }) {
  const { t } = useTranslation();
  const live = useAssistant((s) => s.tasks.find((x) => x.id === entry.task.id));
  const projects = useAssistant((s) => s.projects);
  const runNow = useAssistant((s) => s.runNow);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);

  if (entry.action === "delete") {
    return (
      <div className="flex min-w-0 items-center gap-2 self-start rounded-[12px] border border-line bg-card2 px-3 py-2 text-[13px]">
        <Icon name="trash" size={14} className="shrink-0 text-tx3" />
        <span className="shrink-0 text-tx3">{t("schedule.cardDeleted")}</span>
        <span className="min-w-0 truncate text-tx2" title={entry.task.title}>
          {entry.task.title}
        </span>
      </div>
    );
  }

  // Güncel hâl depodan: kullanıcı karttan ya da Zamanlanmış sayfasından düzenlediyse kart da
  // değişir. Görev artık yoksa aracın döndürdüğü son hâl çizilir, düğmeler kapanır.
  const task: ScheduleToolTask = live ?? entry.task;
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const web = task.allowWeb && (task.permission === "ask" || task.permission === "plan");
  const head = entry.action === "update" ? t("schedule.cardUpdated") : t("schedule.cardCreated");

  const run = async () => {
    if (!live || running) return;
    setRunning(true);
    try {
      await runNow(live.id);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-w-0 max-w-[560px] flex-col gap-2 rounded-[12px] border border-line bg-card2 px-4 pt-[12px] pb-3">
      <div className="flex items-center gap-[6px] text-[12px] text-tx3">
        <Icon name="clock" size={13} className="shrink-0" />
        <span>{head}</span>
      </div>
      <div className="truncate text-[15px] font-medium text-tx" title={task.title}>
        {task.title}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-[6px] text-[12px] text-tx3">
        <span
          title={t("schedule.frequency")}
          className={`shrink-0 rounded-[4px] px-[7px] py-[2px] font-medium ${
            task.paused ? "bg-chip text-tx3" : "bg-[var(--addBg)] text-add"
          }`}
        >
          {describeSchedule(task)}
        </span>
        <span className="flex min-w-0 items-center gap-[5px]">
          <Icon name="folder" size={13} className="shrink-0" />
          <span className="truncate">{project ? project.name : t("scheduled.noProject")}</span>
        </span>
        <span className="flex min-w-0 items-center gap-[5px]" title={t("schedule.permission")}>
          <Icon name={PERMISSION_ICONS[task.permission]} size={13} className="shrink-0" />
          <span className="truncate">{t(`permissionMode.${task.permission}`)}</span>
        </span>
        {web ? (
          <span className="flex items-center gap-[5px]" title={t("schedule.webOn")}>
            <Icon name="globe" size={13} className="shrink-0" />
            {t("schedule.web")}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" disabled={!live} onClick={() => setEditing(true)}>
          <Icon name="pen" size={12} />
          {t("schedule.cardEdit")}
        </Button>
        <Button size="sm" disabled={!live || running} onClick={() => void run()}>
          <Icon name="play" size={12} />
          {running ? t("schedule.cardRunning") : t("schedule.runNow")}
        </Button>
        {live ? null : <span className="text-[12px] text-tx3">{t("schedule.cardMissing")}</span>}
      </div>
      {/* Form sohbetin kaydırma kabının dışına basılır: kabın maskesi sabit konumlu modalı da
          soldurup kırpıyordu. Görev bu arada silinirse form kendiliğinden kapanır. */}
      {editing && live
        ? createPortal(
            <ScheduleModal
              key={live.id}
              initial={live}
              projectId={live.projectId}
              onClose={() => setEditing(false)}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
