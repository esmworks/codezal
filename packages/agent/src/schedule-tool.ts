import type { ScheduledTask } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const SCHEDULE_TOOL = "schedule_task";

/** Main süreci görev deposunu bu köprüyle açar; ajan paketi Electron'u bilmez. */
export interface ScheduleBridge {
  list(): ScheduledTask[];
  save(task: ScheduledTask): ScheduledTask;
  remove(id: string): boolean;
  projects(): ReadonlyArray<{ id: string; name: string }>;
}

type Kind = ScheduledTask["schedule"]["kind"];
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);

/** Zamanlamanın okunur hâli; renderer'daki `describeSchedule` ile aynı metinler. */
export function describeScheduleText(task: ScheduledTask, lang: Locale): string {
  const d = dict(lang);
  const s = task.schedule;
  if (task.paused) return d.schedule.paused;
  if (s.kind === "daily") return fill(d.schedule.daily, { time: s.time });
  if (s.kind === "weekdays") return fill(d.schedule.weekdays, { time: s.time });
  if (s.kind === "weekly")
    return fill(d.schedule.weekly, {
      day: d.days[DAY_KEYS[s.weekday ?? 1] ?? "monday"],
      time: s.time,
    });
  if (s.kind === "monthly") return fill(d.schedule.monthly, { day: s.monthDay ?? 1, time: s.time });
  if (s.kind === "manual") return d.schedule.manual;
  return fill(d.schedule.interval, { min: s.intervalMin ?? 60 });
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Asistan sohbetinden zamanlanmış görev kurma aracı: oluştur, güncelle, sil, listele.
 * Görev, ana ekrandaki listeyle aynı depoya yazılır; kullanıcı formdan da düzenleyebilir.
 */
export function scheduleTool(
  bridge: ScheduleBridge,
  lang: Locale = "tr",
  projectId: string | null = null,
) {
  const d = dict(lang);
  const p = d.prompt;
  const text = (s: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text: s }],
    details,
  });
  const summary = (task: ScheduledTask, head: string) => {
    const project = task.projectId
      ? (bridge.projects().find((x) => x.id === task.projectId)?.name ?? d.schedule.noProject)
      : d.schedule.noProject;
    // Web izni yalnız Sor/Plan modunda anlamlıdır; diğer modlarda web zaten sorulmaz.
    const web =
      task.allowWeb && (task.permission === "ask" || task.permission === "plan")
        ? ` · ${d.schedule.webOn}`
        : "";
    return `${head}\n${task.title} · ${describeScheduleText(task, lang)} · ${project} · ${d.permissionMode[task.permission]}${web}`;
  };
  const resolveProject = (ref: string | undefined): { id: string | null } | { error: string } => {
    if (ref === undefined) return { id: projectId };
    if (ref === "") return { id: null };
    const all = bridge.projects();
    const hit = all.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
    if (hit) return { id: hit.id };
    return { error: fill(p.scheduleProjectNotFound, { names: all.map((x) => x.name).join(", ") }) };
  };

  return defineTool({
    name: SCHEDULE_TOOL,
    label: d.agent.tool.schedule,
    description: p.scheduleDesc,
    promptSnippet: p.scheduleSnippet,
    promptGuidelines: [p.scheduleGuideline],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("delete"),
          Type.Literal("list"),
        ],
        { description: p.scheduleAction },
      ),
      id: Type.Optional(Type.String({ description: p.scheduleId })),
      title: Type.Optional(
        Type.String({ minLength: 1, maxLength: 80, description: p.scheduleTitle }),
      ),
      prompt: Type.Optional(Type.String({ minLength: 1, description: p.schedulePrompt })),
      kind: Type.Optional(
        Type.Union(
          [
            Type.Literal("daily"),
            Type.Literal("weekdays"),
            Type.Literal("weekly"),
            Type.Literal("monthly"),
            Type.Literal("interval"),
            Type.Literal("manual"),
          ],
          { description: p.scheduleKind },
        ),
      ),
      time: Type.Optional(
        Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: p.scheduleTime }),
      ),
      weekday: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 6, description: p.scheduleWeekday }),
      ),
      monthDay: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 28, description: p.scheduleMonthDay }),
      ),
      intervalMin: Type.Optional(Type.Integer({ minimum: 5, description: p.scheduleIntervalMin })),
      project: Type.Optional(Type.String({ description: p.scheduleProject })),
      permission: Type.Optional(
        Type.Union(
          [
            Type.Literal("ask"),
            Type.Literal("auto-edit"),
            Type.Literal("plan"),
            Type.Literal("full"),
          ],
          { description: p.schedulePermission },
        ),
      ),
      allowWeb: Type.Optional(Type.Boolean({ description: p.scheduleAllowWeb })),
      paused: Type.Optional(Type.Boolean({ description: p.schedulePaused })),
    }),
    async execute(_id, params) {
      if (params.action === "list") {
        const tasks = bridge.list();
        if (tasks.length === 0) return text(p.scheduleListEmpty);
        return text(
          tasks.map((t) => `- ${t.title} (${t.id}) · ${describeScheduleText(t, lang)}`).join("\n"),
          { action: "list", tasks },
        );
      }
      if (params.action === "delete") {
        const cur = params.id ? bridge.list().find((t) => t.id === params.id) : undefined;
        if (!cur) return text(p.scheduleNotFound);
        bridge.remove(cur.id);
        // Silinen görevin son hâli sohbetteki kartta "silindi" satırı olarak kalır.
        return text(fill(p.scheduleDeleted, { title: cur.title }), { action: "delete", task: cur });
      }
      const cur =
        params.action === "update"
          ? params.id
            ? bridge.list().find((t) => t.id === params.id)
            : undefined
          : undefined;
      if (params.action === "update" && !cur) return text(p.scheduleNotFound);
      const title = (params.title ?? cur?.title ?? "").trim();
      const prompt = (params.prompt ?? cur?.prompt ?? "").trim();
      if (!title || !prompt) return text(p.scheduleMissing);
      const project = resolveProject(params.project);
      if ("error" in project) return text(project.error);
      const base = cur?.schedule ?? { kind: "daily" as Kind, time: "09:00" };
      const kind = params.kind ?? base.kind;
      const schedule: ScheduledTask["schedule"] = {
        kind,
        time: params.time ?? base.time,
        ...(kind === "weekly" ? { weekday: params.weekday ?? base.weekday ?? 1 } : {}),
        ...(kind === "monthly" ? { monthDay: params.monthDay ?? base.monthDay ?? 1 } : {}),
        ...(kind === "interval"
          ? { intervalMin: params.intervalMin ?? base.intervalMin ?? 60 }
          : {}),
      };
      const task: ScheduledTask = {
        id: cur?.id ?? newId(),
        title,
        prompt,
        projectId: params.project === undefined && cur ? cur.projectId : project.id,
        schedule,
        paused: params.paused ?? cur?.paused ?? false,
        model: cur?.model ?? null,
        permission: params.permission ?? cur?.permission ?? "full",
        allowWeb: params.allowWeb ?? cur?.allowWeb ?? false,
        lastRunAt: cur?.lastRunAt ?? null,
        lastResult: cur?.lastResult ?? null,
        lastSessionId: cur?.lastSessionId ?? null,
        nextRunAt: null,
      };
      const saved = bridge.save(task);
      // `action` sohbetteki görev kartını besler (kuruldu / güncellendi); renderer metni ayrıştırmaz.
      return text(summary(saved, cur ? p.scheduleUpdated : p.scheduleCreated), {
        action: cur ? "update" : "create",
        task: saved,
      });
    },
  });
}
