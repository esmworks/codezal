import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MemoryDraft, MemoryEntry, MemoryScope, MemoryType } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";

/**
 * Dosya tabanlı bellek (Claude Code harness'inin modeli):
 * - Her bellek tek gerçek tutan bir markdown dosyasıdır; ön bilgide `name`, `description`, `type`.
 * - `MEMORY.md` dizindir: her satır `- [Başlık](dosya.md) — kanca`. Her oturumda sistem istemine
 *   girer; ajan gerekince dosyanın tamamını `read` ile okur, yenisini `write` ile yazar.
 * - Kapsamlar: genel (her oturum), proje (Kodlama çalışma klasörü), asistan projesi.
 */
const INDEX = "MEMORY.md";
const TYPES: readonly MemoryType[] = ["kullanici", "geribildirim", "proje", "kaynak"];

const TR_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

/**
 * Windows'ta dosya adı olarak kullanılamayan cihaz adları: uzantıdan bağımsız yasaktır
 * (`nul.md` de açılamaz). Sonuna "-" eklenerek kaçırılır.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * Türkçe karakterleri sadeleştirip kebab-case ASCII ad üretir. Ad boşalırsa `fallback` döner
 * (bellek dosyası adı boş olamaz; dal adı gibi başka parçalarla birleşen çağıran boş isteyebilir).
 */
export function slugify(text: string, max = 60, fallback = "bellek"): string {
  const lower = text.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, (ch) => TR_MAP[ch] ?? ch);
  const slug = lower
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  if (!slug) return fallback;
  return WINDOWS_RESERVED.test(slug) ? `${slug}-` : slug;
}

function parseType(raw: string | undefined): MemoryType {
  return TYPES.find((t) => t === raw) ?? "kullanici";
}

/** Ön bilgi (`---` blokları) + gövde ayrıştırır. Ön bilgi yoksa dosya adı ad, ilk satır açıklama olur. */
export function parseMemoryFile(file: string, text: string, updatedAt: number): MemoryEntry {
  const name = file.replace(/\.md$/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    const firstLine =
      text
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? name;
    return {
      name,
      description: firstLine.slice(0, 200),
      type: "kullanici",
      body: text.trim(),
      file,
      updatedAt,
    };
  }
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^\s*([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined) meta[kv[1]] = kv[2].trim();
  }
  return {
    name: meta.name?.trim() || name,
    description: meta.description ?? "",
    type: parseType(meta.type),
    body: (m[2] ?? "").trim(),
    file,
    updatedAt,
  };
}

export function renderMemoryFile(
  e: Pick<MemoryEntry, "name" | "description" | "type" | "body">,
): string {
  return `---\nname: ${e.name}\ndescription: ${e.description}\ntype: ${e.type}\n---\n\n${e.body.trim()}\n`;
}

export function renderIndex(entries: readonly MemoryEntry[]): string {
  const lines = entries.map((e) => `- [${e.name}](${e.file}) — ${e.description}`);
  return `${lines.join("\n")}\n`;
}

/** Kapsam türü → sözlük anahtarı. */
const SCOPE_KEY: Record<MemoryScope["kind"], "general" | "project" | "assistant"> = {
  genel: "general",
  proje: "project",
  asistan: "assistant",
};

export class MemoryStore {
  constructor(
    readonly root: string,
    readonly lang: Locale = "tr",
  ) {}

  /** Kapsam klasörü; proje yolu harness'teki gibi `/` → `-` ile düzleştirilir. */
  dirFor(scope: MemoryScope): string {
    if (scope.kind === "genel") return join(this.root, "genel");
    if (scope.kind === "proje")
      return join(this.root, "proje", scope.cwd.replace(/[^a-zA-Z0-9]+/g, "-"));
    return join(this.root, "asistan", scope.projectId);
  }

  ensure(scope: MemoryScope): string {
    const dir = this.dirFor(scope);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, INDEX))) writeFileSync(join(dir, INDEX), "");
    return dir;
  }

  list(scope: MemoryScope): MemoryEntry[] {
    const dir = this.dirFor(scope);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== INDEX)
      .map((f) => {
        const p = join(dir, f);
        return parseMemoryFile(f, readFileSync(p, "utf8"), statSync(p).mtimeMs);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  save(scope: MemoryScope, draft: MemoryDraft): MemoryEntry {
    const dir = this.ensure(scope);
    const name = slugify(draft.name?.trim() || draft.description);
    const file = `${name}.md`;
    const body = draft.body.trim() || draft.description.trim();
    writeFileSync(
      join(dir, file),
      renderMemoryFile({ name, description: draft.description.trim(), type: draft.type, body }),
    );
    this.rebuildIndex(scope);
    return {
      name,
      description: draft.description.trim(),
      type: draft.type,
      body,
      file,
      updatedAt: Date.now(),
    };
  }

  remove(scope: MemoryScope, name: string): void {
    const dir = this.dirFor(scope);
    const p = join(dir, `${slugify(name)}.md`);
    if (existsSync(p)) rmSync(p);
    this.rebuildIndex(scope);
  }

  /** Dizin dosyalardan yeniden üretilir; ajanın elle yazdığı satırlar da böylece tutarlı kalır. */
  rebuildIndex(scope: MemoryScope): void {
    const dir = this.ensure(scope);
    writeFileSync(join(dir, INDEX), renderIndex(this.list(scope)));
  }

  index(scope: MemoryScope): string {
    const p = join(this.dirFor(scope), INDEX);
    const text = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    return text || renderIndex(this.list(scope)).trim();
  }

  /** Sistem istemine giren bellek bloğu: kurallar + her kapsamın klasörü ve dizini. */
  systemPrompt(scopes: readonly MemoryScope[]): string {
    const d = dict(this.lang);
    const dirs = scopes.map((s) => this.ensure(s));
    const sections = scopes.map((s, i) => {
      const idx = this.index(s);
      const label = d.agent.scope[SCOPE_KEY[s.kind]];
      return `## ${label}\n${d.prompt.memoryFolder.replace("{{dir}}", dirs[i] ?? "")}\n${idx || d.prompt.memoryEmpty}`;
    });
    return [
      d.prompt.memoryTitle,
      d.prompt.memoryUse,
      d.prompt.memoryFormat,
      d.prompt.memoryExample,
      d.prompt.memoryTypes,
      d.prompt.memoryIndex,
      d.prompt.memoryUpdate,
      d.prompt.memoryVerify,
      ...sections,
    ].join("\n\n");
  }
}
