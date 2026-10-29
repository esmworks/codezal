import { describe, expect, it } from "vitest";
import {
  activeStepOf,
  openStepsOfLastTurn,
  type ProgressStep,
  progressSteps,
  taskListSteps,
  visibleSteps,
} from "./progress";

describe("progressSteps", () => {
  it("task_list aracının çıktısı metindeki listeye üstün gelir, [-] yapılıyor demektir", () => {
    const steps = progressSteps([
      { type: "assistant", id: "a1", text: "- [ ] Eski plan", streaming: false, at: 1 },
      {
        type: "tool",
        id: "t1",
        toolName: "task_list",
        kind: "other",
        status: "done",
        title: "Adımlar",
        output: "- [x] Oku\n- [-] Çiz\n- [ ] Kaydet\n\n3 adım kaydedildi (1 bitti).",
        startedAt: 2,
        endedAt: 3,
      },
    ]);
    expect(steps).toEqual([
      { label: "Oku", done: true },
      { label: "Çiz", done: false, active: true },
      { label: "Kaydet", done: false },
    ]);
  });

  it("son kontrol listesini adım yapar; düz yanıt cümleleri adım sayılmaz", () => {
    const steps = progressSteps([
      { type: "user", id: "u", text: "x", at: 1 },
      { type: "assistant", id: "a1", text: "Evet Erhan, var.", streaming: false, at: 2 },
      {
        type: "assistant",
        id: "a2",
        text: "Plan:\n- [x] **Ekstre** okundu\n1. [ ] Kategorileme\n* [X] Özet",
        streaming: false,
        at: 3,
      },
      { type: "assistant", id: "a3", text: "Tamam, kaydettim.", streaming: false, at: 4 },
    ]);
    expect(steps).toEqual([
      { label: "Ekstre okundu", done: true },
      { label: "Kategorileme", done: false },
      { label: "Özet", done: true },
    ]);
  });

  it("kontrol listesi yoksa boş döner", () => {
    expect(
      progressSteps([
        { type: "assistant", id: "a", text: "## Başlık\n- madde", streaming: false, at: 1 },
      ]),
    ).toEqual([]);
  });
});

describe("openStepsOfLastTurn", () => {
  const listTool = (output: string) => ({
    type: "tool" as const,
    id: "t1",
    toolName: "task_list",
    kind: "other" as const,
    status: "done" as const,
    title: "Adımlar",
    output,
    startedAt: 2,
    endedAt: 3,
  });

  it("son turda açık bırakılan adımları döndürür", () => {
    expect(
      openStepsOfLastTurn([
        { type: "user", id: "u1", text: "iş", at: 1 },
        listTool("- [x] Oku\n- [ ] Çiz"),
      ]).map((s) => s.label),
    ).toEqual(["Çiz"]);
  });

  it("tamamlanan listede açık adım kalmaz", () => {
    expect(
      openStepsOfLastTurn([
        { type: "user", id: "u1", text: "iş", at: 1 },
        listTool("- [x] Oku\n- [x] Çiz"),
      ]),
    ).toEqual([]);
  });

  it("önceki turda kalan liste yeni turda dönmez (kutu takılı kalmaz)", () => {
    expect(
      openStepsOfLastTurn([
        { type: "user", id: "u1", text: "iş", at: 1 },
        listTool("- [ ] Çiz"),
        { type: "user", id: "u2", text: "başka iş", at: 4 },
        { type: "assistant", id: "a2", text: "Tamam.", streaming: false, at: 5 },
      ]),
    ).toEqual([]);
  });
});

describe("visibleSteps", () => {
  const step = (label: string, done: boolean): ProgressStep => ({ label, done });
  const many = (prefix: string, count: number, done: boolean): ProgressStep[] =>
    Array.from({ length: count }, (_, i) => step(`${prefix} ${i + 1}`, done));

  it("açık adım son 4'ün dışında olsa da gösterilir (11/12 senaryosu)", () => {
    // `slice(-4)` yalnızca sondaki dört ✓ satırını gösterip açık adımı gizliyordu.
    const steps = [...many("bitti", 8, true), step("açık adım", false), ...many("son", 3, true)];
    const { shown, hidden } = visibleSteps(steps);
    expect(shown.map((s) => s.label)).toEqual(["açık adım", "son 1", "son 2", "son 3"]);
    expect(hidden).toBe(8);
  });

  it("hiç açık adım yoksa en son tamamlananlar gösterilir", () => {
    const { shown, hidden } = visibleSteps(many("adım", 6, true));
    expect(shown.map((s) => s.label)).toEqual(["adım 3", "adım 4", "adım 5", "adım 6"]);
    expect(hidden).toBe(2);
  });

  it("tamamlanmamış (active) adım da açık sayılır", () => {
    const steps: ProgressStep[] = [
      ...many("bitti", 5, true),
      { label: "yapılıyor", done: false, active: true },
    ];
    expect(visibleSteps(steps).shown.map((s) => s.label)).toEqual([
      "bitti 3",
      "bitti 4",
      "bitti 5",
      "yapılıyor",
    ]);
  });

  it("açık adımlar yuvayı doldurunca bitenler gösterilmez (slice(-0) tuzağı)", () => {
    const steps = [step("a", true), ...many("açık", 5, false)];
    const { shown, hidden } = visibleSteps(steps);
    expect(shown.map((s) => s.label)).toEqual(["açık 1", "açık 2", "açık 3", "açık 4"]);
    expect(hidden).toBe(2);
  });

  it("kısa listede hepsi görünür, gizli adım olmaz", () => {
    const steps = [step("a", true), step("b", false)];
    expect(visibleSteps(steps)).toEqual({ shown: steps, hidden: 0 });
  });
});

describe("taskListSteps / activeStepOf", () => {
  const output = "- [x] Oku\n- [x] Çiz\n- [-] Kaydet\n- [ ] Sına";

  it("araç çıktısını adımlara çevirir", () => {
    expect(taskListSteps(output)).toEqual([
      { label: "Oku", done: true },
      { label: "Çiz", done: true },
      { label: "Kaydet", done: false, active: true },
      { label: "Sına", done: false },
    ]);
  });

  it("güncel adımı yapılmakta olandan seçer", () => {
    expect(activeStepOf(taskListSteps(output))?.label).toBe("Kaydet");
  });

  it("yapılmakta olan yoksa ilk bitmemiş adımı seçer", () => {
    const steps = taskListSteps("- [x] Oku\n- [ ] Çiz\n- [ ] Sına");
    expect(activeStepOf(steps)?.label).toBe("Çiz");
  });

  it("hepsi bittiyse son adımı seçer (kart boş kalmasın)", () => {
    const steps = taskListSteps("- [x] Oku\n- [x] Çiz");
    expect(activeStepOf(steps)?.label).toBe("Çiz");
  });

  it("boş çıktıda adım üretmez", () => {
    expect(taskListSteps("")).toEqual([]);
    expect(activeStepOf([])).toBeUndefined();
  });
});
