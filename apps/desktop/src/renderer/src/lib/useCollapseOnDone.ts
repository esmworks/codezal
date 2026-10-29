import { useEffect, useRef } from "react";

/**
 * Liste ilk kez tamamlandığında kutuyu kapatır: çalışan iş listesi (Ajanlar kutusu gibi)
 * iş bitince kendiliğinden katlanır, kullanıcı isterse geri açar. Yeni bir iş yeniden
 * tamamlanana kadar kapanmaz.
 */
export function useCollapseOnDone(done: boolean, setOpen: (open: boolean) => void): void {
  const prev = useRef(false);
  useEffect(() => {
    if (done && !prev.current) setOpen(false);
    prev.current = done;
  }, [done, setOpen]);
}
