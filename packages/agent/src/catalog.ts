import type { CatalogModel, ProviderInfo } from "@codezal/contracts";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialPool } from "./credential-pool.js";

/** Pi kataloğunu arayüz modeline çevirir. Kimlik bilgisi asla dışarı çıkmaz. */
export async function listProviders(
  runtime: ModelRuntime,
  pool?: CredentialPool,
): Promise<ProviderInfo[]> {
  const providers = runtime.getProviders();
  const out: ProviderInfo[] = [];
  for (const p of providers) {
    const authKinds: ProviderInfo["authKinds"] = [];
    if (p.auth.apiKey) authKinds.push("api_key");
    if (p.auth.oauth) authKinds.push("oauth");
    let connected = false;
    try {
      connected = (await runtime.checkAuth(p.id)) !== undefined;
    } catch {
      connected = false;
    }
    out.push({
      id: p.id,
      name: p.name,
      connected,
      authKinds,
      modelCount: runtime.getModels(p.id).length,
      keys: pool?.snapshot(p.id) ?? [],
    });
  }
  return out;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function listCatalog(runtime: ModelRuntime): CatalogModel[] {
  const available = new Set(runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
  return runtime.getModels().map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    vision: m.input.includes("image"),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    // Bazı katalog girdileri fiyatı bilinmediğinde negatif değer taşır; şema >=0 ister.
    cost: { input: nonNegative(m.cost?.input), output: nonNegative(m.cost?.output) },
    available: available.has(`${m.provider}/${m.id}`),
  }));
}

/**
 * API anahtarı girişi: **yalnız** "secret" istemine anahtarı verir, diğerlerini reddeder.
 *
 * `text` istemleri de anahtarla yanıtlanıyordu; oysa bazı sağlayıcılar anahtarın yanında ek metin
 * alanları sorar (Cloudflare hesap/kapı kimliği, Bedrock profil adı, Vertex proje kimliği).
 * Anahtar oraya yazılınca kullanıcı "bağlandı" görüyor ama yanlış alan doldurulmuş oluyordu.
 */
export function apiKeyInteraction(apiKey: string): AuthInteraction {
  return {
    prompt: async (prompt) => {
      if (prompt.type === "secret") return apiKey;
      throw new Error(`Desteklenmeyen kimlik istemi: ${prompt.type}`);
    },
    notify: () => {},
  };
}

/**
 * Katalog kimliği: uzak tazeleme sonrası liste gerçekten değişti mi, ondan anlaşılır.
 * Ad ve bağlam da girer; aynı kimlikli modelin fiyatı/penceresi güncellenince de arayüz tazelenir.
 */
export function catalogSignature(models: readonly CatalogModel[]): string {
  return models
    .map((m) => `${m.provider}/${m.id}:${m.name}:${m.contextWindow}:${m.maxTokens}`)
    .sort()
    .join("|");
}
