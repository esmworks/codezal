import type { McpNativeService } from "@codezal/contracts";

/**
 * Hazır bağlayıcılar: adresi ve kimlik doğrulama biçimi 2026-09-06'da doğrulanmış resmi uzak MCP
 * sunucuları. Google girişleri MCP değil (`native`): Google'ın MCP sunucuları Workspace Geliştirici
 * Önizlemesi'ne kapalı olduğundan Codezal ürün API'lerini (Drive, Gmail, Takvim, Dokümanlar,
 * E-Tablolar, Slaytlar) doğrudan çağırır; `url` API köküdür. `oauth` olanlar dinamik istemci kaydını loopback yönlendirmeyle kabul etti; `open`
 * olanlar girişsiz çalışır; `token` olanlar sabit belirteç ister; `ownClient` olanlar (Google) DCR
 * desteklemediğinden kullanıcının Google Cloud'da açtığı OAuth istemcisini ister. Açıklamalar
 * `settings.connectorCatalog.<id>` anahtarındadır.
 */
export type CatalogAuth = "oauth" | "open" | "token" | "ownClient";
export type CatalogCategory = "google" | "productivity" | "dev" | "docs" | "payments";

export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: CatalogAuth;
  category: CatalogCategory;
  /** Kurulum belgeleri. */
  docs: string;
  /** Logosu olmayan servisler için döşeme rengi; logosu olanlarda renk `CONNECTOR_LOGOS`'tan gelir. */
  color?: string;
  /** Logosu olmayan servisin döşemesindeki baş harfler (markanın yazımıyla, ör. "m"). */
  monogram?: string;
  /** `token` için belirteç isteğe bağlı mı (anonim de çalışır). */
  tokenOptional?: boolean;
  /** Aynı OAuth istemcisini paylaşan aile; `ownClient` girişleri için. */
  clientGroup?: string;
  /** Yetki adresine eklenen parametreler (Google yenileme belirteci için). */
  authorizeParams?: Record<string, string>;
  /** MCP değil, Codezal'ın doğrudan çağırdığı API; `url` API köküdür. */
  native?: McpNativeService;
}

const G = "https://www.googleapis.com/auth/";

/**
 * Google ortak alanları. `scope` ürüne göre daraltılır: sunucu meta verisi tüm kapsamları listeler
 * (Gmail'de tam posta kutusu dahil), oysa Google'ın kendi belgesi izin ekranına bu kısa listeyi
 * yazmayı söyler. `access_type=offline` + `prompt=consent` yenileme belirteci için gerekir.
 */
