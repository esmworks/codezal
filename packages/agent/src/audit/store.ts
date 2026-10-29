import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AuditFinding,
  AuditFindingsDocument,
  type AuditRunMeta,
  AuditRunMeta as AuditRunMetaSchema,
  type CoverageLedger,
  CoverageLedger as CoverageLedgerSchema,
} from "@codezal/contracts";
import { type CandidateFile, CandidateFile as CandidateFileSchema } from "./candidates.js";

/**
 * Denetim run'larının disk deposu. Klasör düzeni skill'in beklediği adlarla birebir aynıdır
 * (`run-metadata.json`, `coverage-ledger.json`, `findings.json`, üç rapor Markdown'ı) ki
 * upstream doğrulayıcılar olduğu gibi koşabilsin. Yazan taraf uygulamadır, model değil (K2);
 * bu yüzden yazma atomiktir (tmp + rename).
 */

export const AUDIT_FILE = {
  meta: "run-metadata.json",
  ledger: "coverage-ledger.json",
  candidates: "candidates.json",
  findings: "findings.json",
  report: "REPORT.md",
  detail: "FINDINGS-DETAIL.md",
  needsValidation: "NEEDS-VALIDATION.md",
  pdf: "REPORT.pdf",
} as const;

export interface AuditRunPaths {
  dir: string;
  meta: string;
  ledger: string;
  candidates: string;
  findings: string;
  report: string;
  detail: string;
  needsValidation: string;
  pdf: string;
}

/** Repo anahtarı: okunur ad + yol özeti. Depo taşınırsa yeni bir geçmiş başlar (belgelenmiş sınır). */
export function repoKey(cwd: string): string {
  const slug =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo";
  return `${slug}-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
}

function readJson<T>(path: string, parse: (value: unknown) => T): T | null {
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2));
}

export class AuditStore {
  /** `userData/audits` kökü. */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  repoDir(cwd: string): string {
    return join(this.dir, repoKey(cwd));
  }

  paths(cwd: string, runId: string): AuditRunPaths {
    const dir = join(this.repoDir(cwd), runId);
    return {
      dir,
      meta: join(dir, AUDIT_FILE.meta),
      ledger: join(dir, AUDIT_FILE.ledger),
      candidates: join(dir, AUDIT_FILE.candidates),
      findings: join(dir, AUDIT_FILE.findings),
      report: join(dir, AUDIT_FILE.report),
      detail: join(dir, AUDIT_FILE.detail),
      needsValidation: join(dir, AUDIT_FILE.needsValidation),
      pdf: join(dir, AUDIT_FILE.pdf),
    };
  }

  /** Var olan run kimlikleri sayısal sırayla (`run-1`, `run-2`…). */
  listRuns(cwd: string): string[] {
    try {
      return readdirSync(this.repoDir(cwd))
        .filter((name) => /^run-\d+$/.test(name))
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    } catch {
      return [];
    }
  }

  /**
   * Sıradaki run klasörünü **rezerve ederek** döner.
   *
   * Eskiden yalnız listeye bakıp `max + 1` hesaplanıyordu: aynı depoda iki oturum (iki pencere ya
   * da koordinatör + kodlama) aynı anda denetim başlatırsa ikisi de `run-1` buluyor, ikinci
   * `persistAll` birincinin meta/defter/aday/bulgu dosyalarının üzerine yazıyordu. `mkdir`
   * atomiktir; klasör zaten varsa sıradaki numara denenir.
   */
  nextRunId(cwd: string): string {
    const used = this.listRuns(cwd).map((name) => Number(name.slice(4)));
    let n = used.length > 0 ? Math.max(...used) + 1 : 1;
    // Üst klasör önce kurulur: `mkdir` yalnız son parçayı yaratır ve klasör yokken ENOENT verir.
    mkdirSync(this.repoDir(cwd), { recursive: true });
    for (;;) {
      const id = `run-${n}`;
      try {
        mkdirSync(join(this.repoDir(cwd), id));
        return id;
      } catch (error) {
        // Yalnız "zaten var" yarışında sıradaki numara denenir; başka hata (izin, disk) sonsuz
        // döngü kurmasın diye yukarı bırakılır.
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        n += 1;
      }
    }
  }

  /**
   * Önceki run: aynı depo için kapsam devralmanın kaynağı.
   *
   * Yalnız **yazılmış** run'lar sayılır (`run-metadata.json` var). `nextRunId` klasörü önceden
   * rezerve ettiği için ham liste, henüz boş olan yeni run'ı da içerir; süzülmezse "önceki run"
   * kendisi olur ve devralma hiç çalışmazdı.
   */
  latestRunId(cwd: string, before?: string): string | null {
    const runs = this.listRuns(cwd).filter(
      (run) => run !== before && existsSync(this.paths(cwd, run).meta),
    );
    return runs.length > 0 ? (runs[runs.length - 1] ?? null) : null;
  }

  readMeta(cwd: string, runId: string): AuditRunMeta | null {
    return readJson(this.paths(cwd, runId).meta, (value) => AuditRunMetaSchema.parse(value));
  }

  writeMeta(cwd: string, runId: string, meta: AuditRunMeta): void {
    writeJsonAtomic(this.paths(cwd, runId).meta, meta);
  }

  readLedger(cwd: string, runId: string): CoverageLedger | null {
    return readJson(this.paths(cwd, runId).ledger, (value) => CoverageLedgerSchema.parse(value));
  }

  writeLedger(cwd: string, runId: string, ledger: CoverageLedger): void {
    writeJsonAtomic(this.paths(cwd, runId).ledger, ledger);
  }

  readCandidates(cwd: string, runId: string): CandidateFile {
    return (
      readJson(this.paths(cwd, runId).candidates, (value) => CandidateFileSchema.parse(value)) ?? {
        version: 1,
        updatedAt: 0,
        items: [],
      }
    );
  }

  writeCandidates(cwd: string, runId: string, file: CandidateFile): void {
    writeJsonAtomic(this.paths(cwd, runId).candidates, file);
  }

  readFindings(cwd: string, runId: string): AuditFinding[] {
    return (
      readJson(this.paths(cwd, runId).findings, (value) => AuditFindingsDocument.parse(value)) ?? []
    );
  }

  writeFindings(cwd: string, runId: string, findings: AuditFinding[]): void {
    writeJsonAtomic(this.paths(cwd, runId).findings, findings);
  }

  writeMarkdown(cwd: string, runId: string, name: string, text: string): void {
    writeTextAtomic(join(this.paths(cwd, runId).dir, name), text);
  }

  /** Panelin "rapor hazır" göstergesi: en az biri varsa run klasörü raporludur. */
  reportExists(cwd: string, runId: string): boolean {
    return existsSync(this.paths(cwd, runId).report);
  }
}
