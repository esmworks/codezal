import type { AppContext } from "../context.js";
import { handle } from "../ipc.js";
import { quotaSnapshot, refreshQuotas } from "../quota/index.js";

/** Kota kanalları: önbellek okuma ve tazeleme. Anahtar yuvadan main süreçte çözülür. */
export function registerQuotaIpc({ engine }: AppContext): void {
  handle("quota:list", () => quotaSnapshot());
  handle("quota:refresh", async ({ provider, force }) => {
    const providers = await engine.providers();
    const selected = providers.filter((p) => (provider ? p.id === provider : p.connected));
    const targets = await Promise.all(
      selected.map(async (p) => ({ provider: p.id, apiKey: await engine.apiKeyFor(p.id) })),
    );
    return refreshQuotas(targets, { force });
  });
}
