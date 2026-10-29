import type { TranscriptItem } from "@codezal/contracts";

/** Grup listesindeki tek öğe: çalışma dizisi ya da tek transcript öğesi. */
export type RunGroup = TranscriptItem[] | TranscriptItem;

/**
 * Katlanmayan çalışma dizilerinin indeksleri.
 *
 * Karar dizinin hemen ardındaki öğeye değil, o kullanıcı turunun son kapanışına göre verilir:
 * tur içi ara raporlar ve dürtme sınırları atlanır (bkz. `mergeTurnRuns`), çünkü dürtmeden sonra
 * iş aynı turda sürüyor. Tur, kapanış metni gelmeden bitiyorsa (Esc/Durdur, boş yanıt) ya da
 * kapanışı hata/kesme ile bitiyorsa dizi açık kalır: kullanıcı yarım kalan işi özet satırının
 * arkasına saklanmadan görür. Süren dizi zaten açıktır, kümeye girmez.
 *
 * Süren turda canlı bölümden (`liveFrom`, bkz. `liveSegmentStart`) önceki dizi raporla kapanmıştır
 * ve katlanır; yoksa canlı işin üstünde bütün eski adımlar açık kalırdı.
 */
export function findExpandedRuns(
  groups: readonly RunGroup[],
  liveRun: number,
  finals: ReadonlySet<string>,
  liveFrom = -1,
): Set<number> {
  const out = new Set<number>();
  groups.forEach((g, i) => {
    if (!Array.isArray(g) || i === liveRun) return;
    if (!closedAfter(groups, i + 1, finals, liveFrom)) out.add(i);
  });
  return out;
}

/**
 * Süren turun canlı satırları: canlı dizi (son dizi) ya da dizisi yoksa başlığı taşıyan ilk asistan
 * öğesi. Arama `liveFrom`'dan başlar (kullanıcı mesajından ya da son ara rapordan sonrası); yoksa
 * dürtmeden sonra ilk araç gelene kadar raporun üstündeki eski dizi "sürüyor" görünüyordu.
 */
export function findLiveRows(
  groups: readonly RunGroup[],
  finals: ReadonlySet<string>,
  liveFrom: number,
): { liveRun: number; liveHead: number } {
  const lastUser = groups.findLastIndex((g) => !Array.isArray(g) && g.type === "user");
  const from = Math.max(lastUser + 1, liveFrom);
  const liveRun = groups.findLastIndex((g, i) => i >= from && Array.isArray(g));
  const liveHead =
    liveRun >= 0
      ? -1
      : groups.findIndex(
          (g, i) => i >= from && !Array.isArray(g) && g.type === "assistant" && !finals.has(g.id),
        );
  return { liveRun, liveHead };
}

/**
 * Dizinin ardından gelen tur kapanışının iyi huylu olup olmadığı. Kapanışa kadar ara raporlar ve
 * dürtme sınırları atlanır; tur kapanmadan bitti (kullanıcı mesajı ya da liste sonu) ya da kapanış
 * hata/kesme ile bittiyse "kapanmadı" sayılır.
 */
function closedAfter(
  groups: readonly RunGroup[],
  from: number,
  finals: ReadonlySet<string>,
  liveFrom: number,
): boolean {
  for (let i = from; i < groups.length; i++) {
    // Canlı bölüme varıldı: dizinin ardında turun son ara raporu var, iş rapordan sonra sürüyor.
    if (i === liveFrom) return true;
    const g = groups[i];
    if (g === undefined || Array.isArray(g)) continue;
    if (g.type === "user") return false;
    if (g.type === "assistant" && finals.has(g.id))
      return g.stopReason !== "error" && g.stopReason !== "aborted";
  }
  return false;
}
