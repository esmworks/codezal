import type { ScheduledTask } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { type ScheduleBridge, scheduleTool } from "./schedule-tool.js";

function bridge(): ScheduleBridge & { store: ScheduledTask[] } {
  const store: ScheduledTask[] = [];
  return {
    store,
    list: () => store,
    save: (t) => {
      const i = store.findIndex((x) => x.id === t.id);
      if (i >= 0) store[i] = t;
      else store.push(t);
      return t;
    },
    remove: (id) => {
      const i = store.findIndex((x) => x.id === id);
      if (i < 0) return false;
      store.splice(i, 1);
      return true;
    },
    projects: () => [{ id: "p1", name: "Kişisel Finans" }],
  };
}

const run = (tool: ReturnType<typeof scheduleTool>, params: Record<string, unknown>) =>
  tool.execute("c1", params as never, undefined, undefined, {} as never);
const textOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.content[0]?.type === "text" ? r.content[0].text : "";

describe("schedule_task", () => {
  it("oluşturur: proje adıyla eşler, izin ve sıklık varsayılanları, özet döner", async () => {
    const b = bridge();
    const r = await run(scheduleTool(b, "tr"), {
      action: "create",
      title: "Sabah finans özeti",
      prompt: "Finans klasörünü özetle",
      kind: "weekdays",
      time: "08:30",
      project: "kişisel finans",
    });
    expect(b.store).toHaveLength(1);
    const t = b.store[0];
    expect(t?.projectId).toBe("p1");
    expect(t?.permission).toBe("full");
    expect(t?.schedule).toEqual({ kind: "weekdays", time: "08:30" });
    expect(textOf(r)).toContain("hafta içi 08:30 · Kişisel Finans · Tam erişim");
  });

  it("web iznini kaydeder, günceller ve Sor/Plan modunda özette gösterir", async () => {
    const b = bridge();
    const tool = scheduleTool(b, "tr");
    const r = await run(tool, {
      action: "create",
      title: "Haber",
      prompt: "Haberleri özetle",
      permission: "plan",
      allowWeb: true,
    });
    expect(b.store[0]?.allowWeb).toBe(true);
    expect(textOf(r)).toContain("Web'de arayabilir");
    // Verilmeyen alan korunur; kapatılabilir.
    await run(tool, { action: "update", id: b.store[0]?.id, title: "Haber 2" });
    expect(b.store[0]?.allowWeb).toBe(true);
    await run(tool, { action: "update", id: b.store[0]?.id, allowWeb: false });
    expect(b.store[0]?.allowWeb).toBe(false);
    // Tam erişimde web zaten sorulmaz; özet gereksiz not düşmez.
    const full = await run(tool, { action: "create", title: "A", prompt: "B", allowWeb: true });
    expect(textOf(full)).not.toContain("Web'de arayabilir");
  });

  it("oturumun projesini varsayılan alır, bilinmeyen projeyi listeyle reddeder", async () => {
    const b = bridge();
    const tool = scheduleTool(b, "tr", "p1");
    await run(tool, { action: "create", title: "A", prompt: "B", kind: "manual" });
    expect(b.store[0]?.projectId).toBe("p1");
    const r = await run(tool, { action: "create", title: "A", prompt: "B", project: "Yok" });
    expect(textOf(r)).toContain("Kişisel Finans");
    expect(b.store).toHaveLength(1);
  });

  it("günceller: verilmeyen alanlar korunur, haftalık gün eklenir", async () => {
    const b = bridge();
    const tool = scheduleTool(b, "en");
    await run(tool, {
      action: "create",
      title: "Weekly",
      prompt: "Do it",
      kind: "daily",
      time: "10:00",
    });
    const id = b.store[0]?.id ?? "";
    const r = await run(tool, { action: "update", id, kind: "weekly", weekday: 5 });
    expect(b.store[0]?.schedule).toEqual({ kind: "weekly", time: "10:00", weekday: 5 });
    expect(b.store[0]?.prompt).toBe("Do it");
    expect(textOf(r)).toContain("Friday at 10:00");
  });

  it("eksik başlık ya da talimat kaydetmez; silme ve listeleme", async () => {
    const b = bridge();
    const tool = scheduleTool(b, "tr");
    expect(textOf(await run(tool, { action: "create", title: "A" }))).toContain("gerekli");
    expect(textOf(await run(tool, { action: "list" }))).toContain("yok");
    await run(tool, { action: "create", title: "A", prompt: "B" });
    const id = b.store[0]?.id ?? "";
    expect(textOf(await run(tool, { action: "list" }))).toContain(id);
    expect(textOf(await run(tool, { action: "delete", id }))).toContain("silindi");
    expect(b.store).toHaveLength(0);
    expect(textOf(await run(tool, { action: "delete", id }))).toContain("bulunamadı");
  });

  it("sonuç ayrıntısı eylemi ve görevi taşır (sohbetteki görev kartı)", async () => {
    const b = bridge();
    const tool = scheduleTool(b, "tr");
    const created = await run(tool, { action: "create", title: "A", prompt: "B" });
    const id = b.store[0]?.id ?? "";
    expect(created.details).toMatchObject({ action: "create", task: { id, title: "A" } });
    const updated = await run(tool, { action: "update", id, title: "A2" });
    expect(updated.details).toMatchObject({ action: "update", task: { id, title: "A2" } });
    const listed = await run(tool, { action: "list" });
    expect(listed.details).toMatchObject({ action: "list", tasks: [{ id, title: "A2" }] });
    const deleted = await run(tool, { action: "delete", id });
    expect(deleted.details).toMatchObject({ action: "delete", task: { id, title: "A2" } });
    // Hatalı çağrı ayrıntı taşımaz: kart yerine genel araç satırı kalır.
    expect((await run(tool, { action: "delete", id })).details).toEqual({});
    expect((await run(tool, { action: "create", title: "X" })).details).toEqual({});
  });
});
