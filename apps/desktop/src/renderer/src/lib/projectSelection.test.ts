import type { ProjectRef } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { folderMode, resolveSelection } from "./projectSelection";

const ref = (path: string): ProjectRef => ({
  path,
  name: path.split("/").pop() ?? "",
  isGit: true,
});
const recent = [ref("/repo/codezal"), ref("/repo/coils")];

describe("resolveSelection", () => {
  it("kayıtlı yolu seçer, listede yoksa boş bırakır", () => {
    expect(resolveSelection(recent, { kodlama: "/repo/coils" }, "kodlama")).toEqual(
      ref("/repo/coils"),
    );
    expect(resolveSelection(recent, { kodlama: "/repo/silinen" }, "kodlama")).toBeNull();
  });

  it("kullanıcı seçimi kaldırdıysa yerine başka proje koymaz", () => {
    expect(resolveSelection(recent, { kodlama: null }, "kodlama")).toBeNull();
  });

  it("hiç seçim yoksa son klasöre düşer", () => {
    expect(resolveSelection(recent, {}, "kodlama")).toEqual(ref("/repo/codezal"));
  });

  it("aynı bölüm anahtarını kullanır", () => {
    expect(folderMode()).toBe("kodlama");
  });
});
