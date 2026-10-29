import { afterEach, describe, expect, it } from "vitest";
import { useLightbox } from "../components/Lightbox";
import { useApp } from "../stores/app";
import { useFind } from "../stores/find";
import { isTopModal, popModal, pushModal, useLayers } from "../stores/layers";
import { useMenu } from "../stores/menu";
import { useModelPicker } from "../stores/modelPicker";
import { escapeAbortsTurn, escapeClosesFind, escapeClosesSettings } from "./escapeLayers";

/** Pencereye ulaşan Esc; `handled` başka bir katmanın `preventDefault` dediğini taklit eder. */
const esc = (handled = false) => ({ key: "Escape", defaultPrevented: handled });

/**
 * Esc sahipliği: katmanlar pencere dinleyicisi olduğundan tek basış hepsine ulaşıyordu. Menüyü
 * ya da modalı kapatan Esc süren turu da durduruyor, Ayarlar'daki form modalında Esc bütün
 * Ayarlar'ı kapatıyordu. Kural dinleyici sırasından bağımsız olmalı: katman önce çalışıp
 * kapanmış olsa bile (`defaultPrevented`), sonra çalışacak olsa bile (store'da açık) alttaki
 * katman Esc'i almaz.
 */
describe("Esc katman sahipliği", () => {
  afterEach(() => {
    useMenu.setState({ open: null });
    useModelPicker.setState({ open: null });
    useLightbox.setState({ src: null });
    useLayers.setState({ modals: [] });
    useApp.setState({ settingsOpen: false, searchOpen: false, commandsOpen: false, modal: null });
    useFind.setState({ open: false });
  });

  it("bulma çubuğu açıkken ilk Esc çubuğu kapatır, turu durdurmaz", () => {
    useFind.setState({ open: true, sessionId: "s1" });
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
    expect(escapeClosesFind(esc())).toBe(true);
    // Üstte katman varsa (arama paleti) Esc önce onu kapatır, çubuk açık kalır.
    useApp.setState({ searchOpen: true });
    expect(escapeClosesFind(esc())).toBe(false);
    // Kutunun kendi dinleyicisi işlediyse ikinci kez kapatılmaz.
    useApp.setState({ searchOpen: false });
    expect(escapeClosesFind(esc(true))).toBe(false);
  });

  it("katman yokken tur sürüyorsa Esc turu durdurur", () => {
    expect(escapeAbortsTurn(esc(), true)).toBe(true);
  });

  it("tur boştayken Esc hiçbir şey durdurmaz", () => {
    expect(escapeAbortsTurn(esc(), false)).toBe(false);
  });

  it("başka katman Esc'i işlediyse tur durmaz", () => {
    expect(escapeAbortsTurn(esc(true), true)).toBe(false);
  });

  it("menü açıkken Esc turu durdurmaz (menü dinleyicisi sonra çalışsa da)", () => {
    useMenu.setState({ open: { spec: { items: [] }, anchor: { top: 0, bottom: 0, left: 0 } } });
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
  });

  it("modal, arama, ışık kutusu ya da Ayarlar açıkken tur durmaz", () => {
    const id = pushModal();
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
    popModal(id);

    useApp.setState({ searchOpen: true });
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
    useApp.setState({ searchOpen: false });

    useLightbox.setState({ src: "data:image/png;base64,aGk=" });
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
    useLightbox.setState({ src: null });

    useApp.setState({ settingsOpen: true });
    expect(escapeAbortsTurn(esc(), true)).toBe(false);
  });

  it("Ayarlar sayfasında açık form modalı varken Esc Ayarlar'ı kapatmaz", () => {
    const id = pushModal();
    expect(escapeClosesSettings(esc())).toBe(false);
    popModal(id);
    expect(escapeClosesSettings(esc())).toBe(true);
  });

  it("Esc'i başka katman aldıysa Ayarlar açık kalır", () => {
    expect(escapeClosesSettings(esc(true))).toBe(false);
  });

  it("iç içe modalda yalnız en üstteki Esc'in sahibidir", () => {
    const lower = pushModal();
    const upper = pushModal();
    expect(isTopModal(upper)).toBe(true);
    expect(isTopModal(lower)).toBe(false);
    popModal(upper);
    expect(isTopModal(lower)).toBe(true);
    popModal(lower);
  });

  it("açık oturum değişmişse bayat açılış hatası eve döndürmez", () => {
    useApp.setState({ screen: "session", activeSessionId: "b" });
    useApp.getState().leaveSession("a");
    expect(useApp.getState().activeSessionId).toBe("b");
    useApp.getState().leaveSession("b");
    expect(useApp.getState().screen).toBe("home");
    expect(useApp.getState().activeSessionId).toBeNull();
  });
});
