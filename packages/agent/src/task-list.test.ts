import { describe, expect, it } from "vitest";
import { formatTaskList, taskListTool } from "./task-list.js";

describe("task_list", () => {
  it("adımları kontrol listesi olarak biçimler (bitti x, yapılıyor -, bekliyor boşluk)", () => {
    expect(
      formatTaskList([
        { title: "Oku", status: "done" },
        { title: "Çiz", status: "active" },
        { title: "Kaydet", status: "pending" },
      ]),
    ).toBe("- [x] Oku\n- [-] Çiz\n- [ ] Kaydet");
  });

  it("araç listeyi ve özeti döndürür, adım başlıklarını kırpar", async () => {
    const tool = taskListTool("tr");
    const r = await tool.execute(
      "t1",
      {
        steps: [
          { title: "  Oku ", status: "done" },
          { title: "Çiz", status: "pending" },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    expect(text).toContain("- [x] Oku\n- [ ] Çiz");
    expect(text).toContain("2 adım kaydedildi (1 bitti, 1 açık).");
    // Açık adım varken hatırlatıcı eklenir: modeller listeyi tur sonuna kadar kapatmıyordu.
    expect(text).toContain("Açık adım: 1");
    expect(r.details).toEqual({
      steps: [
        { title: "Oku", status: "done" },
        { title: "Çiz", status: "pending" },
      ],
    });
  });

  it("tüm adımlar bittiyse hatırlatıcı yazılmaz", async () => {
    const tool = taskListTool("tr");
    const r = await tool.execute(
      "t2",
      { steps: [{ title: "Oku", status: "done" }] },
      undefined,
      undefined,
      {} as never,
    );
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    expect(text).toContain("1 adım kaydedildi (1 bitti, 0 açık).");
    expect(text).not.toContain("Açık adım:");
  });
});
