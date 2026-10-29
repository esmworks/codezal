import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const TASK_LIST_TOOL = "task_list";
const MAX_STEPS = 30;

export type TaskStatus = "pending" | "active" | "done";
export interface TaskStep {
  title: string;
  status: TaskStatus;
}

/**
 * Adım listesinin metin hâli: renderer'ın ilerleme kutusu bu kontrol listesini okur
 * (`- [x]` bitti, `- [-]` yapılıyor, `- [ ]` bekliyor). Model de aynı metni sonuç olarak alır.
 */
export function formatTaskList(steps: readonly TaskStep[]): string {
  return steps
    .map((s) => `- [${s.status === "done" ? "x" : s.status === "active" ? "-" : " "}] ${s.title}`)
    .join("\n");
}

/**
 * Çok adımlı iş için adım listesi aracı. Modelin sohbet metnine gömdüğü kontrol listesi
 * yerine yapılandırılmış bir kayıt: uzun turda kullanıcı hangi adımda olunduğunu kutudan görür,
 * model de bağlamı disipline eder. Her çağrı listenin tamamını alır (kısmi güncelleme yok).
 */
export function taskListTool(lang: Locale = "tr") {
  const d = dict(lang);
  return defineTool({
    name: TASK_LIST_TOOL,
    label: d.agent.tool.tasks,
    description: d.prompt.taskListDesc,
    promptSnippet: d.prompt.taskListSnippet,
    promptGuidelines: [d.prompt.taskListGuideline],
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          title: Type.String({ minLength: 1, maxLength: 80, description: d.prompt.taskListTitle }),
          status: Type.Union(
            [Type.Literal("pending"), Type.Literal("active"), Type.Literal("done")],
            { description: d.prompt.taskListStatus },
          ),
        }),
        { minItems: 1, maxItems: MAX_STEPS, description: d.prompt.taskListSteps },
      ),
    }),
    async execute(_id, params) {
      const steps: TaskStep[] = params.steps.map((s) => ({
        title: s.title.trim(),
        status: s.status,
      }));
      const done = steps.filter((s) => s.status === "done").length;
      // Kalan adım sayısı özette de görünür: model listeyi her güncellemede açık işi hatırlar.
      const open = steps.length - done;
      const summary = (
        steps.length === 1 ? d.prompt.taskListSaved_one : d.prompt.taskListSaved_other
      )
        .replace("{{count}}", String(steps.length))
        .replace("{{done}}", String(done))
        .replace("{{open}}", String(open));
      // Liste kurulduğu anda açık adım varsa hatırlatıcı eklenir: modeller açık adımları tur sonuna
      // kadar kapatmadan bırakıyordu (oturum kayıtlarında turların ~%31'i).
      const reminder =
        open > 0 ? `\n\n${d.prompt.taskListKeepClosing.replace("{{open}}", String(open))}` : "";
      return {
        content: [{ type: "text", text: `${formatTaskList(steps)}\n\n${summary}${reminder}` }],
        details: { steps },
      };
    },
  });
}
