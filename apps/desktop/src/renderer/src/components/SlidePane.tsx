import { TEST_IDS, testId } from "@codezal/contracts";
import { useEffect, useRef, useState } from "react";

/**
 * Kayma süresi: kat edilen genişliğe orantılı, yaklaşık 1px/ms. Sabit süre verilince
 * dar kenar çubuğu ağır, geniş panel hızlı görünüyordu; böylece ikisi aynı hızda kayar.
 */
const msFor = (width: number) => Math.round(Math.min(380, Math.max(200, width)));

/** Genişlik geçişini süren CSS değişkeni; React tipleri özel değişkenleri bilmez. */
type SlideStyle = React.CSSProperties & Record<"--cz-slide-ms", string>;

interface Props {
  open: boolean;
  /** Açıkken kaplayacağı genişlik; tam ekranda da hedef genişlik burasıdır. */
  width: number;
  /** Genişlik tutamacı; kırpma kutusunun dışında durur ki kenarda kesilmesin. */
  handle?: React.ReactNode;
  /** Kapanış animasyonu bitince, içerik sökülmeden hemen önce çağrılır. */
  onClosed?: () => void;
  children: React.ReactNode;
}

/**
 * Yandan kayarak açılıp kapanan panel kabı. Genişlik dıştaki kırpma kutusunda
 * canlandırılır, içerik tam genişlikte sabit durur: kayarken metin yeniden
 * sarmalanmaz. Kapanış bitince içerik sökülür ve `onClosed` bildirilir, böylece
 * terminal ve tarayıcı sekmeleri gizliyken arkada çalışmaz.
 */
export function SlidePane({ open, width, handle, onClosed, children }: Props) {
  // mounted: içerik DOM'da mı. shown: genişlik hedefi açık mı, geçişi bu tetikler.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  // Kapanış bildirimi hem en güncel geri çağrıyla hem de yalnızca bir kez yapılsın.
  const closed = useRef(onClosed);
  const notified = useRef(!open);

  const ms = msFor(width);

  useEffect(() => {
    closed.current = onClosed;
  });

  useEffect(() => {
    if (!open) {
      setShown(false);
      const timer = window.setTimeout(() => {
        setMounted(false);
        if (!notified.current) {
          notified.current = true;
          closed.current?.();
        }
      }, ms);
      return () => window.clearTimeout(timer);
    }
    notified.current = false;
    setMounted(true);
    // İki kare bekle: içerik önce sıfır genişlikte boyansın, geçiş sonra başlasın.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, ms]);

  return (
    <div className="relative shrink-0">
      <div
        // Kırpma kutusu: genişliği ölçen e2e testi bu kimliği kullanır (DOM sırası ya da
        // `.cz-slide` sınıfı değişince test düşmesin).
        {...testId(TEST_IDS.slidePane)}
        className="cz-slide h-full overflow-hidden"
        style={{ width: shown ? width : 0, "--cz-slide-ms": `${ms}ms` } as SlideStyle}
      >
        <div className="h-full" style={{ width }}>
          {mounted ? children : null}
        </div>
      </div>
      {open ? handle : null}
    </div>
  );
}
