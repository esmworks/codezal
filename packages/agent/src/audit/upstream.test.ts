import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HunterCandidate, VerifierVerdict } from "./candidates.js";
import { AuditSession, type AuditSessionDeps } from "./session.js";
import { AuditStore } from "./store.js";

/**
 * Parite testi: uygulamanın ürettiği `findings.json`, Cloudflare'in kendi doğrulayıcısından
 * geçmeli (K6). Doğrulayıcı vendored pakette durur; Node yoksa test atlanır.
 */
const VALIDATOR = join(process.cwd(), "apps/desktop/resources/audit/validate-findings.cjs");
const NODE = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-audit-parity-"));
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
  title: "Kök kapsam denetimi eksik",
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

const CONFIRMED: VerifierVerdict = {
  verdict: "confirmed",
  reason: "Kaynak izi doğrulandı.",
  root_cause: "Kök karşılaştırması yok.",
  intended_behavior: "Yol proje kökü içinde kalmalı.",
  execution: {
    attacker_perspective: "Renderer'da çalışan enjekte içerik",
    payloads: ["../../etc/passwd"],
    instructions: ["read çağrısını göreli yolla çalıştır"],
    observed_result: "Kaynak izi kök denetiminin olmadığını gösteriyor.",
  },
  remediation: { strategy: "Yol çözümünden sonra kök kapsamı denetlenir." },
  severity: {
    likelihood: { score: "high", reason: "Tek çağrı yeterli." },
    impact: { score: "medium", reason: "Dosya okuma ile sınırlı." },
    overall_severity: "medium",
  },
  confidence: { score: "high", reason: "İz uçtan uca okunuyor." },
};

const NEEDS: VerifierVerdict = {
  verdict: "needs_validation",
  reason: "Paketleme yapılandırması depoda yok.",
  blockers: ["İmza politikası depo dışında."],
  validation_plan: { deployment: "Yayın ortamında imza zorunluluğunu doğrula." },
};

const REJECTED: VerifierVerdict = { verdict: "rejected", reason: "Aynı çağrı yolu yok." };

describe("upstream paritesi", () => {
  it.skipIf(!NODE || !existsSync(VALIDATOR))(
    "üretilen findings.json upstream doğrulayıcıdan geçer",
    () => {
      const repo = tmp();
      write(repo, "apps/desktop/src/main/window.ts");
      write(repo, "packages/agent/src/engine.ts");
      write(repo, "package.json");
      const deps: AuditSessionDeps = {
        store: new AuditStore(join(tmp(), "audits")),
        cwd: repo,
        repo: "parite-deposu",
        assetsDir: null,
      };
      const session = AuditSession.start(deps, { profile: "quick" });
      expect(session.nextUnits(3).length).toBeGreaterThanOrEqual(3);

      const verdicts: VerifierVerdict[] = [CONFIRMED, NEEDS, REJECTED];
      session.nextUnits(3).forEach((unit, index) => {
        session.assign([unit.id]);
        const added = session.addCandidates(unit.id, unit.attackClass, `hunter-${index}`, [
          CANDIDATE,
        ]);
        const candidate = added[0];
        if (!candidate) throw new Error("aday eklenmedi");
        const verdict = verdicts[index] ?? REJECTED;
        session.applyVerification(candidate.id, `verifier-${index}`, verdict);
      });
      const result = session.record([]);
      expect(result.errors).toEqual([]);
      expect(session.findings.length).toBe(3);
      expect(new Set(session.findings.map((f) => f.verdict))).toEqual(
        new Set(["confirmed", "needs_validation", "rejected"]),
      );

      const findingsPath = deps.store.paths(repo, session.runId).findings;
      const check = spawnSync("node", [VALIDATOR, findingsPath], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain("PASS");
    },
  );
});
