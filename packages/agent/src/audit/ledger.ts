import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { AuditProfile, CoverageLedger, CoverageUnit } from "@codezal/contracts";

/**
 * Deterministik kapsam defteri (coverage ledger). Birimler `saldırı sınıfı × kapsam`dır; kapsam
 * profille kabalaşır (`quick`: yalnız sınıf, `standard`: yüzey, `deep`: yüzey + alt dizin).
 * Kimlikler dosya listesinden ve profilden türetilir; aynı depo + profil her run'da aynı
 * birimleri üretir, böylece run'lar arası kapsam devralınabilir.
 */

export const AUDIT_PACKS = [
  "core",
  "desktop-local-ipc",
  "ai-and-llm",
  "supply-chain",
  "client-side",
  "web-protocol-and-auth",
  "protocols-rpc-and-messaging",
  "cloud-and-deployment",
  "resource-exhaustion",
  "data-isolation",
  "memory-safety-and-binary",
] as const;
export type AuditPack = (typeof AUDIT_PACKS)[number];

/** Saldırı sınıfı paketi → skill companion dosyası (assets/audit altında). */
export const PACK_FILES: Record<AuditPack, string> = {
  core: "ATTACK-CLASSES.md",
  "desktop-local-ipc": "DESKTOP-MOBILE-AND-LOCAL-IPC.md",
  "ai-and-llm": "AI-AND-LLM.md",
  "supply-chain": "SUPPLY-CHAIN-AND-RELEASE.md",
  "client-side": "CLIENT-SIDE.md",
  "web-protocol-and-auth": "WEB-PROTOCOL-AND-AUTH.md",
  "protocols-rpc-and-messaging": "PROTOCOLS-RPC-AND-MESSAGING.md",
  "cloud-and-deployment": "CLOUD-AND-DEPLOYMENT.md",
  "resource-exhaustion": "RESOURCE-EXHAUSTION-AND-AVAILABILITY.md",
  "data-isolation": "DATA-ISOLATION-AND-LIFECYCLE.md",
  "memory-safety-and-binary": "MEMORY-SAFETY-AND-BINARY.md",
};

export const MAX_FILES = 4000;
const MAX_DEPTH = 8;

const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|rs|c|h|cc|cpp|cxx|hpp|go|py|sh|bash|ps1|html|css|scss|sql|graphql|gql|proto|plist|lock|tf)$/i;
const CODE_NAME =
  /^(Dockerfile|Makefile|Procfile|CMakeLists\.txt|pnpm-workspace\.yaml|electron-builder\.ya?ml)$/;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".pnpm-store",
]);

/** Uzantı ya da ad, güvenlik açısından anlamlı bir dosya mı? Görseller ve dokümanlar dışarıda. */
export function isAuditableFile(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return CODE_EXT.test(base) || CODE_NAME.test(base);
}

function isIgnored(file: string): boolean {
  const segments = file.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRS.has(segments[i] ?? "")) return true;
  }
  return false;
}

function normalize(file: string): string {
  return file.split(sep).join("/");
}

/** Git varsa `git ls-files`, yoksa sınırlı dizin yürüyüşü. İkisi de deterministik sıralıdır. */
export function listSourceFiles(cwd: string): string[] {
  const git = spawnSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  if (git.status === 0 && typeof git.stdout === "string" && git.stdout.includes("\0")) {
    return git.stdout
      .split("\0")
      .filter((f) => f.length > 0)
      .map(normalize)
      .filter((f) => !isIgnored(f) && isAuditableFile(f))
      .sort()
      .slice(0, MAX_FILES);
  }
  return walk(cwd).slice(0, MAX_FILES);
}

/**
 * Kaynak listesi kırpıldı mı? `MAX_FILES` üstünde dosya varsa defter, kaynak damgası ve rapor
 * yalnız ilk `MAX_FILES` dosyadan türer; bu bilinmeden koşu "tam kapsama" diye kapanır ve
 * kırpılan dosyalar hiç denetlenmemiş olur. Çağıran bunu deftere not düşer.
 */
export function isFileListTruncated(cwd: string): boolean {
  const git = spawnSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  if (git.status !== 0 || typeof git.stdout !== "string" || !git.stdout.includes("\0")) {
    return walk(cwd).length > MAX_FILES;
  }
  const auditable = git.stdout
    .split("\0")
    .filter((f) => f.length > 0)
    .map(normalize)
    .filter((f) => !isIgnored(f) && isAuditableFile(f));
  return auditable.length > MAX_FILES;
}

