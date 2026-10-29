import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadProjects, loadList, loadAssistant } = vi.hoisted(() => ({
  loadProjects: vi.fn(async () => {}),
  loadList: vi.fn(async () => {}),
  loadAssistant: vi.fn(async () => {}),
}));

// Yalnız açılış durum makinesi ölçülür; gerçek depolar IPC köprüsüne bağlı.
vi.mock("./projects", () => ({ useProjects: { getState: () => ({ load: loadProjects }) } }));
vi.mock("./sessions", () => ({ useSessions: { getState: () => ({ loadList }) } }));
vi.mock("./assistant", () => ({ useAssistant: { getState: () => ({ load: loadAssistant }) } }));

import { useStartup } from "./startup";

/**
 * Açılışta liste gelmeden ya da IPC hatasında kenar çubuğu "Henüz proje yok" diyordu. Durum
 * yüklenirken `loading`, hata olursa `error` (mesajıyla) olmalı; boş metin yalnız `ready`de çıkar.
 */
describe("useStartup", () => {
  beforeEach(() => {
    loadProjects.mockReset().mockResolvedValue(undefined);
    loadList.mockReset().mockResolvedValue(undefined);
    loadAssistant.mockReset().mockResolvedValue(undefined);
    useStartup.setState({ status: "loading", error: null });
  });

  it("yükleme sürerken loading, bitince ready olur", async () => {
    let finish: (() => void) | undefined;
    loadList.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = useStartup.getState().load();
    expect(useStartup.getState().status).toBe("loading");
    finish?.();
    await pending;
    expect(useStartup.getState().status).toBe("ready");
  });

  it("IPC hatasında error olur, diğer listeler yine yüklenir", async () => {
    loadList.mockRejectedValue(new Error("[sessions:list] Disk okunamadı"));
    await useStartup.getState().load();
    expect(useStartup.getState()).toMatchObject({ status: "error", error: "Disk okunamadı" });
    expect(loadProjects).toHaveBeenCalled();
    expect(loadAssistant).toHaveBeenCalled();
  });

  it("yeniden deneme başarılı olunca hata temizlenir", async () => {
    loadProjects.mockRejectedValueOnce(new Error("geçici"));
    await useStartup.getState().load();
    expect(useStartup.getState().status).toBe("error");
    await useStartup.getState().load();
    expect(useStartup.getState()).toMatchObject({ status: "ready", error: null });
  });
});
