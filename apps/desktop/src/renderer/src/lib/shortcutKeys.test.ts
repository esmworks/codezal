import { resolveAccelerator } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, findConflict, shortcutHint, shortcutKeys } from "./shortcutKeys";

/** Türkçe Q düzeni: ABD'deki virgül tuşu "ö", ters bölü tuşu "," üretir. */
const trQ = new Map([
  ["Comma", "ö"],
  ["Backslash", ","],
  ["KeyN", "n"],
  ["KeyM", "m"],
]);

describe("shortcutKeys", () => {
  it("macOS'ta simge, Windows'ta ad kullanır", () => {
    expect(shortcutKeys("CmdOrCtrl+Shift+M", true, null)).toEqual(["⌘", "⇧", "M"]);
    expect(shortcutKeys("CmdOrCtrl+Shift+M", false, null)).toEqual(["Ctrl", "Shift", "M"]);
  });

  it("düzen verilirse fiziksel tuşun ürettiği harfi gösterir", () => {
    expect(shortcutKeys("CmdOrCtrl+,", true, trQ)).toEqual(["⌘", "Ö"]);
    expect(shortcutKeys("CmdOrCtrl+\\", true, trQ)).toEqual(["⌘", ","]);
  });

  it("düzende karşılığı olmayan tuşu olduğu gibi bırakır", () => {
    expect(shortcutKeys("CmdOrCtrl+G", false, trQ)).toEqual(["Ctrl", "G"]);
  });
});

describe("shortcutHint", () => {
  it("macOS'ta bitişik, Windows'ta artı ile yazar", () => {
    expect(shortcutHint("CmdOrCtrl+N", true, null)).toBe("⌘N");
    expect(shortcutHint("CmdOrCtrl+N", false, null)).toBe("Ctrl+N");
    expect(shortcutHint("CmdOrCtrl+Shift+M", false, null)).toBe("Ctrl+Shift+M");
  });

  it("düzen çevirisi ipuçlarına da uygulanır", () => {
    expect(shortcutHint("CmdOrCtrl+,", true, trQ)).toBe("⌘Ö");
    expect(shortcutHint("CmdOrCtrl+,", false, trQ)).toBe("Ctrl+Ö");
  });
});

const base = { key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("acceleratorFromEvent", () => {
  it("birincil tuşu platforma göre CmdOrCtrl yazar", () => {
    expect(acceleratorFromEvent({ ...base, key: "n", metaKey: true }, true)).toBe("CmdOrCtrl+N");
    expect(acceleratorFromEvent({ ...base, key: "n", ctrlKey: true }, false)).toBe("CmdOrCtrl+N");
    // Yanlış birincil tuş (macOS'ta Ctrl) tek başına yetmez.
    expect(acceleratorFromEvent({ ...base, key: "n", ctrlKey: true }, true)).toBeNull();
  });

  it("Alt ve Shift eklenir", () => {
    expect(acceleratorFromEvent({ ...base, key: "m", metaKey: true, shiftKey: true }, true)).toBe(
      "CmdOrCtrl+Shift+M",
    );
    expect(acceleratorFromEvent({ ...base, key: "j", altKey: true }, false)).toBe("Alt+J");
  });

  it("modifier şart: yalnız harf ya da yalnız modifier null döner", () => {
    expect(acceleratorFromEvent({ ...base, key: "k" }, true)).toBeNull();
    expect(acceleratorFromEvent({ ...base, key: "Meta", metaKey: true }, true)).toBeNull();
    expect(acceleratorFromEvent({ ...base, key: "Shift", shiftKey: true }, true)).toBeNull();
  });

  it("noktalama ve özel tuşları Electron biçimine çevirir", () => {
    expect(acceleratorFromEvent({ ...base, key: ",", metaKey: true }, true)).toBe("CmdOrCtrl+,");
    expect(acceleratorFromEvent({ ...base, key: "+", metaKey: true }, true)).toBe("CmdOrCtrl+Plus");
    expect(acceleratorFromEvent({ ...base, key: "ArrowUp", metaKey: true }, true)).toBe(
      "CmdOrCtrl+Up",
    );
    expect(acceleratorFromEvent({ ...base, key: "F5", metaKey: true }, true)).toBe("CmdOrCtrl+F5");
    expect(acceleratorFromEvent({ ...base, key: "F13", metaKey: true }, true)).toBeNull();
  });
});

describe("findConflict", () => {
  const resolved = [
    { command: "search", accelerator: "CmdOrCtrl+K" },
    { command: "commit", accelerator: "CmdOrCtrl+Shift+K" },
  ];

  it("aynı hızlandırıcıyı kullanan başka komutu bulur", () => {
    expect(findConflict("settings", "CmdOrCtrl+K", resolved)).toBe("search");
    expect(findConflict("search", "CmdOrCtrl+K", resolved)).toBeUndefined();
    expect(findConflict("settings", "CmdOrCtrl+P", resolved)).toBeUndefined();
  });
});

describe("resolveAccelerator", () => {
  it("kullanıcı tanımlıysa onu, yoksa varsayılanı döndürür", () => {
    expect(resolveAccelerator("search")).toBe("CmdOrCtrl+K");
    expect(resolveAccelerator("search", { search: "CmdOrCtrl+P" })).toBe("CmdOrCtrl+P");
    expect(resolveAccelerator("search", { commit: "CmdOrCtrl+P" })).toBe("CmdOrCtrl+K");
  });
});
