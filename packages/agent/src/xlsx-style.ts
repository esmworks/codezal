import { child, cloneNode, el, elements, parseXml, serializeXml, type XmlNode } from "./ooxml.js";
import { builtinFormat } from "./xlsx.js";

/**
 * `styles.xml` üzerinde hücre stili türetme: üretim (`xlsx-build.ts`) boş şablondan, düzenleme
 * (`xlsx-edit.ts`) kitabın kendi stil sayfasından başlar. Stil hücreye `s` (cellXfs sırası) ile
 * bağlıdır; bir hücrenin biçimini değiştirmek o stili değil, onun değiştirilmiş kopyasını ekleyip
 * hücreyi ona bağlamaktır (aynı stili paylaşan diğer hücreler etkilenmesin). Aynı kopya ikinci kez
 * istenirse var olan döner: yazı, dolgu, kenarlık ve xf XML metniyle tekilleştirilir.
 */

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

/** `styleSheet` çocuklarının şemadaki sırası: yeni liste doğru yere girsin. */
const ORDER = [
  "numFmts",
  "fonts",
  "fills",
  "borders",
  "cellStyleXfs",
  "cellXfs",
  "cellStyles",
  "dxfs",
  "tableStyles",
  "colors",
  "extLst",
];

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "center" | "bottom";

export interface StyleChange {
  /** Excel sayı biçimi kodu (`#,##0.00`, `0%`, `dd.mm.yyyy`). */
  numFmt?: string;
  bold?: boolean;
  italic?: boolean;
  /** Yazı rengi, `RRGGBB`. */
  color?: string;
  /** Dolgu rengi `RRGGBB`; `null` dolguyu kaldırır. */
  fill?: string | null;
  align?: HAlign;
  valign?: VAlign;
  wrap?: boolean;
  /** `all` dört kenar ince çizgi, `bottom` yalnız alt, `none` kenarlıksız. */
  border?: "all" | "bottom" | "none";
  size?: number;
}

/** `#1f4e79` / `1F4E79` → `FF1F4E79`; geçersizse `undefined`. */
export function argb(color: string): string | undefined {
  const hex = color.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `FF${hex.toUpperCase()}` : undefined;
}

export class StyleSheet {
  readonly root: XmlNode;
  readonly #sheet: XmlNode;
  /** Yeni stil ya da biçim eklendi mi (düzenlemede `styles.xml` yalnız o zaman yeniden yazılır). */
  changed = false;

  constructor(xml?: string) {
    this.root = parseXml(xml ?? TEMPLATE);
    const sheet = child(this.root, "styleSheet");
    if (!sheet) throw new Error("styles.xml: styleSheet yok");
    this.#sheet = sheet;
  }

  toXml(): string {
    for (const name of ["numFmts", "fonts", "fills", "borders", "cellXfs"]) {
      const list = child(this.#sheet, name);
      if (list) list.attrs.count = String(elements(list).length);
    }
    return serializeXml(this.root);
  }

  #list(name: string): XmlNode {
    const found = child(this.#sheet, name);
    if (found) return found;
    const node = el(name, { count: "0" });
    const rank = ORDER.indexOf(name);
    const at = this.#sheet.children.findIndex(
      (c) => typeof c !== "string" && "name" in c && ORDER.indexOf(c.name) > rank,
    );
    if (at < 0) this.#sheet.children.push(node);
    else this.#sheet.children.splice(at, 0, node);
    return node;
  }

