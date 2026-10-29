import { join } from "node:path";
import {
  AppSettings,
  AssistantContext,
  type AssistantProject,
  ScheduledTask,
  type UsageEntry,
} from "@codezal/contracts";
import { z } from "zod";
import type { BudgetNotified } from "./budget.js";
import { JsonStore } from "./store.js";

const SettingsFile = AppSettings;
const UsageFile = z.object({
  entries: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        month: z.string(),
        day: z.string().optional(),
        input: z.number(),
        output: z.number(),
        requests: z.number(),
        cost: z.number().default(0),
      }),
    )
    .default([]),
  /** Para bütçesi uyarılarından bu ay hangileri gösterildi (bkz. `budget.ts`). */
  budgetNotified: z
    .object({ month: z.string(), limit: z.number(), thresholds: z.array(z.number()) })
    .optional(),
});
// Görev şeması sözleşmeyle ortak; alan eklemek için yalnızca `ScheduledTask` değişir.
const ScheduleFile = z.object({ tasks: z.array(ScheduledTask).default([]) });
const ProjectsFile = z.object({
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().default(""),
        instructions: z.string().default(""),
        memory: z.array(z.string()).default([]),
        context: z.array(AssistantContext).default([]),
        createdAt: z.number(),
      }),
    )
    .default([]),
});

/** YYYY-AA-GG, yerel saat diliminde. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** userData altındaki tüm JSON mağazaları tek yerde. */
export class AppStores {
  readonly settings: JsonStore<typeof SettingsFile>;
  readonly usage: JsonStore<typeof UsageFile>;
  readonly schedule: JsonStore<typeof ScheduleFile>;
  readonly assistant: JsonStore<typeof ProjectsFile>;

  constructor(userData: string) {
    this.settings = new JsonStore(join(userData, "settings.json"), SettingsFile);
    this.usage = new JsonStore(join(userData, "usage.json"), UsageFile);
    this.schedule = new JsonStore(join(userData, "schedule.json"), ScheduleFile);
    this.assistant = new JsonStore(join(userData, "assistant.json"), ProjectsFile);
  }

  addUsage(
    provider: string,
    model: string,
    input: number,
    output: number,
    cost = 0,
    now = new Date(),
  ): void {
    // Yerel gün: kullanıcı gece yarısına göre "bugün"ü kendi saat diliminde görür.
    const day = localDay(now);
    const month = day.slice(0, 7);
    const entries = [...this.usage.get().entries];
    const idx = entries.findIndex(
      (e) => e.provider === provider && e.model === model && e.day === day,
    );
    const cur = entries[idx];
    if (cur) {
      entries[idx] = {
        ...cur,
        input: cur.input + input,
        output: cur.output + output,
        requests: cur.requests + 1,
        cost: cur.cost + cost,
      };
    } else entries.push({ provider, model, month, day, input, output, requests: 1, cost });
    // Diğer alanlar (bütçe bildirim kaydı) korunur.
    this.usage.set({ ...this.usage.get(), entries });
  }

  budgetNotified(): BudgetNotified | undefined {
    return this.usage.get().budgetNotified;
  }

  setBudgetNotified(next: BudgetNotified | undefined): void {
    this.usage.set({ ...this.usage.get(), budgetNotified: next });
  }

  usageEntries(): UsageEntry[] {
    return this.usage.get().entries;
  }

  tasks(): ScheduledTask[] {
    return this.schedule.get().tasks;
  }

  saveTask(task: ScheduledTask): ScheduledTask {
    const tasks = this.tasks().filter((t) => t.id !== task.id);
    tasks.push(task);
    this.schedule.set({ tasks });
    return task;
  }

  deleteTask(id: string): void {
    this.schedule.set({ tasks: this.tasks().filter((t) => t.id !== id) });
  }

  projects(): AssistantProject[] {
    return this.assistant.get().projects;
  }

  saveProject(p: AssistantProject): AssistantProject {
    // Sıra kullanıcının: yeni proje başa eklenir, var olan kayıt yerinde güncellenir.
    const projects = this.projects();
    const known = projects.some((x) => x.id === p.id);
    this.assistant.set({
      projects: known ? projects.map((x) => (x.id === p.id ? p : x)) : [p, ...projects],
    });
    return p;
  }

  /** Manuel sıra: verilen kimlikler sıraya göre dizilir, eksik kalanlar sona atılır. */
  reorderProjects(ids: string[]): AssistantProject[] {
    const rank = new Map(ids.map((id, i) => [id, i]));
    const projects = [...this.projects()].sort(
      (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
    );
    this.assistant.set({ projects });
    return projects;
  }

  deleteProject(id: string): void {
    this.assistant.set({ projects: this.projects().filter((x) => x.id !== id) });
  }
}
