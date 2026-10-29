import type { CatalogModel, ModelRef, ProviderInfo } from "@codezal/contracts";
import { foldForSearch } from "./searchText";

export interface ModelGroup {
  key: string;
  /** Görünen başlık: sağlayıcı adı. "recent" grubunun başlığı sözlükten gelir (modelPicker.recent). */
  title?: string;
  models: CatalogModel[];
}

// Katlama `searchText`ten: `toLocaleLowerCase("tr")` ASCII kısaltmaları (ipc, ui) bozuyordu.
const norm = (s: string) => foldForSearch(s).replace(/[\s_-]+/g, "");

/** Arama eşleşmesi: kimlik, ad ve sağlayıcı; boşluk ve tire duyarsız. */
export function matchesModel(m: CatalogModel, providerName: string, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return [m.id, m.name, m.provider, providerName].some((s) => norm(s).includes(q));
}

/**
 * Kullanılabilir modeller ve sağlayıcı adı haritası; iki sütun da bu ortak süzgeci paylaşır.
 * Bağlı olmayan sağlayıcının modelleri listede görünmez.
 */
function usableModels(catalog: CatalogModel[], providers: ProviderInfo[]) {
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  return { nameOf, models: catalog.filter((m) => m.available && nameOf.has(m.provider)) };
}

/** Son kullanılanlar: katalogdaki karşılıkları, en yeni önde. */
function recentModels(recent: ModelRef[], models: CatalogModel[]): CatalogModel[] {
  return recent
    .map((r) => models.find((m) => m.provider === r.provider && m.id === r.id))
    .filter((m): m is CatalogModel => m !== undefined);
}

/**
 * Arama sonuçlarının düz listesi: yalnızca bağlı sağlayıcıların kullanılabilir modelleri.
 * Önce "Son kullanılan" (varsa ve sorguyla eşleşiyorsa), sonra sağlayıcı başına bir grup.
 */
export function modelGroups(
  catalog: CatalogModel[],
  providers: ProviderInfo[],
  recent: ModelRef[],
  query: string,
): ModelGroup[] {
  const { nameOf, models } = usableModels(catalog, providers);
  const visible = models.filter((m) => matchesModel(m, nameOf.get(m.provider) ?? "", query));
  const groups: ModelGroup[] = [];

  const recents = recentModels(recent, visible);
  if (recents.length > 0) groups.push({ key: "recent", models: recents });

  for (const p of providers.filter((x) => x.connected)) {
    const list = visible.filter((m) => m.provider === p.id);
    if (list.length > 0) groups.push({ key: p.id, title: p.name, models: list });
  }
  return groups;
}

/**
 * İki sütunlu seçicinin sol sütunu: "Son kullanılan" (varsa) ve bağlı her sağlayıcı.
 * Modeli olmayan sağlayıcı da listelenir; sağ sütun boş durumu yazar.
 */
export function providerEntries(
  catalog: CatalogModel[],
  providers: ProviderInfo[],
  recent: ModelRef[],
): ModelGroup[] {
  const { models } = usableModels(catalog, providers);
  const entries: ModelGroup[] = [];

  const recents = recentModels(recent, models);
  if (recents.length > 0) entries.push({ key: "recent", models: recents });

  for (const p of providers.filter((x) => x.connected)) {
    entries.push({ key: p.id, title: p.name, models: models.filter((m) => m.provider === p.id) });
  }
  return entries;
}

/**
 * Açılış konumu: geçerli modelin sağlayıcı grubu ve o gruptaki satırı. Model bulunamazsa
 * ilk satırlar; "Son kullanılan" grubuna değil, modelin kendi sağlayıcısına konumlanılır.
 */
export function initialSelection(
  groups: ModelGroup[],
  model: ModelRef | null | undefined,
): { group: number; model: number } {
  if (!model) return { group: 0, model: 0 };
  const group = groups.findIndex((g) => g.key === model.provider);
  if (group < 0) return { group: 0, model: 0 };
  const index = (groups[group]?.models ?? []).findIndex((m) => m.id === model.id);
  return { group, model: Math.max(0, index) };
}

/** Düz liste: klavye gezintisi için grupların ardışık modelleri. */
export function flatModels(groups: ModelGroup[]): CatalogModel[] {
  return groups.flatMap((g) => g.models);
}

/**
 * Web özeti çağrısının tipik boyutu: htmlToText sonrası bir haber sayfası ya da arama sonuçları
 * (~8 bin token girdi) ve maddeli kısa özet (~700 token çıktı). Oran sıralama içindir; mutlak
 * tutar sayfaya göre değişir.
 */
export const SUMMARY_INPUT_TOKENS = 8_000;
export const SUMMARY_OUTPUT_TOKENS = 700;

/** Tek bir web özeti çağrısının tahmini maliyeti (USD); fiyatı bilinmeyen modelde `undefined`. */
export function summaryCallCost(m: CatalogModel): number | undefined {
  if (m.cost.input <= 0 && m.cost.output <= 0) return undefined;
  return (m.cost.input * SUMMARY_INPUT_TOKENS + m.cost.output * SUMMARY_OUTPUT_TOKENS) / 1_000_000;
}

/**
 * Özet modeli adayları: anahtarı olanlar, tahmini özet maliyetine göre ucuzdan pahalıya; fiyatı
 * bilinmeyenler sonda, kendi aralarında katalog sırasıyla.
 */
export function summaryModelsByCost(catalog: CatalogModel[]): CatalogModel[] {
  const cost = (m: CatalogModel) => summaryCallCost(m) ?? Number.POSITIVE_INFINITY;
  return catalog
    .filter((m) => m.available)
    .map((m, i) => ({ m, i, c: cost(m) }))
    .sort((a, b) => (a.c === b.c ? a.i - b.i : a.c - b.c))
    .map((x) => x.m);
}
