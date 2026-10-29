interface SpinnerProps {
  size?: number;
  className?: string;
}

/** Dönen yay: bir şeyin sürdüğünü anlatan evrensel işaret. Nokta yerine kullanılır. */
export function Spinner({ size = 12, className }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      className={`cz-spin shrink-0 ${className ?? ""}`}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" opacity={0.2} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

interface WorkingProps {
  label: string;
  /**
   * Yalnız dönen yay çizilir. ZCode'un tur sonu göstergesi (`ChatLoading`) sadece simgedir:
   * süren işi araç satırı zaten söyler ("Çalıştırılıyor cd … && pnpm test"), satırda bir de
   * "Çalışıyor…" yazmak aynı şeyi iki kez söylüyordu. Etiket, erişilebilirlik adı olarak kalır.
   */
  spinnerOnly?: boolean | undefined;
  className?: string;
}

/** "Çalışıyor…" satırı: dönen yay, soldan sağa parlayan metin ve sırayla beliren üç nokta. */
export function Working({ label, spinnerOnly = false, className }: WorkingProps) {
  // Metindeki sabit üç nokta kaldırılır; noktalar ayrı ayrı canlandırılır.
  const text = label.replace(/(\.{3}|…)\s*$/, "");
  return (
    <div
      className={`flex items-center gap-[9px] text-[13px] text-tx3 ${className ?? ""}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <Spinner />
      {spinnerOnly ? null : (
        <span className="cz-shimmer" aria-hidden="true">
          {text}
          <span className="cz-dot">.</span>
          <span className="cz-dot">.</span>
          <span className="cz-dot">.</span>
        </span>
      )}
    </div>
  );
}
