import type { TranscriptItem } from "@codezal/contracts";

export interface ProgressStep {
  label: string;
  done: boolean;
  /** Şu an yapılan adım (`- [-]`); yalnızca task_list aracı işaretler. */
  active?: boolean;
}

/** Ajanın adım listesi aracı; çıktısı aynı kontrol listesi biçimindedir. */
export const TASK_LIST_TOOL = "task_list";
const CHECK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~-])\]\s+(.+?)\s*$/;

function parseChecklist(text: string): ProgressStep[] {
  const found: ProgressStep[] = [];
  for (const line of text.split("\n")) {
    const m = CHECK_RE.exec(line);
    if (!m) continue;
    const label = (m[2] ?? "").replace(/\*\*/g, "");
    const mark = m[1] ?? " ";
    const active = mark === "-" || mark === "~";
    found.push({
      label: label.length > 60 ? `${label.slice(0, 57)}…` : label,
      done: mark === "x" || mark === "X",
      ...(active ? { active: true } : {}),
    });
  }
  return found;
}

/**
 * Adım listesi aracının çıktısından adımlar. Kart, kutu ve özet aynı biçimi okur; ayrıştırma
 * tek yerde kalsın diye dışa açılır (ZCode'un todo kartı da çıktıyı böyle okur).
 */
export function taskListSteps(output: string): ProgressStep[] {
  return parseChecklist(output);
}

/**
 * Kartta gösterilen güncel adım: yapılmakta olan, yoksa ilk bitmemiş, yoksa son adım.
 * Sıra ZCode'un todo kartıyla aynıdır: kullanıcı karttan "şu an ne yapılıyor"u okur.
 */
export function activeStepOf(steps: readonly ProgressStep[]): ProgressStep | undefined {
  return steps.find((s) => s.active) ?? steps.find((s) => !s.done) ?? steps[steps.length - 1];
}

/**
 * İlerleme adımları: önce ajanın `task_list` aracıyla kaydettiği son liste, o yoksa asistanın
 * yazdığı son kontrol listesi (`- [ ]` / `- [x]`). Her yanıtın ilk cümlesi adım sayılmaz; gerçek
 * bir plan yoksa liste boş döner ve kutu gizlenir.
 */
export function progressSteps(transcript: TranscriptItem[]): ProgressStep[] {
  let steps: ProgressStep[] = [];
  for (const item of transcript) {
    let found: ProgressStep[] = [];
    if (item.type === "assistant") found = parseChecklist(item.text);
    else if (item.type === "tool" && item.toolName === TASK_LIST_TOOL && item.status === "done")
      found = parseChecklist(item.output ?? "");
    if (found.length > 0) steps = found;
  }
  return steps;
}

/**
 * Son kullanıcı mesajından sonra üretilen liste hâlâ açık adım bıraktıysa onları döndürür.
 * Tur bittiğinde İlerleme kutusu eskiden tamamen kayboluyordu; modelin yarım bıraktığı liste
 * görünmez oluyordu. Kutu yalnızca **son turda** kullanılan liste için kalır: kullanıcı yeni mesaj
 * yazınca eski liste kutuyu tutmaz.
 */
export function openStepsOfLastTurn(transcript: TranscriptItem[]): ProgressStep[] {
  let lastUser = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]?.type === "user") {
      lastUser = i;
      break;
    }
  }
  const steps = progressSteps(transcript.slice(lastUser + 1));
  return steps.filter((s) => !s.done);
}

/** Kutuda gösterilen satır sayısı; açık adımlar her zaman önceliklidir. */
export const VISIBLE_STEPS = 4;

export interface VisibleSteps {
  /** Gösterilecek adımlar, listenin kendi sırasında. */
  shown: ProgressStep[];
  /** Gösterilmeyen adım sayısı (etiket bunu söyler). */
  hidden: number;
}

/**
 * Kutuda gösterilecek adımlar: **açık adımlar önce ve daima** görünür, kalan yuvaya en son
 * tamamlananlar girer. `slice(-4)` açık adımı son 4'ün dışında bırakıp "hepsi bitti" izlenimi
 * veriyordu; sıra korunur ki başlıktaki liste sırası bozulmasın.
 */
export function visibleSteps(steps: readonly ProgressStep[], max = VISIBLE_STEPS): VisibleSteps {
  if (steps.length <= max) return { shown: [...steps], hidden: 0 };
  const open = steps.filter((s) => !s.done);
  // Açık adımlar yuvayı doldurursa yalnızca onlar gösterilir; kalan yuvaya en yeni bitenler girer.
  const openShown = new Set(open.slice(0, max));
  const doneRoom = max - openShown.size;
  // `slice(-0)` tüm diziyi döndürür: oda yokken boş liste açıkça seçilir.
  const done = steps.filter((s) => s.done);
  const doneShown = new Set(doneRoom > 0 ? done.slice(-doneRoom) : []);
  const shown = steps.filter((s) => openShown.has(s) || doneShown.has(s));
  return { shown, hidden: steps.length - shown.length };
}
