import { useEffect, useState } from "react";
import { highlight, type Token } from "../lib/highlight";

/** Tema body özniteliğinden okunur; sistem teması da aynı yoldan yansır. */
function readLight(): boolean {
  return document.body.hasAttribute("data-cz-light");
}

function useIsLight(): boolean {
  const [light, setLight] = useState(readLight);
  useEffect(() => {
    const mo = new MutationObserver(() => setLight(readLight()));
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-cz-light"] });
    return () => mo.disconnect();
  }, []);
  return light;
}

function plainLines(code: string): Token[][] {
  return code.split("\n").map((l) => [{ text: l }]);
}

/** Sözdizimi belirteçleri; dil yoksa veya yükleme sürerken düz satırlar. */
export function useHighlightedLines(code: string, lang: string | null): Token[][] {
  const light = useIsLight();
  const [lines, setLines] = useState<Token[][]>(() => plainLines(code));
  useEffect(() => {
    let alive = true;
    setLines(plainLines(code));
    if (!lang) return;
    highlight(code, lang, light).then((t) => {
      if (alive && t) setLines(t);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, light]);
  return lines;
}

interface Props {
  code: string;
  lang: string | null;
  /** Satır numarası sütunu (dosya görüntüleyici). */
  lineNumbers?: boolean;
  className?: string;
}

/**
 * Renklendirilmiş kod. Satır 12px/1.7 monospace; belirteç rengi Shiki'den, düz metin `--tx2`.
 * Yatay taşma kabın `overflow` ayarına bırakılır.
 */
export function CodeView({ code, lang, lineNumbers = false, className = "" }: Props) {
  const lines = useHighlightedLines(code, lang);
  return (
    <div className={`font-code text-[12.5px] leading-[1.65] text-tx2 ${className}`}>
      {lines.map((toks, i) => (
        <div key={`${i}-${toks.length}`} className="flex min-h-[1.7em]">
          {lineNumbers ? (
            <span className="w-[42px] shrink-0 select-none pr-3 text-right text-tx3">{i + 1}</span>
          ) : null}
          <span className="whitespace-pre">
            {toks.map((t, j) =>
              t.color || t.italic || t.bold ? (
                <span
                  key={`${j}-${t.text.length}`}
                  style={{
                    color: t.color,
                    fontStyle: t.italic ? "italic" : undefined,
                    fontWeight: t.bold ? 600 : undefined,
                  }}
                >
                  {t.text}
                </span>
              ) : (
                t.text
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
