import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import { dict, type Locale } from "@codezal/i18n";
import { contentText, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripInvisible, wrapUntrusted } from "./untrusted.js";
import type { NativeSearchCompleter } from "./web-search-native.js";

const MAX_CHARS = 60_000;
const TIMEOUT_MS = 20_000;
/**
 * Gövdeden okunan en fazla bayt. Metin 60 bin karaktere kırpılsa da `res.text()` gövdenin tamamını
 * belleğe alıyordu; çok büyük (ya da bitmeyen) bir yanıt main sürecini şişirebilirdi.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** HTML'i kaba metne indirger: script/style atılır, etiketler boşluğa çevrilir, boşluklar sıkıştırılır. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function ipv4Private(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // 224/4 çoklu yayın, 240/4 ayrılmış ve 255.255.255.255
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protokol blokları, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 kıyaslama ağı
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** İki 16 bitlik gruptaki IPv4 adresini noktalı biçime çevirir. */
function v4From(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** IPv6 adresini sekiz 16 bitlik gruba açar (`::` ve sondaki gömülü IPv4 dahil). */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const octets = v4[1].split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

/**
 * Yerel ya da özel ağ adresi mi? Loopback (127/8, ::1), özel bloklar (10/8, 172.16/12,
 * 192.168/16, fc00::/7), bağlantı yerel (169.254/16, fe80::/10), CGNAT (100.64/10), 0.0.0.0/8,
 * belirtilmemiş adres, çoklu yayın/ayrılmış bloklar ve belge/kıyaslama ağları. IPv4 taşıyan IPv6
 * biçimleri (eşlemeli `::ffff:…`, 6to4 `2002::/16`, NAT64 `64:ff9b::/96`) IPv4 kuralına düşer;
 * gömülü adresi çözülemeyen tüneller (Teredo `2001::/32`, yerel NAT64 `64:ff9b:1::/48`) reddedilir.
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return ipv4Private(bare);
  if (family !== 6) return false;
  const g = ipv6Groups(bare);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:a.b.c.d (eşlemeli) ve ::a.b.c.d (eski uyumlu) gömülü IPv4 adresini taşır.
  if (zeroPrefix && (g5 === 0xffff || (g5 === 0 && (g6 !== 0 || g7 > 1))))
    return ipv4Private(v4From(g6, g7));
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 <= 1) return true; // :: ve ::1
  if (g0 === 0x2002) return ipv4Private(v4From(g1, g2)); // 6to4
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Private(v4From(g6, g7));
    return true; // 64:ff9b:1::/48 yerel NAT64
  }
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo: istemci adresi gizlenmiş taşınır
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // belge ağı
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 atma
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 çoklu yayın
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

/** Yalnızca http(s); dosya ve yerel ağ adresleri ajanın makineyi taramasına izin vermesin. */
export function assertFetchable(raw: string, lang: Locale = "tr"): URL {
  const d = dict(lang);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(d.errors.invalidUrl.replace("{{url}}", raw));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(d.errors.httpOnly);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateAddress(host)
  )
    throw new Error(d.errors.noLocalNet);
  return url;
}

/** Ad çözümleyici: testte enjekte edilir, gerçek ağa çıkılmaz. */
export type HostLookup = (host: string) => Promise<readonly string[]>;

const systemLookup: HostLookup = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Adın çözüldüğü **bütün** adresleri denetler ve döndürür. Metin denetimi `127.0.0.1.nip.io` ya da
 * iç ağa çözülen bir kayıt gibi adları geçiriyordu; tek bir özel adres bile reddeder (çözümleyici
 * sırasına güvenilmez). Adres metniyse `undefined` döner: çözülecek ad yoktur.
 */
export async function assertPublicHost(
  url: URL,
  lang: Locale = "tr",
  resolveHost: HostLookup = systemLookup,
): Promise<readonly string[] | undefined> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return undefined;
  const addresses = await resolveHost(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress))
    throw new Error(dict(lang).errors.noLocalNet);
  return addresses;
}

