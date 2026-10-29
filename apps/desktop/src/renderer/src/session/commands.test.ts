import { describe, expect, it, vi } from "vitest";
import { i18n } from "../lib/i18n";
import { useApp } from "../stores/app";
import { useMenu } from "../stores/menu";
import { useModelPicker } from "../stores/modelPicker";
import { useModels } from "../stores/models";
import type { CommandPorts } from "./commands";
import { runSlashCommand } from "./commands";

// Komut çalıştırıcısı çizim yapmaz ama dokunduğu mağazalar import anında tarayıcı API'sine
// dokunur (tema tercihi `matchMedia`, depolama). Test bunları sahteler; gerçek DOM gerekmez.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    codezal: { invoke: async () => undefined, on: () => () => {}, pathForFile: () => "" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const node = () => ({ toggleAttribute: () => {}, setAttribute: () => {}, style: {} });
  g.document = { body: node(), documentElement: node() };
});

/** Katmanların açılış imzası: testte yalnız "açıldı mı" sayılır, çapa geometrisi ölçülmez. */
type PickerOpenAt = ReturnType<typeof useModelPicker.getState>["openAt"];
type MenuOpenAt = ReturnType<typeof useMenu.getState>["openAt"];

/** Sahte bağlantı noktaları: her eylem çağrısını sayar, hiçbir depoya dokunmaz. */
function ports(over: Partial<CommandPorts> = {}): CommandPorts {
  return {
    sessionId: "s1",
    anchor: { x: 10, y: 20 },
    model: null,
    permission: "ask",
    thinking: "low",
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setPermission: vi.fn(),
    compact: vi.fn().mockResolvedValue({ ok: true }),
    goal: vi.fn().mockResolvedValue(undefined),
    newTask: vi.fn(),
    ...over,
  };
}

