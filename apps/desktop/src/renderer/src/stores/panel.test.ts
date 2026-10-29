import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_HOME, sanitizeBrowserUrl, sanitizeTabs, termKeyOf, usePanel } from "./panel";

// Sirayet hatası: açık dosya tek bir global alanda tutulunca 3E projesinin Dosyalar sekmesinde
// Codezal deposunun README'si görünüyordu. Açık dosya artık proje köküne (cwd) bağlı.
const A = "/proje/a";
const B = "/proje/b";

describe("panel açık dosyası", () => {
  beforeEach(() => {
    usePanel.setState({ openFiles: {}, recentFiles: [] });
  });

  it("dosyayı yalnız kendi projesine yazar", () => {
    usePanel.getState().setOpenFile(A, `${A}/README.md`);
    expect(usePanel.getState().openFiles[A]).toBe(`${A}/README.md`);
    expect(usePanel.getState().openFiles[B]).toBeUndefined();
  });

  it("her proje kendi son dosyasını hatırlar", () => {
    const { setOpenFile } = usePanel.getState();
    setOpenFile(A, `${A}/README.md`);
    setOpenFile(B, `${B}/src/app.ts`);
    setOpenFile(A, `${A}/src/index.ts`);
    expect(usePanel.getState().openFiles[A]).toBe(`${A}/src/index.ts`);
    expect(usePanel.getState().openFiles[B]).toBe(`${B}/src/app.ts`);
  });

  it("null ile temizleme yalnız o projeyi siler", () => {
    const { setOpenFile } = usePanel.getState();
    setOpenFile(A, `${A}/README.md`);
    setOpenFile(B, `${B}/src/app.ts`);
    setOpenFile(A, null);
    expect(usePanel.getState().openFiles[A]).toBeUndefined();
    expect(usePanel.getState().openFiles[B]).toBe(`${B}/src/app.ts`);
  });

  it("cwd yokken kaydetmez", () => {
    usePanel.getState().setOpenFile("", `${A}/README.md`);
    expect(usePanel.getState().openFiles).toEqual({});
  });

  it("son dosyaları tekilleştirip en yeniyi başa alır", () => {
    const { setOpenFile } = usePanel.getState();
    setOpenFile(A, `${A}/README.md`);
    setOpenFile(A, `${A}/src/index.ts`);
    setOpenFile(A, `${A}/README.md`);
    expect(usePanel.getState().recentFiles).toEqual([`${A}/README.md`, `${A}/src/index.ts`]);
  });
});

