import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HunterCandidate, VerifierVerdict } from "./candidates.js";
import { buildReport } from "./report.js";
import { AuditSession, type AuditSessionDeps } from "./session.js";
import { AUDIT_FILE, AuditStore } from "./store.js";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-audit-run-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, rel: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "export const x = 1;\n");
}

const CANDIDATE: HunterCandidate = {
  title: "Yol kapsam denetimi eksik",
  description: "Gelen yol proje kökü dışına çıkabiliyor.",
  claimed_root_cause: "Yol çözümünden sonra kök karşılaştırması yapılmıyor.",
  intended_behavior: "Yol proje kökü içinde kalmalı.",
  trace: [
    {
      kind: "entrypoint",
      file: "apps/desktop/src/main/window.ts",
      line: 1,
      scope: "open",
      description: "Renderer isteği buradan girer.",
    },
    {
      kind: "sink",
      file: "apps/desktop/src/main/window.ts",
      line: 2,
      scope: "read",
      description: "Dosya okunur.",
    },
  ],
  evidence: [
    { file: "apps/desktop/src/main/window.ts", line: 2, description: "Kök denetimi yok." },
  ],
  conditions: [],
};

function setup(): { deps: AuditSessionDeps; repo: string } {
  const repo = tmp();
  write(repo, "apps/desktop/src/main/window.ts");
  write(repo, "packages/agent/src/engine.ts");
  const deps: AuditSessionDeps = {
    store: new AuditStore(join(tmp(), "audits")),
    cwd: repo,
    repo: "ornek-depo",
    assetsDir: null,
  };
  return { deps, repo };
}

/** İlk `planned` birimi avlar; aday kimliğini döner. */
function hunt(session: AuditSession, foundBy: string): string {
  const unit = session.nextUnits(1)[0];
  if (!unit) throw new Error("avlanacak birim yok");
  session.assign([unit.id]);
  const added = session.addCandidates(unit.id, unit.attackClass, foundBy, [CANDIDATE]);
  const candidate = added[0];
  if (!candidate) throw new Error("aday eklenmedi");
  return candidate.id;
}

const REJECTED: VerifierVerdict = { verdict: "rejected", reason: "Aynı çağrı yolu yok." };
const CONFIRMED: VerifierVerdict = {
  verdict: "confirmed",
  reason: "Kaynakta doğrulandı.",
  root_cause: "Kök denetimi yok.",
  intended_behavior: "Kök içinde kalmalı.",
  execution: {
    attacker_perspective: "Renderer'daki enjekte içerik",
    payloads: ["../../etc/passwd"],
    instructions: ["read çağrısını göreli yolla çalıştır"],
    observed_result: "Kaynak izi kök denetiminin olmadığını gösteriyor.",
  },
  remediation: { strategy: "resolve sonrası kök kapsamı denetlenir." },
  severity: {
    likelihood: { score: "high", reason: "Tek çağrı yeter." },
    impact: { score: "medium", reason: "Dosya okuma." },
    overall_severity: "medium",
  },
  confidence: { score: "high", reason: "İz uçtan uca." },
};

