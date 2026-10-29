import type { NativeContext } from "./native.js";

/**
 * Uygulama içi servis testleri için sahte istek bağlamı; `native-*.test.ts` dosyaları paylaşır,
 * uygulama kodu kullanmaz. Gerçek ağa çıkılmaz: her istek kaydedilir ve `routes` yanıtlar.
 * Yönlendirici düz nesne dönerse 200 JSON, `Response` dönerse olduğu gibi kullanılır.
 */
export interface FakeCall {
  url: URL;
  method: string;
  /** JSON gövde çözülür; JSON olmayan metin gövde ham kalır. */
  body: unknown;
  rawBody: string | null;
  headers: Headers;
  signal: AbortSignal | null | undefined;
}

export type FakeCtx = NativeContext & { calls: FakeCall[] };

export function fakeCtx(
  routes: (url: URL, call: FakeCall) => unknown,
  opts: { signal?: AbortSignal; lang?: NativeContext["lang"] } = {},
): FakeCtx {
  const calls: FakeCall[] = [];
  return {
    calls,
    baseUrl: "https://api.test/v1",
    driveUrl: "https://drive.test/v3",
    signal: opts.signal,
    lang: opts.lang ?? "tr",
    request: async (raw, init) => {
      const url = new URL(raw);
      const rawBody = typeof init?.body === "string" ? init.body : null;
      let body: unknown = null;
      if (rawBody !== null) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      const call: FakeCall = {
        url,
        method: init?.method ?? "GET",
        body,
        rawBody,
        headers: new Headers(init?.headers),
        signal: init?.signal,
      };
      calls.push(call);
      const out = routes(url, call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** Kayıtlı çağrı; yoksa test açık hata verir. */
export function callAt(ctx: { calls: FakeCall[] }, i: number): FakeCall {
  const c = ctx.calls.at(i);
  if (!c) throw new Error(`çağrı yok: ${i}`);
  return c;
}

export function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** Google hata gövdesiyle yanıt (`{ error: { message } }`). */
export function googleError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

export const b64url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const fromB64url = (s: string): string =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