const google = (scope: string[]) => ({
  auth: "ownClient" as const,
  category: "google" as const,
  clientGroup: "google",
  authorizeParams: {
    access_type: "offline",
    prompt: "consent",
    scope: scope.map((x) => G + x).join(" "),
  },
});

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    url: "https://gmail.googleapis.com/gmail/v1/users/me",
    ...google(["gmail.readonly", "gmail.compose"]),
    native: "gmail",
    docs: "https://developers.google.com/workspace/gmail/api/guides",
  },
  {
    id: "gdrive",
    name: "Google Drive",
    url: "https://www.googleapis.com/drive/v3",
    ...google(["drive.readonly", "drive.file"]),
    native: "gdrive",
    docs: "https://developers.google.com/workspace/drive/api/guides/about-sdk",
  },
  {
    id: "gcalendar",
    name: "Google Calendar",
    url: "https://www.googleapis.com/calendar/v3",
    ...google([
      "calendar.calendarlist.readonly",
      "calendar.events.freebusy",
      "calendar.events.readonly",
    ]),
    native: "gcalendar",
    docs: "https://developers.google.com/workspace/calendar/api/guides/overview",
  },
  {
    // Dokümanlar/E-Tablolar/Slaytlar aramayı Drive API ile yapar; `drive.readonly` bunun için.
    id: "gdocs",
    name: "Google Docs",
    url: "https://docs.googleapis.com/v1",
    ...google(["drive.readonly", "documents"]),
    native: "gdocs",
    docs: "https://developers.google.com/workspace/docs/api/how-tos/overview",
  },
  {
    id: "gsheets",
    name: "Google Sheets",
    url: "https://sheets.googleapis.com/v4",
    ...google(["drive.readonly", "spreadsheets"]),
    native: "gsheets",
    docs: "https://developers.google.com/workspace/sheets/api/guides/concepts",
  },
  {
    id: "gslides",
    name: "Google Slides",
    url: "https://slides.googleapis.com/v1",
    ...google(["drive.readonly", "presentations"]),
    native: "gslides",
    docs: "https://developers.google.com/workspace/slides/api/guides/overview",
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira, Confluence)",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
  },
  {
    id: "asana",
    name: "Asana",
    url: "https://mcp.asana.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://developers.asana.com/docs/using-asanas-model-control-protocol-mcp-server",
  },
  {
    id: "monday",
    name: "monday.com",
    url: "https://mcp.monday.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
    color: "#6161FF",
    monogram: "m",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://airtable.com/developers/mcp",
  },
  {
    id: "canva",
    name: "Canva",
    url: "https://mcp.canva.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://www.canva.dev/docs/mcp/",
  },
  {
    id: "webflow",
    name: "Webflow",
    url: "https://mcp.webflow.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://developers.webflow.com/data/docs/ai-tools",
  },
  {
    id: "intercom",
    name: "Intercom",
    url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://developers.intercom.com/docs/guides/mcp",
  },
  {
    id: "zapier",
    name: "Zapier",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: "oauth",
    category: "productivity",
    docs: "https://zapier.com/mcp",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    url: "https://app.hubspot.com/mcp/v1/http",
    auth: "token",
    category: "productivity",
    docs: "https://developers.hubspot.com/mcp",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    category: "dev",
    docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    category: "dev",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com/",
    auth: "oauth",
    category: "dev",
    docs: "https://vercel.com/docs/mcp/vercel-mcp",
  },
  {
    id: "supabase",
    name: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    auth: "oauth",
    category: "dev",
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
  },
  {
    id: "neon",
    name: "Neon",
    url: "https://mcp.neon.tech/mcp",
    auth: "oauth",
    category: "dev",
    docs: "https://neon.com/docs/ai/neon-mcp-server",
    color: "#00E599",
    monogram: "N",
  },
  {
    id: "context7",
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    auth: "token",
    tokenOptional: true,
    category: "docs",
    docs: "https://context7.com/docs",
    color: "#7C3AED",
    monogram: "C7",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "open",
    category: "docs",
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    color: "#2563EB",
    monogram: "DW",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    url: "https://huggingface.co/mcp",
    auth: "open",
    category: "docs",
    docs: "https://huggingface.co/settings/mcp",
  },
  {
    id: "cloudflareDocs",
    name: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "open",
    category: "docs",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    id: "mslearn",
    name: "Microsoft Learn",
    url: "https://learn.microsoft.com/api/mcp",
    auth: "open",
    category: "docs",
    docs: "https://learn.microsoft.com/training/support/mcp",
    color: "#0078D4",
    monogram: "ML",
  },
  {
    id: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com/",
    auth: "oauth",
    category: "payments",
    docs: "https://docs.stripe.com/mcp",
  },
  {
    id: "paypal",
    name: "PayPal",
    url: "https://mcp.paypal.com/mcp",
    auth: "oauth",
    category: "payments",
    docs: "https://developer.paypal.com/tools/mcp-server/",
  },
  {
    id: "square",
    name: "Square",
    url: "https://mcp.squareup.com/mcp",
    auth: "oauth",
    category: "payments",
    docs: "https://developer.squareup.com/docs/mcp",
  },
];

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  "google",
  "productivity",
  "dev",
  "docs",
  "payments",
];

/** Google Cloud'da kayıtlı olması gereken yönlendirme adresi (agent CALLBACK_PORT ile aynı). */
export const OWN_CLIENT_REDIRECT_URI = "http://127.0.0.1:47821/callback";

/** Aynı adres eklenmişse katalog kartı "Eklendi" gösterir; sondaki `/` farkı yok sayılır. */
export function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
