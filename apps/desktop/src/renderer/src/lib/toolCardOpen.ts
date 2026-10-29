import { useCallback, useState } from "react";

/**
 * Araç kartlarının açık/kapalı durumu modül düzeyinde tutulur (ZCode'un `ToolLayout` deseni).
 *
 * Neden bileşen durumu yetmiyor: kullanıcı bir diff'i ya da komut çıktısını açıp başka bir
 * oturuma geçtiğinde bileşen ağacı söküldüğü için `useState` sıfırlanıyor, geri dönünce kart
 * kapalı geliyordu. Kart kimliği (araç çağrısı kimliği) oturumlar arasında tektir; anahtar bu
 * yüzden güvenli.
 *
 * Kalıcı depoya yazılmaz: bu bir tercih değil, gezinme kolaylığıdır — uygulama yeniden açıldığında
 * sıfırdan başlaması doğrudur.
 */
const openState = new Map<string, boolean>();

/**
 * Bellekte tutulan kart sayısı; aşılırsa en eski kayıt düşer. Oturum başına temizlik gerekmez:
 * araç çağrısı kimlikleri süreç boyunca tektir, üst sınır belleği sınırlı tutar.
 */
const MAX_ENTRIES = 800;

/**
 * Kartın açık/kapalı durumu; bileşen sökülüp yeniden kurulsa da korunur.
 * `key` kartın kararlı kimliğidir (araç çağrısı kimliği ya da grup satırının anahtarı).
 */
export function useToolCardOpen(key: string, initial = false): [boolean, () => void] {
  const [open, setOpen] = useState(() => openState.get(key) ?? initial);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (openState.size >= MAX_ENTRIES && !openState.has(key)) {
        const oldest = openState.keys().next().value;
        if (oldest !== undefined) openState.delete(oldest);
      }
      openState.set(key, next);
      return next;
    });
  }, [key]);
  return [open, toggle];
}
