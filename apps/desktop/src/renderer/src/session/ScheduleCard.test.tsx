import type { ScheduledTask, ScheduleToolTask, ToolCallItem } from "@codezal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Statik çizimde zustand ilk durumu okur (sunucu anlık görüntüsü); depo seçiciyle taklit edilir.
const store = vi.hoisted(() => ({
  state: { tasks: [] as unknown[], projects: [] as unknown[], runNow: async () => {} },
}));
vi.mock("../api", () => ({ invoke: vi.fn(), on: () => () => {} }));
vi.mock("../stores/assistant", () => ({
  useAssistant: (sel: (s: typeof store.state) => unknown) => sel(store.state),
  uid: () => "x",
}));

import type { AssistantProject } from "@codezal/contracts";
import { i18n } from "../lib/i18n";
import { ScheduleCards, scheduleEntries } from "./ScheduleCard";

const setStore = (patch: { tasks?: ScheduledTask[]; projects?: AssistantProject[] }) => {
  store.state = { ...store.state, ...patch };
};

const visible = (html: string) => html.replace(/<[^>]+>/g, "");

const snap = (over: Partial<ScheduleToolTask> = {}): ScheduleToolTask => ({
  id: "g1",
  title: "Sabah özeti",
  projectId: "p1",
  schedule: { kind: "weekdays", time: "08:30" },
  paused: false,
  permission: "plan",
  allowWeb: false,
  ...over,
});

const stored = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  ...snap(),
  prompt: "Özetle",
  model: null,
  lastRunAt: null,
  lastResult: null,
  lastSessionId: null,
  nextRunAt: null,
  ...over,
});

const call = (
  schedule: ToolCallItem["schedule"],
  over: Partial<ToolCallItem> = {},
): ToolCallItem => ({
  type: "tool",
  id: `t-${Math.random()}`,
  toolName: "schedule_task",
  kind: "other",
  status: "done",
  title: "Zamanlandı",
  startedAt: 1,
  endedAt: 2,
  ...(schedule ? { schedule } : {}),
  ...over,
});

/** Düğmenin `disabled` özniteliği: etiket metniyle bulunur. */
const buttonDisabled = (html: string, label: string) => {
  const button = html.split("<button").find((b) => b.includes(label));
  // Sınıf adlarında da `disabled:` geçer; yalnız öznitelik sayılır.
  return / disabled=""/.test(button?.split(">")[0] ?? "");
};

describe("sohbetteki zamanlanmış görev kartı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });
  beforeEach(() => {
    setStore({
      tasks: [stored()],
      projects: [
        {
          id: "p1",
          name: "Kişisel Finans",
          description: "",
          instructions: "",
          memory: [],
          context: [],
          createdAt: 1,
        },
      ],
    });
  });

  it("başlık, sıklık, proje ve izni yazar; düğmeler açık", () => {
    const html = renderToStaticMarkup(
      <ScheduleCards tools={[call({ action: "create", tasks: [snap()] })]} />,
    );
    const text = visible(html);
    expect(text).toContain("Zamanlanmış görev kuruldu");
    expect(text).toContain("Sabah özeti");
    expect(text).toContain("hafta içi 08:30");
    expect(text).toContain("Kişisel Finans");
    expect(text).toContain("Plan modu");
    expect(buttonDisabled(html, "Düzenle")).toBe(false);
    expect(buttonDisabled(html, "Şimdi çalıştır")).toBe(false);
  });

  it("güncel hâli depodan okur: karttan sonra yapılan düzenleme görünür", () => {
    setStore({
      tasks: [stored({ title: "Yeni ad", projectId: null, permission: "full" })],
    });
    const text = visible(
      renderToStaticMarkup(<ScheduleCards tools={[call({ action: "update", tasks: [snap()] })]} />),
    );
    expect(text).toContain("Zamanlanmış görev güncellendi");
    expect(text).toContain("Yeni ad");
    expect(text).toContain("Projesiz");
    expect(text).toContain("Tam erişim");
  });

  it("görev artık yoksa son hâli çizer, düğmeler kapanır", () => {
    setStore({ tasks: [] });
    const html = renderToStaticMarkup(
      <ScheduleCards tools={[call({ action: "create", tasks: [snap()] })]} />,
    );
    expect(visible(html)).toContain("Sabah özeti");
    expect(visible(html)).toContain("Bu görev artık yok.");
    expect(buttonDisabled(html, "Düzenle")).toBe(true);
    expect(buttonDisabled(html, "Şimdi çalıştır")).toBe(true);
  });

  it("silme kısa bir satırdır, düğme taşımaz", () => {
    setStore({ tasks: [] });
    const html = renderToStaticMarkup(
      <ScheduleCards tools={[call({ action: "delete", tasks: [snap()] })]} />,
    );
    expect(visible(html)).toContain("Zamanlanmış görev silindi");
    expect(visible(html)).toContain("Sabah özeti");
    expect(html).not.toContain("<button");
  });

  it("listeleme, hatalı ve ayrıntısız çağrı kart üretmez", () => {
    const html = renderToStaticMarkup(
      <ScheduleCards
        tools={[
          call({ action: "list", tasks: [snap()] }),
          call({ action: "create", tasks: [snap()] }, { status: "error" }),
          call(undefined),
        ]}
      />,
    );
    expect(html).toBe("");
  });

  it("aynı görevin turdaki son eylemi kalır, sırası ilk görüldüğü yerdir", () => {
    const entries = scheduleEntries([
      call({ action: "create", tasks: [snap()] }),
      call({ action: "create", tasks: [snap({ id: "g2", title: "B" })] }),
      call({ action: "delete", tasks: [snap()] }),
    ]);
    expect(entries.map((e) => [e.task.id, e.action])).toEqual([
      ["g1", "delete"],
      ["g2", "create"],
    ]);
  });
});
