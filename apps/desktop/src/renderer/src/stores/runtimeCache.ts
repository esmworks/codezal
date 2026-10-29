import type { SessionRuntime } from "./reduce";

/**
 * Bellekte tutulan son açılmış oturum sayısı. Açılan her sohbetin transkripti (araç çıktıları,
 * görseller) uygulama kapanana dek bellekte kalıyordu; düşürülen oturum yeniden açılınca
 * `sessions:open` snapshot'ından kurulur.
 */
export const RUNTIME_CACHE_LIMIT = 20;

/**
 * Snapshot'ın geri getiremeyeceği ya da canlı akışa bağlı durum taşıyan runtime düşürülmez:
 * süren/bekleyen tur, yanıt bekleyen kartlar, çalışan arka plan işi, alt ajan listesi ve kod
 * incelemesi sonucu. Alt ajan listesi artık `sessions:open`'da da gelir, ama renderer'ın
 * gizlediği koşular ve kırpılmamış canlı izler orada yok; liste doluyken runtime tutulur.
 */
export function mustKeepRuntime(rt: SessionRuntime): boolean {
  return (
    rt.status !== "idle" ||
    rt.activeRunId !== null ||
    rt.permissions.length > 0 ||
    rt.planReview !== null ||
    rt.question !== null ||
    rt.extensionUi !== null ||
    rt.backgrounds.some((b) => b.status === "running") ||
    rt.subagents.length > 0 ||
    rt.review !== null
  );
}

/**
 * Düşürülecek oturumlar. `recency` en eski başta, en yeni sonda; son `limit` açılan, `keep`
 * içindekiler (aktif sohbet, açılışı süren oturum) ve `mustKeepRuntime` olanlar kalır. Sırada
 * hiç görünmeyen runtime en eski sayılır.
 */
export function runtimeEvictions(
  runtime: Readonly<Record<string, SessionRuntime>>,
  recency: readonly string[],
  keep: ReadonlySet<string>,
  limit: number = RUNTIME_CACHE_LIMIT,
): string[] {
  const loaded = recency.filter((id) => id in runtime);
  const recent = new Set(loaded.slice(Math.max(0, loaded.length - limit)));
  const out: string[] = [];
  for (const [id, rt] of Object.entries(runtime)) {
    if (recent.has(id) || keep.has(id) || mustKeepRuntime(rt)) continue;
    out.push(id);
  }
  return out;
}
