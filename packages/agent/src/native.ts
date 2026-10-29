import { type Dict, dict, type Locale } from "@codezal/i18n";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";

/**
 * Uygulama içi servisler: MCP sunucusu yerine sağlayıcının kendi API'sine giden bağlayıcılar.
 * Google'ın barındırdığı MCP sunucuları Workspace Geliştirici Önizlemesi'ne kapalı (kişisel Gmail
 * hesapları alınmıyor); ürün API'leri ise herkese açık. Belirteçler, giriş akışı ve mağaza MCP
 * bağlayıcılarıyla ortak; yalnızca taşıma katmanı farklı. Bu dosya ortak tipleri ve yardımcıları
 * tutar; servisler `native-*.ts` dosyalarında, kayıt `native-services.ts` içinde.
 */
export type NativeServiceId = "gdrive" | "gmail" | "gcalendar" | "gdocs" | "gsheets" | "gslides";

export interface NativeContext {
  /** API kökü (bağlayıcı adresi), ör. `https://www.googleapis.com/drive/v3`. */
  baseUrl: string;
  /** Drive API kökü; Dokümanlar/E-Tablolar/Slaytlar dosya aramasını buradan yapar. */
  driveUrl: string;
  /** Bearer başlığını ekler; 401'de belirteci yeniler ve bir kez daha dener. */
  request: (url: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal | undefined;
  lang: Locale;
}

export type NativeCall = (
  ctx: NativeContext,
  args: Record<string, unknown>,
) => Promise<AgentToolResult<unknown>>;

export interface NativeService {
  /** OAuth keşfi için yetki sunucusu (Google: `accounts.google.com`, openid-configuration). */
  authServerUrl: string;
  tools: (lang: Locale) => Tool[];
  /**
   * Bağlanırken belirteci ve API erişimini ucuz bir çağrıyla doğrular; hata fırlatır. Aynı yanıt
   * hesabı da taşır (Drive `about.user`, Gmail `profile`): e-posta döner, yoksa null.
   */
  probe: (ctx: NativeContext) => Promise<string | null>;
  call: (
    ctx: NativeContext,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<AgentToolResult<unknown>>;
}

// Sözlük yardımcıları i18n paketinde tanımlı; `native-*.ts` dosyaları buradan import etmeye devam eder.
export { type Dict, dict };

/** Sağlayıcı API hatası: durum kodu `status` alanında (SDK `SdkHttpError` ile aynı biçim). */
export class NativeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NativeHttpError";
  }
}

export const GOOGLE_AUTH_SERVER = "https://accounts.google.com";
export const GDRIVE_API_URL = "https://www.googleapis.com/drive/v3";

/**
 * Okuma araçlarının MCP işareti (`readOnlyHint`). Ayarlar'daki araç listesi "salt okunur" rozetini
 * buradan gösterir; izin kararı bu işarete değil kullanıcının seçtiği araç iznine bakar.
 */
export const READ_ONLY_TOOL = { annotations: { readOnlyHint: true } } as const;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Model bağlamını korumak için okunan içerik kesilir (web_fetch ile aynı ölçü). */
export const MAX_READ_CHARS = 60_000;

export function text(t: string, details: unknown = undefined): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details };
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function limitOf(v: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** Uzun içerik kesilir; kesildiyse sona not düşülür. */
export function clip(content: string, d: Dict, max = MAX_READ_CHARS): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n${d.prompt.gdriveTruncated.replace("{{chars}}", String(max))}`;
}

/** Google hata gövdesi `{ error: { message } }`; yoksa ham metin. */
export async function fail(res: Response, d: Dict): Promise<never> {
  const body = await res.text().catch(() => "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // JSON değil; ham gövde kalır.
  }
  const short = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  throw new NativeHttpError(
    res.status,
    `${d.errors.mcpHttpError.replace("{{status}}", String(res.status))}${short ? ` · ${short}` : ""}`,
  );
}

export async function json<T>(ctx: NativeContext, url: string, init?: RequestInit): Promise<T> {
  const res = await ctx.request(url, { ...init, signal: ctx.signal ?? null });
  if (!res.ok) await fail(res, dict(ctx.lang));
  return (await res.json()) as T;
}

/** JSON gövdeli POST/PUT kısayolu. */
export function jsonBody(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  };
}

/** TypeBox şeması MCP araç şemasına (düz JSON) çevrilir; MCP araçlarıyla aynı yoldan Pi'ye gider. */
export function jsonSchema(schema: TSchema): Tool["inputSchema"] {
  return JSON.parse(JSON.stringify(schema));
}

/** Araç tablosundan `call` üretir; bilinmeyen ad servis hatası döner. */
export function dispatcher(tools: Record<string, NativeCall>): NativeService["call"] {
  return (ctx, tool, args) => {
    const run = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
    if (!run) throw new Error(dict(ctx.lang).errors.mcpToolError);
    return run(ctx, args);
  };
}

/** Google API ID'si bağlantı olarak da verilebilir: `/d/<id>` parçası ya da düz id. */
export function idFrom(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return m?.[1] ?? s;
}
