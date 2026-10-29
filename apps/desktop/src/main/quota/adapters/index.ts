import { commandcodeQuota } from "./commandcode.js";
import { deepseekQuota } from "./deepseek.js";
import { opencodeGoQuota } from "./opencode-go.js";
import { openrouterQuota } from "./openrouter.js";
import type { QuotaAdapter } from "./types.js";
import { zaiQuota, zhipuQuota } from "./zai.js";

/**
 * Kota ucu bilinen sağlayıcılar. Listede olmayan sağlayıcı arayüzde "kota ucu yok" olarak
 * gösterilir; bu yüzden buraya yalnız canlı doğrulanmış (ya da resmî belgelenmiş) uçlar girer.
 */
export const ADAPTERS: ReadonlyMap<string, QuotaAdapter> = new Map(
  [commandcodeQuota, opencodeGoQuota, deepseekQuota, openrouterQuota, zaiQuota, zhipuQuota].map(
    (adapter) => [adapter.id, adapter],
  ),
);
