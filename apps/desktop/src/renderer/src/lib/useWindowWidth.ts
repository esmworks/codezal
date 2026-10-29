import { useEffect, useState } from "react";

export function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    let clear = 0;
    const on = () => {
      setW(window.innerWidth);
      // Pencere sürüklenirken kayma geçişi kapanır: paneller boyut değişimini gecikmeden izler.
      document.body.dataset.czResizing = "";
      window.clearTimeout(clear);
      clear = window.setTimeout(() => {
        delete document.body.dataset.czResizing;
      }, 120);
    };
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("resize", on);
      window.clearTimeout(clear);
    };
  }, []);
  return w;
}
