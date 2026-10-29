// İzometrik küp ızgarası: 40 birim kenarlı, sivri tepeli altıgen döşeme (69,28 × 120 birim).
// Altıgen köşeleri ve merkezden inen üç kenarla küp görünür; yatay komşu satır yarım genişlik kayar.
const R = 40;
const W = Math.sqrt(3) * R; // 69.28
const H = 3 * R; // 120

function hex(cx: number, cy: number): string {
  const hw = W / 2;
  const half = R / 2;
  return [
    `M${cx} ${cy - R} L${cx + hw} ${cy - half} L${cx + hw} ${cy + half} L${cx} ${cy + R}`,
    `L${cx - hw} ${cy + half} L${cx - hw} ${cy - half} Z`,
    `M${cx} ${cy} L${cx} ${cy - R} M${cx} ${cy} L${cx - hw} ${cy + half} M${cx} ${cy} L${cx + hw} ${cy + half}`,
  ].join(" ");
}

const CENTERS: [number, number][] = [
  [W / 2, R],
  [0, R + 1.5 * R],
  [W, R + 1.5 * R],
  [0, R - 1.5 * R],
  [W, R - 1.5 * R],
  [W / 2, R + 3 * R],
];

const TILE = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${CENTERS.map(([x, y]) => hex(x, y)).join(" ")}" fill="none" stroke="#000" stroke-width="1"/></svg>`;
const MASK = `url("data:image/svg+xml;utf8,${encodeURIComponent(TILE)}")`;

// Üstten logoya kadar tam, logo hizasında yumuşakça söner (logo dikeyde ~%34'te durur).
// Sönme maske yerine arka plan gradyanıyla yapılır: tek maske katmanı, birleşim tuzağı yok.
const FADE = "linear-gradient(to bottom, var(--tx) 0%, var(--tx) 16%, transparent 42%)";

/**
 * Ana ekran arka planı: üstten inen silik izometrik küp dokusu (kurumsal giriş ekranlarındaki gibi),
 * logoya doğru solar. Doku bir maske, rengi `--tx`'ten gelir; iki temada da düşük kontrastta
 * kalır. Kapsayıcı `relative isolate` olmalı.
 */
export function HomeBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 opacity-[0.07]"
      style={{
        background: FADE,
        maskImage: MASK,
        maskSize: `${W}px ${H}px`,
        maskRepeat: "repeat",
        maskPosition: "center top",
      }}
    />
  );
}
