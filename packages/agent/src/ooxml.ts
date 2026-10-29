import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Office paketleri (OOXML) için paketsiz ZIP ve XML katmanı: Word okuma (`docx.ts`) ve düzenleme
 * (`docx-edit.ts`) paylaşır.
 *
 * Düzenlemede ilke "dokunmadığını bozma"dır: değişmeyen ZIP girdileri ham (sıkıştırılmış)
 * baytlarıyla kopyalanır; değişen XML ayrıştırılıp geri yazılırken bildirim (`<?xml?>`), yorum ve
 * işlem talimatları olduğu gibi korunur. Geri yazım bayt bayt aynı değildir (varlıklar ve boş
 * etiketler normalleşir: `<a></a>` → `<a/>`) ama anlamca aynıdır; Word ikisini ayırt etmez.
 */

/** Tek bir girdinin açılmış hâli için üst sınır: ZIP bombası belleği tüketmesin. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export type OoxmlErrorCode = "notZip" | "zip64" | "noBody";

/** Kodlu hata: iletiyi çağıran kendi diliyle yazar. */
export class OoxmlError extends Error {
  constructor(readonly code: OoxmlErrorCode) {
    super(code);
  }
}

// ─── ZIP ────────────────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipArchive {
  readonly #buf: Buffer;
  readonly #entries: ZipEntry[];
  readonly #changed = new Map<string, Buffer>();
  readonly #removed = new Set<string>();

  private constructor(buf: Buffer, entries: ZipEntry[]) {
    this.#buf = buf;
    this.#entries = entries;
  }

  /**
   * Merkez dizini okur. Yerel başlıktaki boyutlar veri tanımlayıcısıyla (bit 3) sıfır gelebildiği
   * için boyut ve CRC merkez dizinden alınır. ZIP64 desteklenmez: Word paketleri o boyuta varmaz.
   */
  static open(bytes: Uint8Array): ZipArchive {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length < 22) throw new OoxmlError("notZip");
    const min = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new OoxmlError("notZip");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (p === 0xffffffff || count === 0xffff) throw new OoxmlError("zip64");
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
        throw new OoxmlError("notZip");
      }
      const nameLength = buf.readUInt16LE(p + 28);
      const extraLength = buf.readUInt16LE(p + 30);
      const commentLength = buf.readUInt16LE(p + 32);
      entries.push({
        name: buf.toString("utf8", p + 46, p + 46 + nameLength),
        flags: buf.readUInt16LE(p + 8),
        method: buf.readUInt16LE(p + 10),
        time: buf.readUInt16LE(p + 12),
        date: buf.readUInt16LE(p + 14),
        crc: buf.readUInt32LE(p + 16),
        compressedSize: buf.readUInt32LE(p + 20),
        size: buf.readUInt32LE(p + 24),
        localOffset: buf.readUInt32LE(p + 42),
      });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipArchive(buf, entries);
  }

  /** Boş paket: üretim (`xlsx-build.ts`) girdileri `set` ile ekler. */
  static create(): ZipArchive {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    return ZipArchive.open(end);
  }

  names(): string[] {
    const names = this.#entries.map((e) => e.name).filter((n) => !this.#removed.has(n));
    for (const name of this.#changed.keys()) if (!names.includes(name)) names.push(name);
    return names;
  }

  has(name: string): boolean {
    if (this.#removed.has(name)) return false;
    return this.#changed.has(name) || this.#entries.some((e) => e.name === name);
  }

  #raw(entry: ZipEntry): Buffer {
    const at = entry.localOffset;
    if (at + 30 > this.#buf.length || this.#buf.readUInt32LE(at) !== 0x04034b50) {
      throw new OoxmlError("notZip");
    }
    const start = at + 30 + this.#buf.readUInt16LE(at + 26) + this.#buf.readUInt16LE(at + 28);
    const end = start + entry.compressedSize;
    if (end > this.#buf.length) throw new OoxmlError("notZip");
    return this.#buf.subarray(start, end);
  }

  read(name: string): Buffer | undefined {
    if (this.#removed.has(name)) return undefined;
    const changed = this.#changed.get(name);
    if (changed) return changed;
    const entry = this.#entries.find((e) => e.name === name);
    if (!entry) return undefined;
    const raw = this.#raw(entry);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new OoxmlError("zip64");
  }

  readText(name: string): string | undefined {
    return this.read(name)?.toString("utf8");
  }

  set(name: string, data: Buffer | string): void {
    this.#removed.delete(name);
    this.#changed.set(name, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  /** Girdiyi paketten çıkarır (Excel'de silinen sayfa, `calcChain.xml`). */
  remove(name: string): void {
    this.#changed.delete(name);
    this.#removed.add(name);
  }

  /**
   * Paketi yeniden yazar. Değişmeyen girdi ham baytlarıyla kopyalanır (yeniden sıkıştırılmaz,
   * CRC'si aynı kalır); veri tanımlayıcısı bayrağı (bit 3) düşer çünkü boyutlar artık yerel
   * başlıkta yazılıdır. Sıra korunur, yeni girdiler sona eklenir.
   */
  toBuffer(): Buffer {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    const write = (e: Omit<ZipEntry, "localOffset">, data: Buffer) => {
      const name = Buffer.from(e.name, "utf8");
      const flags = (e.flags & ~0x0008) | 0x0800;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(e.time, 10);
      local.writeUInt16LE(e.date, 12);
      local.writeUInt32LE(e.crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(e.size, 22);
      local.writeUInt16LE(name.length, 26);
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(20, 4);
      dir.writeUInt16LE(20, 6);
      dir.writeUInt16LE(flags, 8);
      dir.writeUInt16LE(e.method, 10);
      dir.writeUInt16LE(e.time, 12);
      dir.writeUInt16LE(e.date, 14);
      dir.writeUInt32LE(e.crc, 16);
      dir.writeUInt32LE(data.length, 20);
      dir.writeUInt32LE(e.size, 24);
      dir.writeUInt16LE(name.length, 28);
      dir.writeUInt32LE(offset, 42);
      parts.push(local, name, data);
      central.push(dir, name);
      offset += local.length + name.length + data.length;
    };
    const fresh = (name: string, data: Buffer, time = 0, date = 0x21) =>
      write(
        {
          name,
          flags: 0,
          method: 8,
          time,
          date,
          crc: crc32(data),
          compressedSize: 0,
          size: data.length,
        },
        deflateRawSync(data),
      );
    for (const entry of this.#entries) {
      if (this.#removed.has(entry.name)) continue;
      const changed = this.#changed.get(entry.name);
      if (changed) fresh(entry.name, changed, entry.time, entry.date);
      else write(entry, this.#raw(entry));
    }
    for (const [name, data] of this.#changed) {
      if (!this.#entries.some((e) => e.name === name)) fresh(name, data);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
  }
}

// ─── XML ────────────────────────────────────────────────────────────────────────────────────────

/** Bildirim, yorum, işlem talimatı: anlamı yok ama geri yazımda yerinde kalmalı. */
export interface XmlRaw {
  raw: string;
}

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlChild[];
}

export type XmlChild = XmlNode | XmlRaw | string;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

const TOKEN =
  /(<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!(?!\[CDATA\[)[^>]*>)|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)([^>]*?)(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * OOXML için yeterli, hoşgörülü bir ayrıştırıcı: ad alanı öneki adın parçası kalır (`w:p`),
 * eşleşmeyen kapanış etiketi yığında eşini bulana kadar açıkları kapatır. DTD ve varlık tanımı
 * işlenmez (Word üretmez); bu yüzden dış varlık açığı da yoktur.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1] ?? root;
    const [, raw, cdata, close, open, rawAttrs, selfClose, text] = m;
    if (open !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (rawAttrs ?? "").matchAll(ATTR)) {
        const key = a[1];
        if (key) attrs[key] = decodeEntities(a[2] ?? a[3] ?? "");
      }
      const node: XmlNode = { name: open, attrs, children: [] };
      top.children.push(node);
      if (!selfClose) stack.push(node);
    } else if (close !== undefined) {
      const at = stack.findLastIndex((n) => n.name === close);
      if (at > 0) stack.length = at;
    } else if (text !== undefined) {
      top.children.push(decodeEntities(text));
    } else if (cdata !== undefined) {
      top.children.push(cdata);
    } else if (raw !== undefined) {
      top.children.push({ raw });
    }
  }
  return root;
}

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

export function serializeXml(node: XmlNode): string {
  const out: string[] = [];
  const visit = (n: XmlChild) => {
    if (typeof n === "string") {
      out.push(escapeText(n));
      return;
    }
    if ("raw" in n) {
      out.push(n.raw);
      return;
    }
    if (n.name === "#root") {
      for (const c of n.children) visit(c);
      return;
    }
    let tag = `<${n.name}`;
    for (const [k, v] of Object.entries(n.attrs)) tag += ` ${k}="${escapeAttr(v)}"`;
    if (n.children.length === 0) {
      out.push(`${tag}/>`);
      return;
    }
    out.push(`${tag}>`);
    for (const c of n.children) visit(c);
    out.push(`</${n.name}>`);
  };
  visit(node);
  return out.join("");
}

// ─── Gezinme yardımcıları ───────────────────────────────────────────────────────────────────────

export const isElement = (c: XmlChild): c is XmlNode => typeof c !== "string" && !("raw" in c);

export const elements = (node: XmlNode) => node.children.filter(isElement);

export const child = (node: XmlNode | undefined, name: string) =>
  node ? elements(node).find((c) => c.name === name) : undefined;

export const findDeep = (node: XmlNode, name: string): XmlNode | undefined => {
  for (const c of elements(node)) {
    if (c.name === name) return c;
    const hit = findDeep(c, name);
    if (hit) return hit;
  }
  return undefined;
};

/** Adı eşleşen düğümler; eşleşenin içine inilmez (iç içe metin kutusu iki kez sayılmasın). */
export const findAll = (node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] => {
  for (const c of elements(node)) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
};

export const textOf = (node: XmlNode) =>
  node.children.filter((c): c is string => typeof c === "string").join("");

export const el = (
  name: string,
  attrs: Record<string, string> = {},
  children: XmlChild[] = [],
): XmlNode => ({ name, attrs, children });

/** Derin kopya: bölünen run'ın biçimi (rPr) iki parçaya ayrı nesne olarak gider. */
export function cloneNode(node: XmlNode): XmlNode {
  return {
    name: node.name,
    attrs: { ...node.attrs },
    children: node.children.map((c) =>
      typeof c === "string" ? c : "raw" in c ? { raw: c.raw } : cloneNode(c),
    ),
  };
}

/** Paket içi göreli hedefi (`../media/a.png`, `/word/x.xml`) kaynak parçaya göre çözer. */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

/** `word/document.xml` → `word/_rels/document.xml.rels` */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