describe("panel terminalleri", () => {
  beforeEach(() => {
    usePanel.setState({ terms: {}, tabs: [], active: "Tarayıcı" });
  });

  /** Şeritteki terminallerin sıra numaraları ("Terminal 1", "Terminal 2"). */
  const nums = () =>
    usePanel
      .getState()
      .tabs.map((tab) => {
        const key = termKeyOf(tab);
        return key ? usePanel.getState().terms[key]?.num : null;
      })
      .filter((n) => n !== null);

  it("her terminal şeride kendi sekmesini açar ve onu öne alır", () => {
    const { addTerminal } = usePanel.getState();
    const first = addTerminal(A);
    const second = addTerminal(A);
    expect(usePanel.getState().tabs).toEqual([first, second]);
    expect(nums()).toEqual([1, 2]);
    expect(usePanel.getState().active).toBe(second);
    expect(usePanel.getState().terms[termKeyOf(second) ?? ""]?.cwd).toBe(A);
  });

  it("her projenin terminali kendi kökünde açılır", () => {
    const { addTerminal } = usePanel.getState();
    const first = addTerminal(A);
    const second = addTerminal(B);
    const terms = usePanel.getState().terms;
    expect(terms[termKeyOf(first) ?? ""]?.cwd).toBe(A);
    expect(terms[termKeyOf(second) ?? ""]?.cwd).toBe(B);
    // Numaralar şeritte benzersiz olmalı: iki terminal aynı adı taşımaz.
    expect(nums()).toEqual([1, 2]);
  });

  it("terminal sekmesi kapanınca kaydı silinir, komşu sekme öne gelir", () => {
    const { addTerminal, closeTab } = usePanel.getState();
    const first = addTerminal(A);
    const second = addTerminal(A);
    closeTab(second);
    expect(usePanel.getState().tabs).toEqual([first]);
    expect(Object.keys(usePanel.getState().terms)).toEqual([termKeyOf(first)]);
    expect(usePanel.getState().active).toBe(first);
  });

  it("boşalan numarayı yeni terminale verir", () => {
    const { addTerminal, closeTab } = usePanel.getState();
    addTerminal(A);
    const second = addTerminal(A);
    addTerminal(A);
    closeTab(second);
    addTerminal(A);
    expect(nums()).toEqual([1, 3, 2]);
  });

  it("⌘J açık terminali öne alır, yoksa yenisini açar", () => {
    const { showTerminal } = usePanel.getState();
    showTerminal(A);
    const tab = usePanel.getState().active;
    usePanel.getState().openTab("Dosyalar");
    showTerminal(A);
    // Yeni sekme açılmaz: açık terminal öne alınır, öteki sekmeler yerinde kalır.
    expect(usePanel.getState().tabs).toEqual([tab, "Dosyalar"]);
    expect(usePanel.getState().active).toBe(tab);
    // Başka projede terminal yok: yeni sekme açılır, olan kapanmaz.
    showTerminal(B);
    expect(usePanel.getState().tabs.length).toBe(3);
  });

  it("kabuk kapandı işareti yalnız o sekmeye işler", () => {
    const { addTerminal, setTerminalExited } = usePanel.getState();
    const first = addTerminal(A);
    addTerminal(A);
    const firstKey = termKeyOf(first) ?? "";
    setTerminalExited(firstKey, true);
    expect(Object.values(usePanel.getState().terms).map((m) => m.exited)).toEqual([true, false]);
    // Yeniden başlatılan kabuk işareti geri alır.
    setTerminalExited(firstKey, false);
    expect(Object.values(usePanel.getState().terms).map((m) => m.exited)).toEqual([false, false]);
  });
});

describe("kayıtlı panel sekmeleri", () => {
  it("artık var olmayan tek Terminal sekmesini düşürür", () => {
    // Eski sürüm tek "Terminal" sekmesi yazıyordu; kabuk listesi kalıcı olmadığı için sekme açılmaz.
    expect(sanitizeTabs(["Tarayıcı", "Terminal", "Dosyalar"], "Terminal")).toEqual({
      tabs: ["Tarayıcı", "Dosyalar"],
      active: "Tarayıcı",
    });
  });

  it("terminal sekmelerini ve tekrarları yazmaz", () => {
    expect(sanitizeTabs(["terminal:t1", "Dosyalar", "Dosyalar"], "terminal:t1")).toEqual({
      tabs: ["Dosyalar"],
      active: "Dosyalar",
    });
  });

  it("bozuk kayıtta varsayılana döner", () => {
    expect(sanitizeTabs(undefined, 42)).toEqual({ tabs: [], active: "Tarayıcı" });
  });
});

describe("tarayıcı adresi", () => {
  it("kayıtlı adres yoksa ana sayfayı açar", () => {
    expect(sanitizeBrowserUrl(undefined)).toBe(BROWSER_HOME);
    expect(sanitizeBrowserUrl("")).toBe(BROWSER_HOME);
    expect(sanitizeBrowserUrl("  ")).toBe(BROWSER_HOME);
    expect(sanitizeBrowserUrl("about:blank")).toBe(BROWSER_HOME);
  });

  it("kayıtlı adresi korur", () => {
    expect(sanitizeBrowserUrl("https://www.google.com/")).toBe("https://www.google.com/");
  });
});
