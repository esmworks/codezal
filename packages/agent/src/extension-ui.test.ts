import type { ExtensionUiRequest } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { ExtensionUiBridge } from "./extension-ui.js";

function setup() {
  const requests: ExtensionUiRequest[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const unsupported: string[] = [];
  const cancelled: string[][] = [];
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const bridge = new ExtensionUiBridge("s1", {
    onRequest: (r) => requests.push(r),
    onNotify: (message, level) => notices.push({ message, level }),
    onUnsupported: (m) => unsupported.push(m),
    onWidget: (key, lines) => widgets.push({ key, lines }),
    onCancelled: (ids) => cancelled.push(ids),
  });
  return { bridge, ui: bridge.create(), requests, notices, unsupported, cancelled, widgets };
}

/** İlk isteği döner; test akışında istek yoksa hata verir. */
function first(requests: ExtensionUiRequest[]): ExtensionUiRequest {
  const request = requests[0];
  if (!request) throw new Error("istek yok");
  return request;
}

describe("ExtensionUiBridge", () => {
  it("confirm kartını gösterir ve cevabı çözer", async () => {
    const { bridge, ui, requests } = setup();
    const answer = ui.confirm("Dosya silinsin mi?", "Geri alınamaz");
    const request = first(requests);
    expect(request).toMatchObject({
      sessionId: "s1",
      kind: "confirm",
      title: "Dosya silinsin mi?",
      message: "Geri alınamaz",
      options: null,
      placeholder: null,
    });
    expect(bridge.respond(request.requestId, true)).toBe(true);
    await expect(answer).resolves.toBe(true);
  });

  it("select seçimi metin, iptali undefined döner", async () => {
    const { bridge, ui, requests } = setup();
    const picked = ui.select("Hangisi?", ["a", "b"]);
    bridge.respond(first(requests).requestId, "b");
    await expect(picked).resolves.toBe("b");

    const cancelled = ui.select("Hangisi?", ["a"]);
    // İkinci istek listede henüz yoktu; kuyruğa giren son isteği kullan.
    const pending = requests.at(-1);
    bridge.respond(pending?.requestId ?? "", null);
    await expect(cancelled).resolves.toBeUndefined();
  });

  it("input metni döner, notify toast listesine düşer", async () => {
    const { bridge, ui, requests, notices } = setup();
    const typed = ui.input("Ad?", "yer tutucu");
    expect(first(requests).placeholder).toBe("yer tutucu");
    bridge.respond(first(requests).requestId, "Erhan");
    await expect(typed).resolves.toBe("Erhan");

    ui.notify("İşlem bitti", "warning");
    expect(notices).toEqual([{ message: "İşlem bitti", level: "warning" }]);
  });

  it("aynı anda tek kart gösterir, sıradakini bekletir", async () => {
    const { bridge, ui, requests } = setup();
    const one = ui.confirm("Bir", "1");
    const two = ui.confirm("İki", "2");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe("Bir");
    bridge.respond(first(requests).requestId, true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.title).toBe("İki");
    bridge.respond(requests[1]?.requestId ?? "", false);
    await expect(one).resolves.toBe(true);
    await expect(two).resolves.toBe(false);
  });

  it("cancelAll bekleyenleri varsayılanla çözer ve iptali bildirir", async () => {
    const { bridge, ui, requests, cancelled } = setup();
    const confirmed = ui.confirm("Onay", "devam?");
    const selected = ui.select("Seç", ["x"]);
    bridge.cancelAll();
    await expect(confirmed).resolves.toBe(false);
    await expect(selected).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    // Karttaki istek de kuyruktaki istek de iptal edildi; renderer ikisinin kartını kaldırır.
    expect(cancelled[0]).toHaveLength(2);
    expect(cancelled[0]).toContain(first(requests).requestId);
  });

  it("zaman aşımında kart kapanır ve varsayılan döner", async () => {
    const { ui } = setup();
    await expect(ui.confirm("Süre", "doldu", { timeout: 5 })).resolves.toBe(false);
  });

  it("iptal edilmiş sinyalde kart hiç gösterilmez", async () => {
    const { ui, requests } = setup();
    await expect(
      ui.confirm("İptal", "baştan iptal", { signal: AbortSignal.abort() }),
    ).resolves.toBe(false);
    expect(requests).toEqual([]);
  });

  it("desteklenmeyen TUI çağrısı bir kez bildirilir", () => {
    const { ui, unsupported } = setup();
    ui.setStatus("k", "durum");
    ui.setStatus("k2", "durum");
    ui.setFooter(undefined);
    expect(unsupported).toEqual(["setStatus", "setFooter"]);
  });

  it("setWidget satırlarını onWidget'a taşır, temizlemeyi iletir", () => {
    const { ui, widgets, unsupported } = setup();
    ui.setWidget("pi-subagents", ["satır 1", "satır 2"]);
    ui.setWidget("pi-subagents", undefined);
    expect(widgets).toEqual([
      { key: "pi-subagents", lines: ["satır 1", "satır 2"] },
      { key: "pi-subagents", lines: undefined },
    ]);
    expect(unsupported).toEqual([]);
  });

  it("widget bileşen fabrikası desteklenmeyen çağrı sayılır", () => {
    const { ui, widgets, unsupported } = setup();
    const component = { render: () => ["satır"] };
    ui.setWidget("plan", (() => component) as unknown as never);
    expect(widgets).toEqual([]);
    expect(unsupported).toEqual(["setWidget"]);
  });

  it("boş satır listesi temizleme sayılır", () => {
    const { ui, widgets, unsupported } = setup();
    ui.setWidget("pi-subagents", []);
    expect(widgets).toEqual([{ key: "pi-subagents", lines: undefined }]);
    expect(unsupported).toEqual([]);
  });

  it("onTerminalInput sessizce yutulur", () => {
    const { ui, unsupported } = setup();
    const off = ui.onTerminalInput(() => {});
    expect(off).toBeTypeOf("function");
    off();
    expect(unsupported).toEqual([]);
  });

  it("Pi'nin `{...ui}` kopyası tema yüzünden yanlış alarm üretmez", () => {
    const { ui, unsupported } = setup();
    // Pi `wrapUIPromptContext` yüzeyi spread eder; non-enumerable tema kopyaya girmez.
    const wrapped = { ...ui };
    expect(wrapped.theme).toBeUndefined();
    expect(unsupported).toEqual([]);
    // Doğrudan okuma yine desteklenmeyen çağrı olarak bildirilir.
    void ui.theme;
    expect(unsupported).toEqual(["theme"]);
  });

  it("notify düzeyi verilmezse info olur", () => {
    const { ui, notices } = setup();
    ui.notify("selam");
    expect(notices).toEqual([{ message: "selam", level: "info" }]);
  });
});
