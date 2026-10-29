import { describe, expect, it } from "vitest";
import { askConfirm, useConfirm } from "./Confirm";

describe("askConfirm", () => {
  it("onaylanınca true döner ve pencere kapanır", async () => {
    const p = askConfirm({ title: "Sohbeti sil", danger: true });
    expect(useConfirm.getState().open?.title).toBe("Sohbeti sil");
    useConfirm.getState().close(true);
    await expect(p).resolves.toBe(true);
    expect(useConfirm.getState().open).toBeNull();
  });

  it("vazgeçilince false döner", async () => {
    const p = askConfirm({ title: "Sohbeti sil" });
    useConfirm.getState().close(false);
    await expect(p).resolves.toBe(false);
  });

  it("yeni soru gelince öncekini iptal eder", async () => {
    const first = askConfirm({ title: "Birinci" });
    const second = askConfirm({ title: "İkinci" });
    await expect(first).resolves.toBe(false);
    expect(useConfirm.getState().open?.title).toBe("İkinci");
    useConfirm.getState().close(true);
    await expect(second).resolves.toBe(true);
  });
});
