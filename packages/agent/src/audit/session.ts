import { existsSync } from "node:fs";
import type {
  AuditFinding,
  AuditPhase,
  AuditRunMeta,
  AuditStartOptions,
  AuditStatus,
  AuditUnitStatus,
  AuditView,
  CoverageLedger,
  CoverageUnit,
} from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { BudgetMeter, initialBudget } from "./budget.js";
import {
  type AuditCandidate,
  type CandidateFile,
  candidateFromHunter,
  type HunterCandidate,
  promoteCandidate,
  unparsedCandidate,
  type VerifierVerdict,
} from "./candidates.js";
import {
  type AuditPack,
  buildLedger,
  computeSourceRef,
  filterByScope,
  isFileListTruncated,
  listSourceFiles,
  MAX_FILES,
  nextUnits,
  PACK_FILES,
} from "./ledger.js";
import { fingerprintFor, sortFindings, toFindingView, validateFindings } from "./schema.js";
import type { AuditStore } from "./store.js";

export interface AuditSessionDeps {
  store: AuditStore;
  cwd: string;
  /** Görünen depo adı (raporlarda ve panelde). */
  repo: string;
  /** Skill paketinin kökü; yoksa avcılar paket dosyası okuyamaz (yine de çalışır). */
  assetsDir: string | null;
  /** Metin dili (kapsam notu için). */
  lang?: Locale;
}

export interface HuntAssignment {
  unitId: string;
  attackClass: string;
  scopePaths: string[];
  packPath: string | null;
}

const now = () => Date.now();

/**
 * Tek bir denetim run'ının canlı durumu: meta + kapsam defteri + adaylar + kayıtlar.
 * Yazma uygulamaya aittir (K2): her değişiklik `AuditStore` üzerinden diske iner; model
 * yalnızca araç argümanı verir, dosya içeriği üretmez.
 */
export class AuditSession {
  readonly store: AuditStore;
  readonly cwd: string;
  readonly repo: string;
  readonly assetsDir: string | null;
  readonly runId: string;

  #meta: AuditRunMeta;
  #ledger: CoverageLedger;
  #candidates: CandidateFile;
  #findings: AuditFinding[];
  #meter: BudgetMeter;

