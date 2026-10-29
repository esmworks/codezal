import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ invoke: vi.fn() }));

const { createExistsStore } = await import("./pathExists");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createExistsStore", () => {
  it("aynı karedeki sorguları tek çağrıda toplar ve sonucu önbellekte tutar", async () => {
    const check = vi.fn(async (paths: string[]) => paths.map((p) => p.endsWith("var.pdf")));
    const store = createExistsStore(check);
    expect(store.get("/a/var.pdf")).toBeUndefined();
    expect(store.get("/a/yok.png")).toBeUndefined();
    expect(store.get("/a/var.pdf")).toBeUndefined();
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(["/a/var.pdf", "/a/yok.png"]);
    expect(store.get("/a/var.pdf")).toBe(true);
    expect(store.get("/a/yok.png")).toBe(false);
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("50'den fazla yolu kanal sınırına göre parçalar", async () => {
    const check = vi.fn(async (paths: string[]) => paths.map(() => true));
    const store = createExistsStore(check);
    for (let i = 0; i < 120; i++) store.get(`/a/${i}.pdf`);
    await tick();
    expect(check.mock.calls.map(([paths]) => paths.length)).toEqual([50, 50, 20]);
    expect(store.get("/a/119.pdf")).toBe(true);
  });

  it("yoklama başarısızsa yolu var sayar", async () => {
    const store = createExistsStore(async () => {
      throw new Error("ipc");
    });
    store.get("/a/b.pdf");
    await tick();
    expect(store.get("/a/b.pdf")).toBe(true);
  });

  it("forgetMissing yalnız yok çıkanları yeniden sorar, yanıt gelene dek eskisi kalır", async () => {
    const onDisk = new Set(["/a/var.pdf"]);
    const check = vi.fn(async (paths: string[]) => paths.map((p) => onDisk.has(p)));
    const store = createExistsStore(check);
    const listener = vi.fn();
    store.subscribe(listener);
    store.get("/a/var.pdf");
    store.get("/a/sonra.pdf");
    await tick();
    expect(store.get("/a/sonra.pdf")).toBe(false);

    onDisk.add("/a/sonra.pdf");
    listener.mockClear();
    store.forgetMissing();
    expect(store.get("/a/sonra.pdf")).toBe(false);
    await tick();
    expect(check).toHaveBeenLastCalledWith(["/a/sonra.pdf"]);
    expect(store.get("/a/sonra.pdf")).toBe(true);
    expect(listener).toHaveBeenCalled();
  });
});
