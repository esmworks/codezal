/**
 * Hafif markdown ayrıştırıcı. Tam bir kütüphane bağımlılığı onay istediği için burada
 * sohbet yanıtlarında sık görülen alt küme desteklenir: paragraf, başlık (1-4), kod bloğu,
 * madde/numaralı/iç içe liste, görev kutusu, tablo, alıntı, yatay çizgi; satır içinde kod,
 * kalın, eğik, üstü çizili ve bağlantı. Word önizlemesi için CriticMarkup da tanınır: izli ekleme
 * `{++ ++}`, izli silme `{-- --}`, yorum `{==metin==}{>>yorum<<}` (okuyucu `docx.ts` böyle yazar).
 * Ağaç saf veridir; React tarafı yalnızca çizer.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "ins"; children: Inline[] }
  | { kind: "removed"; children: Inline[] }
  | { kind: "comment"; note: string; children: Inline[] }
  | { kind: "br" };

export type Align = "left" | "center" | "right";

export interface ListItem {
  content: Inline[];
  /** `- [ ]` / `- [x]` görev kutusu; yoksa undefined. */
  checked?: boolean;
  children: Block[];
}

export type Block =
  | { kind: "p"; children: Inline[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; children: Block[] }
  | { kind: "hr" };

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*```\s*([\w+#.-]*)\s*$/;

// Satır içi belirteçler: sıra önemli; kod her şeyden önce gelir ki `**` kodun içinde kalsın.
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(.+?)\*\*|~~(.+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_]+?)(?<!\s)_(?![\w_])|(https?:\/\/[^\s<>)]+[^\s<>).,;:!?'"])|\{\+\+([\s\S]+?)\+\+\}|\{--([\s\S]+?)--\}|\{==([\s\S]*?)==\}(?:\{>>([\s\S]*?)<<\})?|\{>>([\s\S]*?)<<\}/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => {
    if (t) out.push({ kind: "text", text: t });
  };
  // Kalın/eğik içi için özyinelemeli çağrı yapılır; paylaşılan global regex lastIndex'i bozar.
  const re = new RegExp(INLINE_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push({ kind: "code", text: m[2].trim() });
    else if (m[3] !== undefined) out.push({ kind: "bold", children: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ kind: "del", children: parseInline(m[4]) });
    else if (m[5] !== undefined && m[6] !== undefined)
      out.push({ kind: "link", href: m[6], children: parseInline(m[5]) });
    else if (m[7] !== undefined) out.push({ kind: "em", children: parseInline(m[7]) });
    else if (m[8] !== undefined) out.push({ kind: "em", children: parseInline(m[8]) });
    else if (m[9] !== undefined)
      out.push({ kind: "link", href: m[9], children: [{ kind: "text", text: m[9] }] });
    else if (m[10] !== undefined) out.push({ kind: "ins", children: parseInline(m[10]) });
    else if (m[11] !== undefined) out.push({ kind: "removed", children: parseInline(m[11]) });
    else if (m[12] !== undefined)
      out.push({ kind: "comment", note: m[13] ?? "", children: parseInline(m[12]) });
    else if (m[14] !== undefined) out.push({ kind: "comment", note: m[14], children: [] });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  push(text.slice(last));
  return out;
}

/** Paragraf satırları: sondaki iki boşluk ya da `\` sert kırılım, aksi hâlde boşlukla birleşir. */
function joinParagraph(lines: readonly string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((raw, i) => {
    const hard = /( {2,}|\\)$/.test(raw);
    const line = raw.replace(/( {2,}|\\)$/, "").trim();
    out.push(...parseInline(line));
    if (i < lines.length - 1) out.push(hard ? { kind: "br" } : { kind: "text", text: " " });
  });
  return out;
}

function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  // Kenar boruları boş hücre bırakır; onları at.
  if (cells.length && (cells[0] ?? "").trim() === "") cells.shift();
  if (cells.length && (cells[cells.length - 1] ?? "").trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function parseAlign(sep: string): Align[] {
  return splitCells(sep).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}

function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    /^\s{0,3}#{1,4}\s/.test(line) ||
    LIST_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s*>/.test(line)
  );
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? "").length;
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++;
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: buf.join("\n") });
      continue;
    }

    const h = /^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1]?.length ?? 1) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "h", level, children: parseInline(h[2] ?? "") });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", children: parseBlocks(buf) });
      continue;
    }

    if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      const head = splitCells(line).map(parseInline);
      const align = parseAlign(lines[i + 1] ?? "");
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        const cells = splitCells(lines[i] ?? "").map(parseInline);
        // Eksik hücreleri doldur ki tablo düzgün hizalansın.
        while (cells.length < head.length) cells.push([]);
        rows.push(cells.slice(0, head.length));
        i++;
      }
      blocks.push({ kind: "table", align, head, rows });
      continue;
    }

    const li = LIST_RE.exec(line);
    if (li) {
      const base = indentOf(line);
      const ordered = /\d/.test(li[2] ?? "");
      const start = ordered ? Number.parseInt(li[2] ?? "1", 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const m = LIST_RE.exec(cur);
        if (!m || indentOf(cur) !== base || /\d/.test(m[2] ?? "") !== ordered) break;
        const marker = (m[1] ?? "").length + (m[2] ?? "").length + 1;
        let first = m[3] ?? "";
        let checked: boolean | undefined;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
        if (task) {
          checked = task[1] !== " ";
          first = task[2] ?? "";
        }
        i++;
        // Daha içerideki satırlar (alt liste, devam paragrafı) bu maddeye aittir.
        const inner: string[] = [];
        while (i < lines.length) {
          const next = lines[i] ?? "";
          if (next.trim() === "") {
            // Boş satırdan sonra hâlâ girintili içerik geliyorsa madde devam eder.
            const after = lines[i + 1] ?? "";
            if (after.trim() !== "" && indentOf(after) > base) {
              inner.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) > base) {
            inner.push(next.slice(Math.min(marker, indentOf(next))));
            i++;
            continue;
          }
          // Girintisiz devam satırı: yeni blok değilse maddeye ekle (lazy continuation).
          if (!isBlockStart(next) && !next.includes("|")) {
            first += ` ${next.trim()}`;
            i++;
            continue;
          }
          break;
        }
        const children = parseBlocks(inner);
        // İlk alt blok paragrafsa madde metnine katılır; liste maddeleri tek satır görünsün.
        let content = parseInline(first);
        if (children[0]?.kind === "p") {
          content = [...content, { kind: "text", text: " " }, ...children[0].children];
          children.shift();
        }
        const item: ListItem = { content, children };
        if (checked !== undefined) item.checked = checked;
        items.push(item);
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || isBlockStart(next)) break;
      if (next.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) break;
      para.push(next);
      i++;
    }
    blocks.push({ kind: "p", children: joinParagraph(para) });
  }
  return blocks;
}

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
        case "code":
          return n.text;
        case "br":
          return "\n";
        case "removed":
          return "";
        default:
          return inlineText(n.children);
      }
    })
    .join("");
}

/**
 * Blokların düz metni (işaretsiz): alıntıdaki kopyala düğmesi bunu panoya yazar. Tweet ya da
 * e-posta taslağı gibi yapıştırılacak metinde `**` ve `>` işaretleri kalmasın. Paragraflar
 * boş satırla, liste maddeleri tek satırla ayrılır; kod bloğu olduğu gibi, tablo ve çizgi atlanır.
 */
export function blocksText(blocks: readonly Block[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "p":
        case "h":
          return inlineText(b.children);
        case "code":
          return b.text;
        case "quote":
          return blocksText(b.children);
        case "list":
          return b.items
            .map((it, j) => {
              const marker = b.ordered ? `${b.start + j}.` : "-";
              const nested = it.children.length ? `\n${blocksText(it.children)}` : "";
              return `${marker} ${inlineText(it.content)}${nested}`;
            })
            .join("\n");
        default:
          return "";
      }
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
}