  private constructor(
    deps: AuditSessionDeps,
    runId: string,
    meta: AuditRunMeta,
    ledger: CoverageLedger,
    file: CandidateFile,
    findings: AuditFinding[],
  ) {
    this.store = deps.store;
    this.cwd = deps.cwd;
    this.repo = deps.repo;
    this.assetsDir = deps.assetsDir;
    this.runId = runId;
    this.#meta = meta;
    this.#ledger = ledger;
    this.#candidates = file;
    this.#findings = findings;
    this.#meter = new BudgetMeter(meta.budget, (budget) => {
      this.#meta = { ...this.#meta, budget };
      this.store.writeMeta(this.cwd, this.runId, this.#meta);
    });
  }

  /** Yeni run: kaynak taraması, deterministik defter ve önceki run'ın devralınması. */
  static start(deps: AuditSessionDeps, options: AuditStartOptions): AuditSession {
    const runId = deps.store.nextRunId(deps.cwd);
    const files = filterByScope(listSourceFiles(deps.cwd), options.scopePaths ?? []);
    const sourceRef = computeSourceRef(deps.cwd, files);
    // Rezerve edilen klasör de listede görünür; dışlanmazsa "önceki run" kendisi olur ve
    // devralma (covered birimler) hiç çalışmaz — her koşu sıfırdan avlanır.
    const previousRun = deps.store.latestRunId(deps.cwd, runId);
    const previous = previousRun ? deps.store.readLedger(deps.cwd, previousRun) : null;
    const seed = buildLedger({ sourceRef, profile: options.profile, files, previous });
    seed.ledger.repo = deps.repo;
    const meta: AuditRunMeta = {
      runId,
      repo: deps.repo,
      target: deps.cwd,
      profile: options.profile,
      sourceRef,
      scopePaths: options.scopePaths ?? [],
      packs: seed.packs,
      executionPolicy: "source-only",
      budget: initialBudget(options.profile, options.budget),
      status: "in_progress",
      phase: "recon",
      startedAt: now(),
      // Kaynak listesi `MAX_FILES` ile kırpıldıysa kayda geçer: rapor "tam kapsama" diyemez.
      ...(isFileListTruncated(deps.cwd)
        ? {
            coverageNote: dict(deps.lang ?? "tr").prompt.auditFilesTruncated.replace(
              "{{n}}",
              String(MAX_FILES),
            ),
          }
        : {}),
    };
    const session = new AuditSession(deps, runId, meta, seed.ledger, emptyCandidates(), []);
    session.persistAll();
    return session;
  }

  /** Var olan run'ı diskten yükler; meta ya da defter bozuksa null. */
  static load(deps: AuditSessionDeps, runId: string): AuditSession | null {
    const meta = deps.store.readMeta(deps.cwd, runId);
    const ledger = deps.store.readLedger(deps.cwd, runId);
    if (!meta || !ledger) return null;
    return new AuditSession(
      deps,
      runId,
      meta,
      ledger,
      deps.store.readCandidates(deps.cwd, runId),
      deps.store.readFindings(deps.cwd, runId),
    );
  }

  get meta(): AuditRunMeta {
    return this.#meta;
  }

  get ledger(): CoverageLedger {
    return this.#ledger;
  }

  get candidates(): AuditCandidate[] {
    return this.#candidates.items;
  }

  get findings(): AuditFinding[] {
    return this.#findings;
  }

  get budgetExhausted(): boolean {
    return this.#meter.exhausted;
  }

  /** Ajan çağrısı harcaması; sınır doluysa false döner ve hiçbir şey değişmez. */
  spend(n = 1): boolean {
    return this.#meter.trySpend(n);
  }

  setPhase(phase: AuditPhase): void {
    this.#meta = { ...this.#meta, phase };
    this.store.writeMeta(this.cwd, this.runId, this.#meta);
  }

  setStatus(status: AuditStatus, incompleteReason?: string): void {
    this.#meta = {
      ...this.#meta,
      status,
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(status === "in_progress" ? {} : { endedAt: now() }),
    };
    this.store.writeMeta(this.cwd, this.runId, this.#meta);
  }

  nextUnits(limit: number): CoverageUnit[] {
    return nextUnits(this.#ledger, limit);
  }

  /**
   * Avlanmadan ya da yarıda kalıp ertelenen birimler (süre sınırı, bütçe). `needs_validation`
   * kaydından gelen erteleme bulgu parmak izi taşır; o birim avlanmıştır, burada sayılmaz.
   */
  unhuntedDeferred(): CoverageUnit[] {
    return this.#ledger.units.filter((u) => u.status === "deferred" && !u.fingerprint);
  }

  unit(id: string): CoverageUnit | undefined {
    return this.#ledger.units.find((u) => u.id === id);
  }

  /** Yeni av turu için atama listesi; birimler "candidate" durumuna geçer. */
  assign(unitIds: string[]): {
    assignments: HuntAssignment[];
    errors: Array<{ unitId: string; error: string }>;
  } {
    const assignments: HuntAssignment[] = [];
    const errors: Array<{ unitId: string; error: string }> = [];
    for (const unitId of unitIds) {
      const unit = this.unit(unitId);
      if (!unit) {
        errors.push({ unitId, error: `${unitId}: bilinmeyen birim` });
        continue;
      }
      if (unit.status !== "planned" && unit.status !== "candidate") {
        errors.push({ unitId, error: `${unitId}: durum '${unit.status}', avlanamaz` });
        continue;
      }
      assignments.push({
        unitId: unit.id,
        attackClass: unit.attackClass,
        scopePaths: unit.scopePaths,
        packPath: this.packPath(unit.attackClass),
      });
    }
    return { assignments, errors };
  }

  /** Seçilen saldırı sınıfı paketinin tam dosya yolu (avcı kendi okur). */
  packPath(pack: string): string | null {
    const file = PACK_FILES[pack as AuditPack];
    if (!file || !this.assetsDir) return null;
    return `${this.assetsDir}/${file}`;
  }

  /** Avcı adaylarını ekler; aynı fingerprint zaten varsa atlanır. */
  addCandidates(
    unitId: string,
    attackClass: string,
    foundBy: string,
    values: HunterCandidate[],
    options: { partial?: boolean } = {},
  ): AuditCandidate[] {
    const added: AuditCandidate[] = [];
    for (const value of values) {
      const primary = value.evidence[0] ?? value.trace[0];
      const id = fingerprintFor({
        attackClass,
        file: primary?.file ?? `${unitId}.unknown`,
        line: primary?.line ?? 1,
      });
      if (this.#candidates.items.some((item) => item.id === id)) continue;
      const candidate = candidateFromHunter({
        id,
        unit: unitId,
        attackClass,
        foundBy,
        value,
        now: now(),
      });
      this.#candidates.items.push(candidate);
      added.push(candidate);
    }
    if (added.length === 0) {
      // Aday çıkmadı (ya da hepsi zaten kayıtlı): birim taranmış sayılır, aksi halde
      // kapsam defterinde sonsuza dek "candidate" asılı kalırdı. Süre dolup yarıda kesilen av
      // "taranmış" değildir: birim ertelenir, raporda kapsanmadı olarak görünür.
      if (options.partial)
        this.markUnit(unitId, "deferred", "kısmi tarama: avcının süresi doldu, aday çıkmadı");
      else this.markUnit(unitId, "covered", "avcı yeni aday bulmadı");
      this.persistCandidates();
      return added;
    }
    this.markUnit(
      unitId,
      "candidate",
      options.partial ? "kısmi tarama: avcının süresi doldu" : undefined,
    );
    this.persistCandidates();
    return added;
  }

  /** Avcı çıktısı çözümlenemediyse: aday iskeleti kaydedilir, gerekçe görünür kalır. */
  addParseFailure(unitId: string, foundBy: string, error: string): AuditCandidate {
    const unit = this.unit(unitId);
    const file = unit?.scopePaths[0] ?? `${unitId}.unknown`;
    const id = fingerprintFor({ attackClass: unit?.attackClass ?? "core", file, line: 1 });
    const existing = this.#candidates.items.find((item) => item.id === id);
    if (existing) return existing;
    const reason = `yapısal çıktı alınamadı: ${error}`;
    const candidate = unparsedCandidate({
      id,
      unit: unitId,
      attackClass: unit?.attackClass ?? "core",
      foundBy,
      parseError: error,
      now: now(),
      trace: [
        {
          kind: "entrypoint",
          file,
          line: 1,
          scope: unit?.surface ?? unitId,
          description: reason.slice(0, 300),
        },
      ],
      evidence: [{ file, line: 1, description: reason.slice(0, 300) }],
    });
    this.#candidates.items.push(candidate);
    this.markUnit(unitId, "candidate", "yapısal çıktı alınamadı");
    this.persistCandidates();
    return candidate;
  }

  /** Doğrulama bekleyenler: kimlik verilmezse tüm doğrulanmamış adaylar. */
  pendingVerification(ids: string[]): AuditCandidate[] {
    const wanted = new Set(ids);
    return this.#candidates.items.filter(
      (item) => item.verification === null && (ids.length === 0 || wanted.has(item.id)),
    );
  }

  candidate(id: string): AuditCandidate | undefined {
    return this.#candidates.items.find((item) => item.id === id);
  }

  applyVerification(
    id: string,
    verifiedBy: string,
    detail: VerifierVerdict,
  ): { ok: true } | { ok: false; error: string } {
    const index = this.#candidates.items.findIndex((item) => item.id === id);
    const candidate = this.#candidates.items[index];
    if (index < 0 || !candidate) return { ok: false, error: `${id}: aday yok` };
    this.#candidates.items[index] = {
      ...candidate,
      verification: { verdict: detail.verdict, verifiedBy, at: now(), detail },
    };
    this.persistCandidates();
    return { ok: true };
  }

  /**
   * Doğrulanmış adayları kayda terfi ettirir. Bağımsızlık (K4) ve upstream şeması burada
   * zorlanır; geçmeyen aday `errors` ile döner ve `candidates.json`'da kalır.
   */
  record(ids: string[]): { recorded: AuditFinding[]; errors: string[] } {
    const wanted = new Set(ids);
    const recorded: AuditFinding[] = [];
    const errors: string[] = [];
    for (const candidate of this.#candidates.items) {
      if (candidate.verification === null) continue;
      if (ids.length > 0 && !wanted.has(candidate.id)) continue;
      if (this.#findings.some((finding) => finding.fingerprint === candidate.id)) continue;
      const promoted = promoteCandidate(candidate);
      if (!promoted.ok) {
        errors.push(...promoted.errors);
        continue;
      }
      recorded.push(promoted.finding);
    }
    if (recorded.length === 0) return { recorded: [], errors };

    const nextFindings = sortFindings([...this.#findings, ...recorded]);
    const check = validateFindings(nextFindings);
    if (!check.ok) return { recorded: [], errors: [...errors, ...check.errors] };

    this.#findings = nextFindings;
    this.store.writeFindings(this.cwd, this.runId, this.#findings);
    for (const finding of recorded) {
      const candidate = this.#candidates.items.find((item) => item.id === finding.fingerprint);
      const unit = candidate ? this.unit(candidate.unit) : undefined;
      if (!unit || !candidate) continue;
      const status: AuditUnitStatus =
        finding.verdict === "confirmed"
          ? "covered"
          : finding.verdict === "needs_validation"
            ? "deferred"
            : "rejected";
      this.#setUnit(unit.id, {
        status,
        note: noteForFinding(finding),
        fingerprint: finding.fingerprint,
        foundBy: candidate.foundBy,
        verifiedBy: candidate.verification?.verifiedBy ?? null,
      });
    }
    return { recorded, errors };
  }

  #setUnit(unitId: string, patch: Partial<CoverageUnit>): void {
    const index = this.#ledger.units.findIndex((u) => u.id === unitId);
    const unit = this.#ledger.units[index];
    if (index < 0 || !unit) return;
    this.#ledger.units[index] = { ...unit, ...patch };
    this.#ledger.updatedAt = now();
    this.store.writeLedger(this.cwd, this.runId, this.#ledger);
  }

  markUnit(unitId: string, status: AuditUnitStatus, note?: string): void {
    this.#setUnit(unitId, { status, ...(note ? { note } : {}) });
  }

  persistCandidates(): void {
    this.#candidates = { ...this.#candidates, updatedAt: now() };
    this.store.writeCandidates(this.cwd, this.runId, this.#candidates);
  }

  persistAll(): void {
    this.store.writeMeta(this.cwd, this.runId, this.#meta);
    this.store.writeLedger(this.cwd, this.runId, this.#ledger);
    this.persistCandidates();
    this.store.writeFindings(this.cwd, this.runId, this.#findings);
  }

  /** Panelin tek veri kaynağı; kayıtlar kompakt görünüme indirgenir. */
  view(): AuditView {
    const statusCount = (status: AuditUnitStatus) =>
      this.#ledger.units.filter((u) => u.status === status).length;
    const verdictCount = (verdict: AuditFinding["verdict"]) =>
      this.#findings.filter((f) => f.verdict === verdict).length;
    const paths = this.store.paths(this.cwd, this.runId);
    return {
      runId: this.runId,
      repo: this.#meta.repo,
      target: this.#meta.target,
      profile: this.#meta.profile,
      phase: this.#meta.phase,
      status: this.#meta.status,
      sourceRef: this.#meta.sourceRef,
      startedAt: this.#meta.startedAt,
      endedAt: this.#meta.endedAt ?? null,
      incompleteReason: this.#meta.incompleteReason ?? null,
      budget: this.#meta.budget,
      counts: {
        units: this.#ledger.units.length,
        covered: statusCount("covered"),
        planned: statusCount("planned"),
        deferred: statusCount("deferred"),
        outOfScope: statusCount("out_of_scope"),
        confirmed: verdictCount("confirmed"),
        needsValidation: verdictCount("needs_validation"),
        rejected: verdictCount("rejected"),
      },
      findings: sortFindings(this.#findings).map((finding) =>
        toFindingView(
          finding,
          this.#ledger.units.find((u) => u.fingerprint === finding.fingerprint) ?? null,
        ),
      ),
      reportPath: this.store.reportExists(this.cwd, this.runId) ? paths.report : null,
      pdfPath: existsSync(paths.pdf) ? paths.pdf : null,
      runDir: paths.dir,
    };
  }
}

function emptyCandidates(): CandidateFile {
  return { version: 1, updatedAt: now(), items: [] };
}

function noteForFinding(finding: AuditFinding): string {
  if (finding.verdict === "needs_validation")
    return `doğrulama engelli: ${finding.blockers[0] ?? ""}`;
  if (finding.verdict === "rejected") return `çürütüldü: ${finding.reason}`;
  return "doğrulandı";
}
