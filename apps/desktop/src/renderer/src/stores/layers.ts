import { create } from "zustand";
import { useLightbox } from "../components/Lightbox";
import { useMenu } from "./menu";
import { useModelPicker } from "./modelPicker";

/**
 * Açık `Modal` yığını. Pencere düzeyindeki Esc dinleyicileri (oturum ekranı, Ayarlar) sayfaların
 * kendi içinde açtığı modalları göremiyordu; tek Esc hem modalı hem altındaki katmanı kapatıyor,
 * hatta süren turu durduruyordu. Yığın, "üstte bir modal var mı" ve "en üstteki hangisi"
 * sorularını dinleyici sırasından bağımsız yanıtlar.
 */
interface LayersState {
  modals: number[];
}

export const useLayers = create<LayersState>(() => ({ modals: [] }));

let nextId = 0;

/** Modal açılınca yığına girer; dönen kimlik kapanışta `popModal`a verilir. */
export function pushModal(): number {
  nextId += 1;
  const id = nextId;
  useLayers.setState((s) => ({ modals: [...s.modals, id] }));
  return id;
}

export function popModal(id: number): void {
  useLayers.setState((s) => ({ modals: s.modals.filter((x) => x !== id) }));
}

/** İç içe modalda Esc yalnız en üsttekini kapatır. */
export function isTopModal(id: number): boolean {
  const { modals } = useLayers.getState();
  return modals[modals.length - 1] === id;
}

/**
 * Modalların da üstünde duran yüzen katmanlar: bağlam menüsü, model seçici, ışık kutusu. Burada
 * durur (`lib/escapeLayers` değil) çünkü `Modal` bunu okur ve uygulama store'unu içeri çekmemeli.
 */
export function floatingLayerOpen(): boolean {
  return Boolean(
    useMenu.getState().open || useModelPicker.getState().open || useLightbox.getState().src,
  );
}
