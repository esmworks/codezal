import { describe, expect, it } from "vitest";
import { AgentEvent, AppSettings, AppSettingsPatch, ipcContract, SessionOptions } from "./index.js";

describe("contracts", () => {
  it("SessionOptions varsayılanları uygular", () => {
    const parsed = SessionOptions.parse({ cwd: "/tmp/proje" });
    expect(parsed).toMatchObject({
      mode: "kodlama",
      thinking: "low",
      permission: "ask",
      location: "local",
    });
  });

  it("AgentEvent bilinmeyen türü reddeder, zarfsız olayı da kabul etmez", () => {
    const bad = AgentEvent.safeParse({ type: "nope", sessionId: "s", at: 1 });
    expect(bad.success).toBe(false);
    // seq/epoch yalnız AgentEventBus'ta eklenir: zarfsız olay kontratı geçmez (tek üretici garantisi).
    const bare = AgentEvent.safeParse({ type: "status", sessionId: "s", at: 1, status: "idle" });
    expect(bare.success).toBe(false);
    const ok = AgentEvent.safeParse({
      type: "status",
      sessionId: "s",
      at: 1,
      status: "idle",
      seq: 1,
      epoch: "e1",
    });
    expect(ok.success).toBe(true);
  });

  it("ayar yaması dokunulmayan alanları varsayılanla doldurmaz", () => {
    // Zod 4'te .partial() varsayılanı koruyordu; tek ayar değişince diğerleri sıfırlanıyordu.
    const patch = AppSettingsPatch.parse({ menubar: true });
    expect(patch).toEqual({ menubar: true });
    expect("theme" in patch).toBe(false);
  });

  it("ayar yaması verilen değeri ve doğrulamayı korur", () => {
    expect(AppSettingsPatch.parse({ theme: "sistem" })).toEqual({ theme: "sistem" });
    expect(AppSettingsPatch.safeParse({ theme: "mor" }).success).toBe(false);
  });

  it("settings:set kanalı yama şemasını kullanır", () => {
    const req = ipcContract["settings:set"].req;
    expect(req.parse({ menubar: true })).toEqual({ menubar: true });
    // Tam şema hâlâ varsayılanları uygular (settings.json ilk kurulumu buna dayanır).
    expect(AppSettings.parse({}).theme).toBe("koyu");
  });

  it("her IPC kanalının req ve res şeması var", () => {
    for (const [channel, def] of Object.entries(ipcContract)) {
      expect(def.req, channel).toBeDefined();
      expect(def.res, channel).toBeDefined();
    }
  });
});
