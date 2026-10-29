import type { McpConnector } from "@codezal/contracts";
import { foldForSearch } from "./searchText";
import type { SlashSuggestion } from "./slashSearch";

/**
 * `/` panelinde servis adı: katlanmış, yalnız `[a-z0-9-]`. Panel sorgusu boşluk ve `/` kabul
 * etmez; "Google Takvim" `google-takvim` olarak yazılır.
 */
export function connectorSlug(name: string): string {
  return foldForSearch(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** İstem adında sorguyu bölen karakterler (boşluk, `/`) tireye iner; ad başka türlü korunur. */
function promptSlug(name: string): string {
  return name.replace(/[\s/]+/g, "-");
}

/**
 * Bağlı servislerin istemleri, `/` paneli satırı olarak: `/<servis>:<istem>`. Seçim hemen çalışmaz
 * (`runOnPick: false`) ama etiket de bırakmaz; SlashPlugin istemi main'de işleyip metnini yazar.
 */
export function promptSuggestions(connectors: readonly McpConnector[]): SlashSuggestion[] {
  return connectors
    .filter((c) => c.status === "connected" && c.prompts.length > 0)
    .flatMap((c) => {
      const server = connectorSlug(c.name) || "mcp";
      return c.prompts.map<SlashSuggestion>((p) => {
        const value = `/${server}:${promptSlug(p.name)}`;
        return {
          id: `prompt:${c.id}:${p.name}`,
          kind: "prompt",
          value,
          label: value,
          description: p.description || p.title || c.name,
          keywords: [c.name, ...(p.title ? [p.title] : [])],
          icon: "mcp",
          runOnPick: false,
          prompt: { connectorId: c.id, name: p.name, arguments: p.arguments },
        };
      });
    });
}
