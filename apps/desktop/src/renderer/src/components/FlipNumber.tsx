import { useEffect, useRef } from "react";

/** Sayacın bir rakam yuvası: yeni rakam, önceki rakam ve çevrilip çevrilmeyeceği. */
export interface TurnSlot {
  /** Yuva numarası **sağdan** sayılır (1 = birler): sayaç büyürken birler basamağı yerinde kalır. */
  place: number;
  /** Yuvadaki yeni rakam. */
  char: string;
  /** Önceki değerdeki rakam; yuva yeni doğduysa yoktur. */
  was?: string;
  /** Rakam bu geçişte değişti mi. İlk çizimde (önceki değer yokken) hiçbiri değişmez. */
  turn: boolean;
}

/**
 * Yuvaları kurar: rakamlar **sağdan** eşleştirilir. 9 → 10 geçişinde birler basamağı yerinde kalır
 * (9 → 0 çevrilir) ve onlar basamağı solda doğar; soldan saysaydık bütün rakamlar kayardı. Önceki
 * değer yokken (ilk çizim) hiçbir yuva çevrilmez: satır doğarken sayı oynamasın.
 */
export function turnSlots(previous: string | null, next: string): TurnSlot[] {
  const digits = Array.from(next);
  const first = previous === null;
  const old = first ? [] : Array.from(previous);
  return digits.map((char, i) => {
    const place = digits.length - i;
    const was = old.length >= place ? old[old.length - place] : undefined;
    return { place, char, ...(was === undefined ? {} : { was }), turn: !first && was !== char };
  });
}

/**
 * Sayaç sayısı: değer değişince **yalnız değişen rakamlar** ekseninde döner. ZCode'un araç
 * kartlarındaki `+N −N` sayacı da böyle çalışır — sayı akış boyunca tazelenir, değişen rakam
 * 160 ms'lik kısa bir çevirme oynar (aynı süre ve eğri), satır zıplamaz. Yuvalar mono ölçüde
 * olduğu için genişlik oynamaz; basamak eklenince yeni yuva solda açılır.
 *
 * İlk çizim sessizdir (satır ya da kart doğarken sayı oynamaz) ve `prefers-reduced-motion`da
 * çevirme tamamen kapanır — Codezal'in diğer animasyonlarındaki kural.
 */
export function FlipNumber({ value, className = "" }: { value: number; className?: string }) {
  const text = String(value);
  const previous = useRef<string | null>(null);
  const slots = turnSlots(previous.current, text);
  // Önceki değer commit'ten **sonra** yazılır: render iki kez çalışsa da (StrictMode) geçiş
  // kaybolmaz; çevirme sınıfı yalnız değer gerçekten değiştiğinde eklenir.
  useEffect(() => {
    previous.current = text;
  }, [text]);
  return (
    <span className={`inline-flex ${className}`}>
      {slots.map((slot) => (
        <span key={slot.place} className="cz-turn">
          {slot.turn && slot.was !== undefined ? (
            <span aria-hidden className="cz-turn-out">
              {slot.was}
            </span>
          ) : null}
          <span className={slot.turn ? "cz-turn-in" : undefined}>{slot.char}</span>
        </span>
      ))}
    </span>
  );
}