describe("denetim run'ı", () => {
  it("run'ı başlatır ve üç dosyayı yazar", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    expect(session.runId).toBe("run-1");
    const paths = deps.store.paths(deps.cwd, session.runId);
    expect(() => readFileSync(paths.meta, "utf8")).not.toThrow();
    expect(JSON.parse(readFileSync(paths.meta, "utf8")).executionPolicy).toBe("source-only");
    expect(JSON.parse(readFileSync(paths.ledger, "utf8")).units.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(paths.findings, "utf8"))).toEqual([]);
    const view = session.view();
    expect(view.counts.units).toBeGreaterThan(0);
    expect(view.findings).toEqual([]);
  });

  it("ikinci run aynı depo geçmişine eklenir", () => {
    const { deps } = setup();
    const first = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(first, "hunter-1");
    first.applyVerification(id, "verifier-1", REJECTED);
    first.record([]);
    const second = AuditSession.start(deps, { profile: "quick" });
    expect(second.runId).toBe("run-2");
    expect(deps.store.listRuns(deps.cwd)).toEqual(["run-1", "run-2"]);
  });

  it("doğrulama bekleyen kaydı severity olmadan raporlar", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(session, "hunter-1");
    session.applyVerification(id, "verifier-1", {
      verdict: "needs_validation",
      reason: "Dağıtım yapılandırması depoda yok.",
      blockers: ["İmza politikası bilinmiyor."],
      validation_plan: { deployment: "Yayın ortamında doğrula." },
    });
    const result = session.record([]);
    expect(result.errors).toEqual([]);
    expect(result.recorded).toHaveLength(1);
    expect(result.recorded[0]?.verdict).toBe("needs_validation");
    const findings = deps.store.readFindings(deps.cwd, session.runId);
    expect(findings[0]?.verdict === "needs_validation" && "severity" in findings[0]).toBe(false);
    const unit = session.ledger.units.find((u) => u.status === "deferred");
    expect(unit?.verifiedBy).toBe("verifier-1");
    const report = buildReport(
      { meta: session.meta, ledger: session.ledger, findings: session.findings },
      "tr",
    );
    expect(report.needsValidation).toContain("Doğrulama Bekleyen");
    expect(report.report).toContain("Doğrulama bekliyor: 1");
  });

  it("bulan ajan kendi kaydını confirmed yapamaz (K4)", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(session, "hunter-1");
    session.applyVerification(id, "hunter-1", CONFIRMED);
    const result = session.record([]);
    expect(result.recorded).toEqual([]);
    expect(result.errors.join(" ")).toContain("K4");
    expect(session.findings).toEqual([]);
  });

  it("bağımsız doğrulanan kaydı kapsandı işaretler", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(session, "hunter-1");
    session.applyVerification(id, "verifier-9", CONFIRMED);
    const result = session.record([]);
    expect(result.errors).toEqual([]);
    expect(result.recorded[0]?.verdict).toBe("confirmed");
    const unit = session.ledger.units.find((u) => u.fingerprint === id);
    expect(unit?.status).toBe("covered");
    expect(unit?.foundBy).toBe("hunter-1");
    expect(unit?.verifiedBy).toBe("verifier-9");
    const view = session.view();
    expect(view.counts.confirmed).toBe(1);
    expect(view.findings[0]?.independentlyVerified).toBe(true);
    expect(view.findings[0]?.severity).toBe("medium");
  });

  it("bütçe dolarsa harcama reddedilir", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick", budget: 2 });
    expect(session.spend(1)).toBe(true);
    expect(session.spend(1)).toBe(true);
    expect(session.spend(1)).toBe(false);
    expect(session.budgetExhausted).toBe(true);
    const persisted = JSON.parse(
      readFileSync(deps.store.paths(deps.cwd, session.runId).meta, "utf8"),
    );
    expect(persisted.budget).toEqual({ agentCalls: 2, used: 2 });
  });

  it("aday çıkmayan av birimi kapsandı sayılır", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const unit = session.nextUnits(1)[0];
    if (!unit) throw new Error("birim yok");
    session.assign([unit.id]);
    const added = session.addCandidates(unit.id, unit.attackClass, "hunter-1", []);
    expect(added).toEqual([]);
    expect(session.unit(unit.id)?.status).toBe("covered");
    expect(session.unit(unit.id)?.note).toBe("avcı yeni aday bulmadı");
  });

  it("süresi dolan kısmi av kapsandı sayılmaz: aday yoksa ertelenir, varsa not düşer", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const [empty, found] = session.nextUnits(2);
    if (!empty || !found) throw new Error("iki birim gerekli");
    session.assign([empty.id, found.id]);
    session.addCandidates(empty.id, empty.attackClass, "hunter-1", [], { partial: true });
    expect(session.unit(empty.id)?.status).toBe("deferred");
    expect(session.unit(empty.id)?.note).toContain("kısmi tarama");
    // Ertelenen birim yeniden avlanmaz: ana ajan aynı birimi döngüde avlatamaz.
    expect(session.nextUnits(10).some((u) => u.id === empty.id)).toBe(false);
    expect(session.assign([empty.id]).errors).toHaveLength(1);
    // Rapor bu listeye bakıp run'ı `incomplete` işaretler.
    expect(session.unhuntedDeferred().map((u) => u.id)).toEqual([empty.id]);

    session.addCandidates(found.id, found.attackClass, "hunter-2", [CANDIDATE], { partial: true });
    expect(session.unit(found.id)?.status).toBe("candidate");
    expect(session.unit(found.id)?.note).toContain("kısmi tarama");
  });

  it("rapor aynı girdiden aynı çıktıyı üretir", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(session, "hunter-1");
    session.applyVerification(id, "verifier-9", CONFIRMED);
    session.record([]);
    const input = { meta: session.meta, ledger: session.ledger, findings: session.findings };
    const first = buildReport(input, "tr");
    const second = buildReport(input, "tr");
    expect(first.report).toBe(second.report);
    expect(first.detail).toContain("Yol kapsam denetimi eksik");
    expect(first.html).toContain("<!doctype html>");
    expect(first.html).toContain("medium");
  });

  it("rapor dili metinlerle ve html lang ile birlikte değişir", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    const id = hunt(session, "hunter-1");
    session.applyVerification(id, "verifier-9", CONFIRMED);
    session.record([]);
    const input = { meta: session.meta, ledger: session.ledger, findings: session.findings };

    const tr = buildReport(input, "tr");
    expect(tr.html).toContain('<html lang="tr-TR">');
    expect(tr.html).toContain("Saldırı sınıfı");
    expect(tr.report).toContain("# Güvenlik Denetimi Raporu");

    const en = buildReport(input, "en");
    expect(en.html).toContain('<html lang="en-US">');
    expect(en.html).toContain("Attack class");
    expect(en.report).toContain("# Security Audit Report");
    expect(en.report).not.toContain("Güvenlik Denetimi Raporu");
    expect(en.needsValidation).toContain("Findings Needing Validation");
  });

  it("aday dosyası diske yazılır, kayıt dosyası upstream adıyla durur", () => {
    const { deps } = setup();
    const session = AuditSession.start(deps, { profile: "quick" });
    hunt(session, "hunter-1");
    const paths = deps.store.paths(deps.cwd, session.runId);
    expect(paths.candidates.endsWith(AUDIT_FILE.candidates)).toBe(true);
    const file = JSON.parse(readFileSync(paths.candidates, "utf8"));
    expect(file.items).toHaveLength(1);
    expect(file.items[0].verification).toBeNull();
  });
});