function walk(root: string): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, current.dir), { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = current.dir ? `${current.dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (current.depth >= MAX_DEPTH || IGNORED_DIRS.has(entry.name)) continue;
        queue.push({ dir: rel, depth: current.depth + 1 });
      } else if (entry.isFile() && isAuditableFile(rel) && !isIgnored(rel)) {
        found.push(rel);
      }
    }
  }
  return found.sort();
}

function gitOut(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
}

/**
 * Kaynak sürümü: git HEAD (+ kirli çalışma ağacı **içeriğinin** özeti) ya da git yoksa dosya
 * boyut/mtime özeti. Birimlerin `covered` durumu bu değer değişince düşer.
 *
 * Kirli ağaçta yalnız `+dirty` yazılıyordu; iki farklı kirli hâl aynı damgayı aldığı için
 * kaynak değişse de önceki koşunun "covered" birimleri devralınıyor ve rapor, hiç denetlenmemiş
 * kodu kapsanmış sayıyordu. Artık kirli fark (`git diff HEAD` + izlenmeyen dosya listesi)
 * damgaya girer: içerik değişince damga değişir, kapsam düşer.
 */
export function computeSourceRef(cwd: string, files: string[]): string {
  const head = gitOut(cwd, ["rev-parse", "HEAD"]);
  if (head && head.trim().length > 0) {
    const status = gitOut(cwd, ["status", "--porcelain"]);
    if (!status || status.trim().length === 0) return head.trim();
    const diff = gitOut(cwd, ["diff", "HEAD"]) ?? "";
    const untracked = (gitOut(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "")
      .split("\n")
      .filter((f) => f.length > 0);
    const hash = createHash("sha1").update(status).update("\0").update(diff).update("\0");
    // İzlenmeyen dosyaların **içeriği** de girer: yalnız ad listesi damgaya katılsaydı, yeni bir
    // dosyanın içeriği değiştiğinde damga sabit kalır ve önceki koşunun "covered" birimleri
    // değişmiş kod için devralınırdı.
    for (const file of untracked.sort()) {
      try {
        const stat = statSync(join(cwd, file));
        hash.update(`${file}:${stat.size}:${stat.mtimeMs}\n`);
      } catch {
        hash.update(`${file}:missing\n`);
      }
    }
    const dirty = hash.digest("hex").slice(0, 12);
    return `${head.trim()}+dirty:${dirty}`;
  }
  const hash = createHash("sha1");
  for (const file of [...files].sort()) {
    try {
      const stat = statSync(join(cwd, file));
      hash.update(`${file}:${stat.size}:${stat.mtimeMs}\n`);
    } catch {
      hash.update(`${file}:missing\n`);
    }
  }
  return `nogit:${hash.digest("hex").slice(0, 12)}`;
}

/** Yüzey: kod tabanının denetlenebilir ana bölümü (main, preload, renderer, agent, ci…). */
export function surfaceOf(file: string): string {
  const segments = file.split("/");
  if (file.startsWith("apps/desktop/src/main")) return "main";
  if (file.startsWith("apps/desktop/src/preload")) return "preload";
  if (file.startsWith("apps/desktop/src/renderer")) return "renderer";
  if (file.startsWith("packages/agent")) return "agent";
  if (file.startsWith("packages/")) return `pkg:${segments[1] ?? "?"}`;
  if (file.startsWith("apps/")) return `app:${segments[1] ?? "?"}`;
  if (file.startsWith(".github/")) return "ci";
  if (file.startsWith("scripts/")) return "scripts";
  if (file.startsWith("build/")) return "build";
  if (file.startsWith("docs/") || file.startsWith("design/")) return "docs";
  // Kök dosyalar tek başına yüzey olmaz (package.json, .gitignore…); "root" altında toplanır.
  return segments.length > 1 ? (segments[0] ?? "root") : "root";
}

interface PackRule {
  pack: AuditPack;
  test: (file: string) => boolean;
}

/** Sıra önemli değildir: bir dosya birden çok mercek altına girebilir (en çok üç). */
const PACK_RULES: PackRule[] = [
  {
    pack: "supply-chain",
    test: (f) =>
      /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml)$/.test(
        f,
      ) ||
      f.startsWith(".github/") ||
      f.startsWith("scripts/") ||
      /(^|\/)(electron-builder\.ya?ml|Makefile|Dockerfile|docker-compose\.ya?ml)$/.test(f),
  },
  {
    pack: "cloud-and-deployment",
    test: (f) =>
      /\.tf$/.test(f) ||
      /(^|\/)(Dockerfile|docker-compose\.ya?ml|serverless\.ya?ml|Procfile|Chart\.yaml)$/.test(f) ||
      /(^|\/)(k8s|kubernetes|helm|charts|terraform|ansible|cloudformation)\//.test(f),
  },
  {
    pack: "memory-safety-and-binary",
    test: (f) =>
      /\.(c|h|cc|cpp|cxx|hpp|rs|asm|s)$/.test(f) || /(^|\/)(CMakeLists\.txt|build\.rs)$/.test(f),
  },
  {
    pack: "desktop-local-ipc",
    test: (f) =>
      f.startsWith("apps/desktop/src/main") ||
      f.startsWith("apps/desktop/src/preload") ||
      /\.plist$/.test(f) ||
      /(^|\/)(tauri\.conf|src-tauri)\b/.test(f) ||
      /(^|\/)(terminal|tray|deeplink|deep-link|webview)[a-z-]*\.(ts|tsx|js)$/.test(f),
  },
  {
    pack: "ai-and-llm",
    test: (f) =>
      f.startsWith("packages/agent") ||
      /(^|\/)(prompt|prompts|skill|skills|mcp|agent|llm|tool|tools|embedding|vector)[a-z-]*\.(ts|tsx|js|json|md)$/.test(
        f,
      ),
  },
  {
    pack: "client-side",
    test: (f) =>
      f.startsWith("apps/desktop/src/renderer") ||
      /\.(html|css|scss)$/.test(f) ||
      /(^|\/)(components?|dom|ui)\//.test(f),
  },
  {
    pack: "web-protocol-and-auth",
    test: (f) =>
      /\.(graphql|gql)$/.test(f) ||
      /(^|\/)(server|routes?|controllers?|middleware|handlers?|api|auth)\//.test(f) ||
      /(^|\/)(http|express|fastify|hono)[a-z-]*\.(ts|js|mjs)$/.test(f),
  },
  {
    pack: "protocols-rpc-and-messaging",
    test: (f) =>
      /\.proto$/.test(f) ||
      /(^|\/)(grpc|kafka|rabbit|amqp|nats|mqtt|webhooks?|queues?|consumers?|streams?)\//.test(f),
  },
  {
    pack: "data-isolation",
    test: (f) =>
      /(^|\/)(tenant|org|organization|workspace|migrations?|backup|restore|export|gdpr)[a-z-]*\//.test(
        f,
      ) || /(^|\/)(migrations?|backup|restore)\//.test(f),
  },
  {
    pack: "resource-exhaustion",
    test: (f) =>
      /(^|\/)(limit|limits|rate[-_]?limit|quota|budget|throttle|retry|cooldown|cache|queue|worker|scheduler)[a-z-]*\.(ts|tsx|js|mjs)$/.test(
        f,
      ),
  },
];

/** Dosyanın denetim mercekleri; hiçbiri uymazsa `core`. */
export function packsFor(file: string): AuditPack[] {
  const matched = PACK_RULES.filter((rule) => rule.test(file)).map((rule) => rule.pack);
  return matched.length > 0 ? matched.slice(0, 3) : ["core"];
}

/** Depoda hangi saldırı sınıfı paketleri var (deterministik sıralı). */
export function selectPacks(files: string[]): AuditPack[] {
  const found = new Set<AuditPack>();
  for (const file of files) for (const pack of packsFor(file)) found.add(pack);
  return AUDIT_PACKS.filter((pack) => found.has(pack));
}

type Granularity = "pack" | "surface" | "deep";

function granularityOf(profile: AuditProfile): Granularity {
  if (profile === "quick") return "pack";
  if (profile === "deep") return "deep";
  return "surface";
}

function scopeOf(file: string, granularity: Granularity): string {
  const surface = surfaceOf(file);
  if (granularity === "pack") return "all";
  if (granularity === "surface") return surface;
  // deep: yüzey + ilk alt dizin (main/ipc, renderer/session…)
  const parts = file.split("/");
  const surfaceRoot = parts.findIndex(
    (_part, i) => surfaceOf(parts.slice(0, i + 1).join("/")) === surface,
  );
  const next = parts[surfaceRoot + 1];
  return next ? `${surface}/${next}` : surface;
}

function unitId(granularity: Granularity, pack: AuditPack, scope: string): string {
  const hash = createHash("sha1").update(`${granularity}|${pack}|${scope}`).digest("hex");
  return `u-${hash.slice(0, 8)}`;
}

/** Kapsam yollarına göre dosya süzgeci; boş liste tüm depodur. */
export function filterByScope(files: string[], scopePaths: string[]): string[] {
  if (scopePaths.length === 0) return files;
  const prefixes = scopePaths.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, ""));
  return files.filter((file) => prefixes.some((p) => file === p || file.startsWith(`${p}/`)));
}

export interface BuildLedgerInput {
  sourceRef: string;
  profile: AuditProfile;
  files: string[];
  /** Önceki run'ın defteri: aynı kaynak sürümündeki `covered` birimler devralınır. */
  previous?: CoverageLedger | null;
  now?: number;
}

export interface LedgerSeed {
  ledger: CoverageLedger;
  packs: AuditPack[];
}

/** Deterministik birim üretimi + önceki run'ın devralınması. */
export function buildLedger(input: BuildLedgerInput): LedgerSeed {
  const granularity = granularityOf(input.profile);
  const groups = new Map<string, { pack: AuditPack; scope: string; paths: string[] }>();
  for (const file of [...input.files].sort()) {
    for (const pack of packsFor(file)) {
      const scope = scopeOf(file, granularity);
      const key = `${pack}|${scope}`;
      const group = groups.get(key) ?? { pack, scope, paths: [] };
      group.paths.push(file);
      groups.set(key, group);
    }
  }

  const previousById = new Map<string, CoverageUnit>();
  for (const unit of input.previous?.units ?? []) previousById.set(unit.id, unit);

  const units: CoverageUnit[] = [...groups.values()]
    .sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : a.scope < b.scope ? -1 : 1))
    .map((group) => {
      const id = unitId(granularity, group.pack, group.scope);
      const prior = previousById.get(id);
      const base: CoverageUnit = {
        id,
        surface: group.scope,
        attackClass: group.pack,
        scopePaths: group.paths.sort(),
        status: "planned",
        sourceRef: input.sourceRef,
        fingerprint: null,
        foundBy: null,
        verifiedBy: null,
      };
      if (!prior) return base;
      if (prior.status === "covered" && prior.sourceRef === input.sourceRef) {
        // Kaynak değişmedi: kanıt hâlâ geçerli, yeniden doğrulamaya gerek yok.
        return {
          ...base,
          status: "covered",
          fingerprint: prior.fingerprint,
          foundBy: prior.foundBy,
          verifiedBy: prior.verifiedBy,
        };
      }
      if (prior.status === "covered" || prior.status === "candidate") {
        // Kaynak değişti ya da doğrulama yarım kaldı: yeniden ele alınır.
        return { ...base, status: "planned", note: "kaynak sürümü değişti; yeniden denetlenir" };
      }
      if (prior.status === "out_of_scope")
        return { ...base, status: "out_of_scope", note: prior.note };
      if (prior.status === "rejected" && prior.sourceRef === input.sourceRef) {
        // Aynı kaynakta çürütülen iddia yeniden avlanmaz (kapsam görünür kalır).
        return { ...base, status: "rejected", fingerprint: prior.fingerprint, note: prior.note };
      }
      return { ...base, note: prior.note ?? "önceki run'dan devralındı" };
    });

  return {
    ledger: {
      version: 1,
      repo: "",
      sourceRef: input.sourceRef,
      updatedAt: input.now ?? Date.now(),
      units,
    },
    packs: selectPacks(input.files),
  };
}

/** Sıradaki işler: `planned` birimler sırayla; `candidate` olanlar yarım kalmış doğrulamadır. */
export function nextUnits(ledger: CoverageLedger, limit: number): CoverageUnit[] {
  return ledger.units.filter((u) => u.status === "planned").slice(0, limit);
}

export function unitById(ledger: CoverageLedger, id: string): CoverageUnit | undefined {
  return ledger.units.find((u) => u.id === id);
}