  /** Aynı XML'e sahip öğe varsa sırası, yoksa eklenip sırası. */
  #intern(listName: string, node: XmlNode): number {
    const list = this.#list(listName);
    const items = elements(list);
    const key = serializeXml(node);
    const at = items.findIndex((i) => serializeXml(i) === key);
    if (at >= 0) return at;
    list.children.push(node);
    this.changed = true;
    return items.length;
  }

  xfCount(): number {
    return elements(this.#list("cellXfs")).length;
  }

  #xf(index: number): XmlNode {
    const xfs = elements(this.#list("cellXfs"));
    return (
      xfs[index] ?? xfs[0] ?? el("xf", { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0" })
    );
  }

  /** Stilin sayı biçimi kodu. */
  formatOf(index: number): string {
    const id = Number(this.#xf(index).attrs.numFmtId ?? 0);
    const custom = elements(child(this.#sheet, "numFmts") ?? el("numFmts")).find(
      (f) => Number(f.attrs.numFmtId) === id,
    );
    return custom?.attrs.formatCode ?? builtinFormat(id);
  }

  /** Biçim kodunun kimliği: yerleşik ya da var olan özel biçim, yoksa yeni özel biçim (164+). */
  numFmtId(code: string): number {
    const builtin: Record<string, number> = {
      General: 0,
      "0": 1,
      "0.00": 2,
      "#,##0": 3,
      "#,##0.00": 4,
      "0%": 9,
      "0.00%": 10,
      "0.00E+00": 11,
      "h:mm": 20,
      "h:mm:ss": 21,
      "@": 49,
    };
    const known = builtin[code];
    if (known !== undefined) return known;
    const list = this.#list("numFmts");
    const items = elements(list);
    const same = items.find((f) => f.attrs.formatCode === code);
    if (same) return Number(same.attrs.numFmtId);
    const id = Math.max(163, ...items.map((f) => Number(f.attrs.numFmtId) || 0)) + 1;
    list.children.push(el("numFmt", { numFmtId: String(id), formatCode: code }));
    this.changed = true;
    return id;
  }

  /**
   * `base` stilinin `change` uygulanmış kopyası (değişiklik yoksa `base`). Yazı, dolgu ve kenarlık
   * da kopyalanarak türetilir; tabanın diğer özellikleri (yazı tipi, boyut, koruma) korunur.
   */
  derive(base: number, change: StyleChange): number {
    const xf = cloneNode(this.#xf(base));
    if (change.numFmt !== undefined) {
      xf.attrs.numFmtId = String(this.numFmtId(change.numFmt));
      xf.attrs.applyNumberFormat = "1";
    }
    if (
      change.bold !== undefined ||
      change.italic !== undefined ||
      change.color !== undefined ||
      change.size !== undefined
    ) {
      const fonts = elements(this.#list("fonts"));
      const font = cloneNode(fonts[Number(xf.attrs.fontId ?? 0)] ?? fonts[0] ?? el("font"));
      const toggle = (name: string, on: boolean | undefined) => {
        if (on === undefined) return;
        font.children = font.children.filter(
          (c) => typeof c === "string" || !("name" in c) || c.name !== name,
        );
        if (on) font.children.unshift(el(name));
      };
      toggle("b", change.bold);
      toggle("i", change.italic);
      const setVal = (name: string, attrs: Record<string, string>) => {
        const at = font.children.findIndex(
          (c) => typeof c !== "string" && "name" in c && c.name === name,
        );
        if (at >= 0) font.children[at] = el(name, attrs);
        else font.children.push(el(name, attrs));
      };
      if (change.size !== undefined) setVal("sz", { val: String(change.size) });
      const rgb = change.color !== undefined ? argb(change.color) : undefined;
      if (rgb) setVal("color", { rgb });
      xf.attrs.fontId = String(this.#intern("fonts", font));
      xf.attrs.applyFont = "1";
    }
    if (change.fill !== undefined) {
      const rgb = change.fill === null ? undefined : argb(change.fill);
      const fill = rgb
        ? el("fill", {}, [
            el("patternFill", { patternType: "solid" }, [
              el("fgColor", { rgb }),
              el("bgColor", { indexed: "64" }),
            ]),
          ])
        : el("fill", {}, [el("patternFill", { patternType: "none" })]);
      xf.attrs.fillId = String(this.#intern("fills", fill));
      xf.attrs.applyFill = "1";
    }
    if (change.border !== undefined) {
      const side = (name: string, on: boolean) =>
        on ? el(name, { style: "thin" }, [el("color", { indexed: "64" })]) : el(name);
      const all = change.border === "all";
      const border = el("border", {}, [
        side("left", all),
        side("right", all),
        side("top", all),
        side("bottom", all || change.border === "bottom"),
        el("diagonal"),
      ]);
      xf.attrs.borderId = String(this.#intern("borders", border));
      xf.attrs.applyBorder = "1";
    }
    if (change.align !== undefined || change.valign !== undefined || change.wrap !== undefined) {
      const at = xf.children.findIndex(
        (c) => typeof c !== "string" && "name" in c && c.name === "alignment",
      );
      const current = at >= 0 ? xf.children[at] : undefined;
      const align =
        current && typeof current !== "string" && "name" in current ? current : el("alignment");
      if (change.align !== undefined) align.attrs.horizontal = change.align;
      if (change.valign !== undefined) align.attrs.vertical = change.valign;
      if (change.wrap !== undefined) {
        if (change.wrap) align.attrs.wrapText = "1";
        else delete align.attrs.wrapText;
      }
      if (at < 0) xf.children.unshift(align);
      xf.attrs.applyAlignment = "1";
    }
    const key = serializeXml(xf);
    if (key === serializeXml(this.#xf(base))) return base;
    return this.#intern("cellXfs", xf);
  }
}

/** Formatın tarih/saat gösterip göstermediği (yazımda tarih hücresine uygun biçim seçmek için). */
export function isDateFormat(code: string): boolean {
  const cleaned = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/general/gi, "");
  return /[ydhs]/i.test(cleaned) || (/m/i.test(cleaned) && !/[0#?]/.test(cleaned));
}
