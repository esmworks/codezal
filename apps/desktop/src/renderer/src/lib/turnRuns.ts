import type { TranscriptItem } from "@codezal/contracts";
import type { RunGroup } from "./openRuns";

/**
 * Aynı kullanıcı turunda kalan çalışma dizilerini tek dizide birleştirir.
 *
 * Tur, gizli dürtmelerle ortadan bölünebiliyor: model bir ara rapor yazıyor, arka plan bildirimi
 * geliyor ve aynı turda yeniden araç çağırıyor. Her parça kendi katlanmış satırını ("51,6 sn
 * çalıştı", "3,5 sn çalıştı") alınca tek yanıtın altında iki özet satırı birden görünüyordu.
 * Birleşme tur içinde kalır: kullanıcı mesajı (steer, geri sar) turu böldüğü için ayrı satır kalır.
 *
 * Dizi olmayan öğeler (ara raporlar, dürtme sınırı, kartlar) yerlerinde durur; birleşen dizi ilk
 * parçanın konumunu koruduğu için raporlar satırın arkasına saklanmaz, akış yeniden sıralanmaz.
 *
 * `from` (bkz. `liveSegmentStart`) süren turun canlı bölümünü ayırır: o noktadan sonraki parçalar
 * önceki diziye katılmaz, kendi aralarında birleşir. Canlı iş eski raporun üstüne taşınınca ekranda
 * önce "Düşünüyor", altında dakikalar önce yazılmış rapor, en altta dönen durum satırı görünüyordu.
 */
export function mergeTurnRuns(groups: readonly RunGroup[], from = -1): RunGroup[] {
  const out: RunGroup[] = [];
  // Bu turda birleşen dizinin `out` içindeki yeri; kullanıcı mesajı gelince tur kapanır.
  let runAt = -1;
  // Birleşen dizinin ardına düşen işaretler (izin, model, düşünme değişimi). Sonraki parça dizinin
  // içine katlanınca işaret hep turun en altında kalıyordu; turda yeni parça gelirse dizinin önüne
  // alınır, gelmezse (tur bittikten sonraki değişim) yerinde durur.
  let marks: number[] = [];
  for (const [gi, g] of groups.entries()) {
    // Canlı bölüm yeni bir birleşme alanı açar; bekleyen işaretler yerinde (kronolojik) kalır.
    if (gi === from) {
      runAt = -1;
      marks = [];
    }
    if (Array.isArray(g)) {
      if (runAt < 0) {
        runAt = out.length;
        out.push([...g]);
        continue;
      }
      if (marks.length > 0) {
        const moved = marks.map((at) => out[at]).filter((m): m is RunGroup => m !== undefined);
        for (const at of [...marks].reverse()) out.splice(at, 1);
        out.splice(runAt, 0, ...moved);
        runAt += moved.length;
        marks = [];
      }
      // Kopya üzerine eklenir: girdi grupları her karede yeniden kurulsa da saf kalır.
      out[runAt] = [...(out[runAt] as TranscriptItem[]), ...g];
      continue;
    }
    if (g.type === "marker" && runAt >= 0) marks.push(out.length);
    out.push(g);
    if (g.type === "user") {
      runAt = -1;
      marks = [];
    }
  }
  return out;
}

/**
 * Süren turun canlı bölümünün başladığı indeks: turdaki son ara raporun hemen ardı. Gizli dürtme
 * (arka plan bitişi) turu rapordan sonra sürdürür; o noktadan sonrası canlı dizi, canlı başlık ve
 * canlı sayaç için tek kaynaktır. Turda rapor yoksa -1 (canlı bölüm kullanıcı mesajından başlar).
 * Yalnız tur sürerken anlamlıdır; `reports` tur kapanış sonuçlarıdır (`findTurnEnds`).
 */
export function liveSegmentStart(
  groups: readonly RunGroup[],
  reports: ReadonlySet<string>,
): number {
  let lastReport = -1;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === undefined || Array.isArray(g)) continue;
    if (g.type === "user") break;
    if (g.type === "assistant" && reports.has(g.id)) {
      lastReport = i;
      break;
    }
  }
  return lastReport < 0 ? -1 : lastReport + 1;
}