/** Bağlantının ad çözümünü yalnız önceden denetlenmiş adreslere bağlayan `lookup`. */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_host, options, callback) => {
    const first = entries[0];
    if (options.all) callback(null, entries);
    else if (first) callback(null, first.address, first.family);
    else callback(new Error("ENOTFOUND"), "", 0);
  };
}

/** Sıkıştırılmış gövdeyi açar; bilinmeyen kodlama olduğu gibi geçer (metin bozuk görünür). */
function decodeBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : undefined;
  if (!decoder) return res;
  // Hata `decoder`i de yok eder; web akışı hatayla kapanır, okuyan taraf bunu görür.
  return pipeline(res, decoder, () => undefined);
}

/**
 * Tek bir GET isteği; bağlantı `addresses` içindeki adreslerden birine açılır. `fetch` adı kendisi
 * yeniden çözdüğü için denetimle bağlantı arasındaki kısa ömürlü DNS kaydı (rebinding) iç ağa
 * yönelebiliyordu. TLS doğrulaması ve SNI yine URL'deki adla yapılır. Yönlendirme izlenmez.
 */
export function pinnedFetch(
  url: URL,
  addresses: readonly string[] | undefined,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        headers: { ...init.headers, "accept-encoding": "gzip, deflate, br" },
        // Paylaşılan havuz kapalı: başka bir istek için açılmış soket yeniden kullanılmasın.
        agent: false,
        ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const headers = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i];
          const value = res.rawHeaders[i + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        try {
          resolve(
            new Response(
              empty ? null : (Readable.toWeb(decodeBody(res)) as ReadableStream<Uint8Array>),
              { status, statusText: res.statusMessage ?? "", headers },
            ),
          );
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Yönlendirme zincirinde izlenen en fazla adım; sonsuz döngüye karşı. */
export const MAX_REDIRECTS = 5;

export interface FetchDeps {
  lookup?: HostLookup;
  /** Test için; verilirse bağlantı adrese sabitlenmez. */
  fetch?: typeof fetch;
  maxBytes?: number;
}

/** `www.` öneki dışında aynı ana makine mi. */
function sameHostModuloWww(a: string, b: string): boolean {
  const bare = (h: string) =>
    h
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  return bare(a) === bare(b);
}

/**
 * Otomatik izlenen yönlendirme: aynı site (`www.` farkı serbest) ve aynı protokol/port ya da
 * varsayılan portlarla http→https yükseltmesi; adreste kullanıcı adı/parola olmamalı. Başka
 * siteye yönlendirme izlenmez, modele döner (ZCode `isPermittedRedirect`): yeniden çağrı alan
 * adı onayına düşer, onaylı bir site kullanıcının görmediği başka bir siteye taşıyamaz.
 */
export function isFollowableRedirect(from: URL, to: URL): boolean {
  if (to.username || to.password) return false;
  if (!sameHostModuloWww(from.hostname, to.hostname)) return false;
  if (from.protocol === to.protocol) return from.port === to.port;
  return from.protocol === "http:" && to.protocol === "https:" && !from.port && !to.port;
}

/**
 * Yönlendirmeleri **elle** izler ve her adımı yeniden doğrular (adres metni + DNS çözümü).
 *
 * `redirect: "follow"` ile yalnız ilk adres denetleniyordu: herkese açık bir adres 302 ile
 * `http://127.0.0.1:9200/…` gibi yerel bir servise yönlendirdiğinde gövde modele dönüyordu
 * (SSRF). Model bir sayfadan ya da depodan okuduğu metnin etkisiyle bu çağrıyı yapabildiği için
 * kapı her adımda kurulmalı.
 */
async function fetchFollowingSafe(
  start: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
  lang: Locale,
  deps: FetchDeps,
): Promise<{ res: Response; url: URL } | { redirect: URL; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const addresses = await assertPublicHost(url, lang, deps.lookup);
    const res = deps.fetch
      ? await deps.fetch(url, { ...init, redirect: "manual" })
      : await pinnedFetch(url, addresses, init);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return { res, url };
    // Gövdeyi bırak; yönlendirme yanıtının içeriği kullanılmaz.
    await res.body?.cancel().catch(() => undefined);
    const next = assertFetchable(new URL(location, url).href, lang);
    if (!isFollowableRedirect(url, next)) return { redirect: next, url };
    url = next;
  }
  throw new Error(dict(lang).errors.tooManyRedirects.replace("{{n}}", String(MAX_REDIRECTS)));
}

/** Gövdeyi akışla okur; `maxBytes`e ulaşınca akışı keser. UTF-8 çözümü `res.text()` ile aynı. */
export async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - bytes;
    const chunk = value.byteLength > room ? value.subarray(0, room) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (bytes >= maxBytes) {
      truncated = value.byteLength > room || !(await reader.read()).done;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  text += decoder.decode();
  return { text, truncated };
}

/** Sayfayı indirir ve metne çevirir; araç ve testler aynı yolu kullanır. */
export async function fetchPageText(
  raw: string,
  options: { lang?: Locale; signal?: AbortSignal | undefined; deps?: FetchDeps } = {},
): Promise<{
  text: string;
  url: string;
  contentType: string;
  chars: number;
  /** Başka siteye yönlendirme: izlenmedi, gövde okunmadı. */
  redirect?: string;
}> {
  const lang = options.lang ?? "tr";
  const deps = options.deps ?? {};
  const url = assertFetchable(raw, lang);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const signal = options.signal;
  // Dinleyici `finally`de sökülür: uzun ömürlü tur sinyaline her çağrıda bir kapanış birikiyordu.
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const hop = await fetchFollowingSafe(
      url,
      {
        signal: ac.signal,
        headers: { "user-agent": "Codezal/0.1 (+https://codezal.app)", accept: "text/*,*/*" },
      },
      lang,
      deps,
    );
    if ("redirect" in hop)
      return {
        text: "",
        url: hop.url.href,
        contentType: "",
        chars: 0,
        redirect: hop.redirect.href,
      };
    const { res, url: final } = hop;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${res.status} ${res.statusText}`);
    }
    const type = res.headers.get("content-type") ?? "";
    const body = await readBodyLimited(res, deps.maxBytes ?? MAX_BODY_BYTES);
    // Görünmez karakterler HTML ayrıştırılmadan silinir; sayım ve kırpma temiz metne göre yapılır.
    const raw = stripInvisible(body.text);
    const text = /html/i.test(type) ? htmlToText(raw) : raw;
    const clipped =
      text.length > MAX_CHARS
        ? `${text.slice(0, MAX_CHARS)}\n\n[… ${text.length - MAX_CHARS} karakter kesildi]`
        : body.truncated
          ? `${text}\n\n[… yanıt ${deps.maxBytes ?? MAX_BODY_BYTES} baytta kesildi]`
          : text;
    return { text: clipped, url: final.href, contentType: type, chars: text.length };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Ayrı özet modelinin yanıt sınırı; ana ajana sayfa değil kısa bir çıkarım gider. */
const EXTRACT_MAX_TOKENS = 4_096;

export interface WebFetchOptions {
  /**
   * Doğruysa sayfa ana ajana verilmez, araçsız ayrı bir model çağrısıyla özetlenir (ZCode'un
   * `processFetchedContent` karşılığı). Gözetimsiz görev koşusunda açılır: sayfadaki talimat en
   * fazla özeti bozar, araç çağıramaz.
   */
  quarantine?: () => boolean;
  /** Özeti yapacak model (Ayarlar > Kullanım); boşsa, bulunamazsa ya da anahtarı yoksa görevin modeli. */
  summaryModel?: () => { provider: string; id: string } | null | undefined;
}

/**
 * Özet modelini çözer: seçilen model anahtarı olan (kullanılabilir) modeller arasında aranır;
 * yoksa oturumun modeli kullanılır. Seçim bayatlasa bile görev özetsiz kalıp hata vermesin.
 */
export function pickSummaryModel(
  ctx: ExtensionContext | undefined,
  ref: { provider: string; id: string } | null | undefined,
): ExtensionContext["model"] {
  const registry = ctx?.modelRegistry;
  if (ref && typeof registry?.getAvailable === "function") {
    const chosen = registry
      .getAvailable()
      .find((m) => m.provider === ref.provider && m.id === ref.id);
    if (chosen) return chosen;
  }
  return ctx?.model;
}

/**
 * Sayfayı araçsız tek bir model çağrısıyla istenen bilgiye indirger. İstekte araç tanımı yoktur;
 * sistem istemi sayfayı güvenilmez veri sayar. Model ya da kayıt yoksa hata verir: ham metne
 * düşmek korumayı sessizce kaldırırdı.
 */
export async function extractPage(
  input: {
    completer: NativeSearchCompleter | undefined;
    model: ExtensionContext["model"];
    url: string;
    page: string;
    prompt: string | undefined;
    signal?: AbortSignal | undefined;
  },
  lang: Locale,
): Promise<string> {
  const d = dict(lang);
  if (!input.completer || !input.model) throw new Error(d.errors.webFetchNoModel);
  const ask = input.prompt?.trim() || d.prompt.webFetchExtractDefault;
  const message = await input.completer.complete(
    input.model,
    {
      systemPrompt: d.prompt.webFetchExtractSystem,
      messages: [
        {
          role: "user",
          content: d.prompt.webFetchExtractUser
            .replace("{{prompt}}", () => ask)
            .replace("{{url}}", () => input.url)
            .replace("{{page}}", () => input.page),
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: EXTRACT_MAX_TOKENS,
      // OpenCode / OpenCode Go `x-opencode-session` başlığı olmadan 400 döner; Pi başlığı
      // `sessionId`'den ekler. Çağrı başına yeni kimlik: özet ayrı bir konuşma.
      sessionId: randomUUID(),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const text = contentText(message.content).trim();
  if (!text) throw new Error(d.errors.webFetchNoModel);
  return text;
}

/**
 * Asistan için web okuma aracı: bir sayfayı indirir, metne çevirir, 60 bin karakterle sınırlar.
 * Arama motoru yok; kullanıcı ya da model somut bir adres verir. Dil, araç açıklamasını seçer.
 */
export function webFetchTool(
  lang: Locale = "tr",
  deps: FetchDeps = {},
  options: WebFetchOptions = {},
) {
  const d = dict(lang);
  return defineTool({
    name: "web_fetch",
    label: "Web",
    description: d.prompt.webFetchDesc,
    promptSnippet: d.prompt.webFetchSnippet,
    parameters: Type.Object({
      url: Type.String({ description: "https://" }),
      prompt: Type.Optional(Type.String({ description: d.prompt.webFetchPrompt })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const page = await fetchPageText(params.url, { lang, signal, deps });
      if (page.redirect) {
        return {
          content: [
            { type: "text", text: d.prompt.webFetchRedirect.replace("{{url}}", page.redirect) },
          ],
          details: { url: page.url, redirect: page.redirect, contentType: "", chars: 0 },
        };
      }
      if (options.quarantine?.()) {
        const summary = await extractPage(
          {
            completer: ctx?.modelRegistry,
            model: pickSummaryModel(ctx, options.summaryModel?.()),
            url: page.url,
            page: page.text,
            prompt: params.prompt,
            signal,
          },
          lang,
        );
        return {
          content: [
            {
              type: "text",
              text: `${d.prompt.webFetchExtracted}\n\n${wrapUntrusted(page.url, summary, lang)}`,
            },
          ],
          details: {
            url: page.url,
            contentType: page.contentType,
            chars: page.chars,
            quarantined: true,
          },
        };
      }
      return {
        content: [{ type: "text", text: wrapUntrusted(page.url, page.text, lang) }],
        details: { url: page.url, contentType: page.contentType, chars: page.chars },
      };
    },
  });
}
