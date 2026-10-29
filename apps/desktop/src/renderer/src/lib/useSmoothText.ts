import { useEffect, useRef, useState } from "react";

/**
 * Akan metni kademeli gösterir: ağdan parça parça gelen metin, kare başına birkaç karakter
 * eklenerek akıcı görünür. Geride kalınca hızlanır (en fazla ~150 ms gecikme), akış bitince
 * metnin kalanı anında değil birkaç kareye yayılarak tamamlanır: tek karede tüm metin basılırsa
 * blok bir-iki satır birden büyür ve görüntü yukarı sıçrardı.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(shown);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!streaming) {
      // Akış bitti: kalan gecikmeyi hızla ama kare kare kapat, tam metinle bitir.
      let raf = 0;
      const drain = () => {
        const full = textRef.current;
        const cur = shownRef.current;
        if (!full.startsWith(cur)) {
          shownRef.current = "";
          setShown("");
          raf = requestAnimationFrame(drain);
          return;
        }
        const backlog = full.length - cur.length;
        if (backlog > 0) {
          // Biriken metni ~60 ms'ye kapat: tek karelik sıçramayı böler, göz algılamaz.
          shownRef.current = full.slice(0, cur.length + Math.ceil(backlog / 4));
          setShown(shownRef.current);
          raf = requestAnimationFrame(drain);
          return;
        }
        shownRef.current = full;
        setShown(full);
      };
      raf = requestAnimationFrame(drain);
      return () => cancelAnimationFrame(raf);
    }
    // Yeni bir mesaj (metin kısaldı) ise baştan başla.
    if (!text.startsWith(shownRef.current)) {
      shownRef.current = "";
      setShown("");
    }
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const full = textRef.current;
      const cur = shownRef.current;
      const backlog = full.length - cur.length;
      if (backlog > 0) {
        const dt = Math.min(now - last, 100);
        // Temel hız 90 karakter/sn; birikim büyüdükçe ~9 karede kapatacak kadar hızlan.
        const chars = Math.max(1, Math.ceil((dt / 1000) * 90), Math.ceil(backlog / 9));
        const next = full.slice(0, cur.length + chars);
        shownRef.current = next;
        setShown(next);
      }
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [streaming, text]);

  return shown;
}