describe("runSlashCommand", () => {
  it("kısayol komutlarını işlemez: metin talimata genişleyip modele gider", async () => {
    expect(await runSlashCommand("/plan şu işi yap", ports())).toBe(false);
    expect(await runSlashCommand("/bilinmeyen", ports())).toBe(false);
    expect(await runSlashCommand("merhaba", ports())).toBe(false);
  });

  it("/compact sıkıştırmayı çalıştırır", async () => {
    const p = ports();
    expect(await runSlashCommand("/compact", p)).toBe(true);
    expect(p.compact).toHaveBeenCalledTimes(1);
  });

  it("/compact sıkıştırma yapacak bir şey yoksa hata vermez", async () => {
    const p = ports({
      compact: vi.fn().mockResolvedValue({ ok: false, reason: "nothing-to-compact" }),
    });
    // "Yapacak iş yok" bir arıza değil: komut yine de işlenmiş sayılır (toast bilgilendirir).
    expect(await runSlashCommand("/compact", p)).toBe(true);
  });

  it("/compact argüman kabul etmez", async () => {
    await expect(runSlashCommand("/compact şimdi", ports())).rejects.toThrow();
  });

  it("oturum isteyen komut oturumsuz çağrılırsa hata verir", async () => {
    const p = ports({ sessionId: null });
    await expect(runSlashCommand("/compact", p)).rejects.toThrow(i18n.t("commands.needsSession"));
    await expect(runSlashCommand("/yeni", p)).rejects.toThrow(i18n.t("commands.needsSession"));
  });

  it("/goal hedefi kurar, alt komutları eyleme çevirir", async () => {
    const p = ports();
    expect(await runSlashCommand("/goal Tüm testler geçsin", p)).toBe(true);
    expect(p.goal).toHaveBeenCalledWith("set", "Tüm testler geçsin");
    await runSlashCommand("/goal durdur", p);
    expect(p.goal).toHaveBeenCalledWith("stop");
    await runSlashCommand("/goal duraklat", p);
    expect(p.goal).toHaveBeenCalledWith("pause");
    await runSlashCommand("/goal devam", p);
    expect(p.goal).toHaveBeenCalledWith("resume");
    await expect(runSlashCommand("/goal", p)).rejects.toThrow(i18n.t("goal.emptyHint"));
  });

  it("/mod izin modunu değiştirir, geçersiz değeri reddeder", async () => {
    const p = ports();
    expect(await runSlashCommand("/mod plan", p)).toBe(true);
    expect(p.setPermission).toHaveBeenCalledWith("plan");
    // ZCode'un adı da kabul edilir (yolo → full).
    await runSlashCommand("/mod yolo", p);
    expect(p.setPermission).toHaveBeenCalledWith("full");
    await expect(runSlashCommand("/mod saçma", p)).rejects.toThrow(
      i18n.t("commands.argBad", { values: "ask, auto-edit, plan, full" }),
    );
  });

  it("/düşünme seviyesini değiştirir", async () => {
    const p = ports();
    expect(await runSlashCommand("/düşünme max", p)).toBe(true);
    expect(p.setThinking).toHaveBeenCalledWith("max");
    expect(await runSlashCommand("/effort Yüksek", p)).toBe(true);
    expect(p.setThinking).toHaveBeenCalledWith("high");
  });

  it("/model katalogdaki modeli seçer, bilinmeyeni reddeder", async () => {
    useModels.setState({
      catalog: [
        {
          provider: "acme",
          id: "opus-4",
          name: "Opus 4",
          reasoning: true,
          vision: true,
          contextWindow: 200_000,
          maxTokens: 64_000,
          cost: { input: 0, output: 0 },
          available: true,
        },
      ],
    });
    const p = ports();
    expect(await runSlashCommand("/model acme/opus-4", p)).toBe(true);
    expect(p.setModel).toHaveBeenCalledWith({ provider: "acme", id: "opus-4" });
    await expect(runSlashCommand("/model acme/yok", p)).rejects.toThrow(
      i18n.t("commands.modelUnknown", { value: "acme/yok" }),
    );
    await expect(runSlashCommand("/model opus", p)).rejects.toThrow();
    useModels.setState({ catalog: [] });
  });

  it("/model argümansız seçiciyi açar (modeli körlemesine değiştirmez)", async () => {
    // Seçici katmanı açılışta çapa ölçer (DOM); testte ölçüm yok, açılış sayılır.
    const openAt = vi.fn();
    useModelPicker.setState({ openAt: openAt as unknown as PickerOpenAt });
    const p = ports();
    expect(await runSlashCommand("/model", p)).toBe(true);
    expect(openAt).toHaveBeenCalledTimes(1);
    expect(p.setModel).not.toHaveBeenCalled();
  });

  it("/yardım komut ekranını açar, argümanı sorguya çevirir", async () => {
    expect(await runSlashCommand("/yardım", ports())).toBe(true);
    expect(useApp.getState().commandsOpen).toBe(true);
    expect(useApp.getState().commandsQuery).toBe("");
    await runSlashCommand("/yardım model", ports());
    expect(useApp.getState().commandsQuery).toBe("model");
    await runSlashCommand("/help", ports());
    expect(useApp.getState().commandsOpen).toBe(true);
  });

  it("/mcp ve /beceri ayar ekranlarını açar", async () => {
    expect(await runSlashCommand("/mcp", ports())).toBe(true);
    expect(useApp.getState().settingsOpen).toBe(true);
    expect(useApp.getState().settingsPage).toBe("baglayicilar");
    await runSlashCommand("/beceri", ports());
    expect(useApp.getState().settingsPage).toBe("beceriler");
    await expect(runSlashCommand("/mcp listele", ports())).rejects.toThrow();
  });

  it("/yeni yeni görev ekranına döner, /geçmiş oturum aramasını açar", async () => {
    const p = ports();
    expect(await runSlashCommand("/yeni", p)).toBe(true);
    expect(p.newTask).toHaveBeenCalledTimes(1);
    expect(await runSlashCommand("/geçmiş", p)).toBe(true);
    expect(useApp.getState().searchOpen).toBe(true);
  });

  it("menü açan komutlar menüyü mevcut değerle açar", async () => {
    // Menü katmanı açılışta ölçer; testte çağrı kaydedilir, DOM gerekmez.
    const openAt = vi.fn();
    useMenu.setState({ openAt: openAt as unknown as MenuOpenAt });
    const p = ports({ permission: "full", thinking: "max" });
    expect(await runSlashCommand("/mod", p)).toBe(true);
    expect(await runSlashCommand("/düşünme", p)).toBe(true);
    expect(openAt).toHaveBeenCalledTimes(2);
  });
});
