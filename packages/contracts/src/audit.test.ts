import { describe, expect, it } from "vitest";
import {
  AuditFindingsDocument,
  AuditNeedsValidationFinding,
  AuditRejectedFinding,
  AuditSeverityBlock,
  isSafeRelativeSourcePath,
  SessionSummary,
} from "./index.js";

const confirmed = {
  verdict: "confirmed",
  fingerprint: "ipc:main/read-path",
  title: "Preload yol doğrulaması atlanabiliyor",
  description: "Renderer'dan gelen yol doğrulanmadan dosya okuma çağrısına geçiyor.",
  root_cause: "read-path yalnızca `~` genişletiyor, kapsam denetimi yapmıyor.",
  intended_behavior: "Yol, proje kökü dışına çıkamamalı.",
  trace: [
    {
      kind: "entrypoint",
      file: "apps/desktop/src/preload/index.ts",
      line: 12,
      scope: "invoke",
      description: "IPC isteği renderer'dan gelir.",
    },
    {
      kind: "sink",
      file: "packages/agent/src/read-path.ts",
      line: 40,
      scope: "expandReadPath",
      description: "Yol genişletilip diske gidilir.",
    },
  ],
  evidence: [
    {
      file: "packages/agent/src/read-path.ts",
      line: 40,
      description: "Kapsam denetimi yok.",
    },
  ],
  conditions: [],
  execution: {
    attacker_perspective: "Renderer'da çalışan enjekte edilmiş içerik",
    payloads: ["../../etc/passwd"],
    instructions: ["read aracını göreli yolla çağır"],
    observed_result: "Dosya proje kökü dışından okunur.",
  },
  remediation: { strategy: "Yol çözümünden sonra kök kapsamı denetlenir." },
  severity: {
    likelihood: { score: "high", reason: "Tek çağrı yeterli." },
    impact: { score: "medium", reason: "Dosya okuma ile sınırlı." },
    overall_severity: "medium",
  },
  confidence: { score: "high", reason: "Kaynak izi uçtan uca görülüyor." },
} as const;

const needsValidation = {
  verdict: "needs_validation",
  fingerprint: "supply:ci-artifact",
  title: "CI imzasız eser yayınlıyor olabilir",
  description: "Yayın hattı doğrulanmadı.",
  claimed_root_cause: "İmza adımı koşullu görünüyor.",
  trace: [
    {
      kind: "sink",
      file: ".github/workflows/release.yml",
      line: 159,
      scope: "release",
      description: "Eser yüklenir.",
    },
  ],
  evidence: [{ file: ".github/workflows/release.yml", line: 159, description: "Koşul ifadesi." }],
  blockers: ["Depo dışı imza politikası bilinmiyor."],
  validation_plan: { deployment: "Yayın ortamında imza zorunluluğunu doğrula." },
} as const;

const rejected = {
  verdict: "rejected",
  fingerprint: "web:cors-wildcard",
  title: "CORS joker olabilir",
  description: "Aday, doğrulamada çürütüldü.",
  claimed_root_cause: "Başlık herkese açık sanıldı.",
  trace: [
    {
      kind: "sink",
      file: "apps/desktop/src/main/security.ts",
      line: 18,
      scope: "hardenWebContents",
      description: "Başlık yalnızca yerel sunucuya verilir.",
    },
  ],
  evidence: [
    { file: "apps/desktop/src/main/security.ts", line: 18, description: "Kaynak yalnız yerel." },
  ],
  reason: "Başlık yalnızca localhost için ekleniyor.",
} as const;

describe("audit sözleşmesi", () => {
  it("SessionSummary varsayılanı auditRunId null", () => {
    const parsed = SessionSummary.parse({
      id: "s1",
      path: "/tmp/s1",
      cwd: "/tmp",
      name: "Oturum",
      mode: "kodlama",
      createdAt: 1,
      modifiedAt: 2,
      messageCount: 0,
    });
    expect(parsed.auditRunId).toBeNull();
  });

  it("geçerli confirmed kaydı kabul eder", () => {
    expect(() => AuditFindingsDocument.parse([confirmed])).not.toThrow();
  });

  it("needs_validation kaydına severity eklenirse reddeder", () => {
    const bad = { ...needsValidation, severity: confirmed.severity };
    expect(AuditNeedsValidationFinding.safeParse(bad).success).toBe(false);
  });

  it("rejected kaydı reason taşımazsa reddeder", () => {
    const { reason: _reason, ...bad } = rejected;
    expect(AuditRejectedFinding.safeParse(bad).success).toBe(false);
  });

  it("overall_severity gösterilen impact'i aşamaz", () => {
    const bad = { ...confirmed.severity, overall_severity: "critical" };
    expect(AuditSeverityBlock.safeParse(bad).success).toBe(false);
  });

  it("iz sırasını zorlar", () => {
    const bad = {
      ...confirmed,
      trace: [confirmed.trace[0], { ...confirmed.trace[0], kind: "propagation" }],
    };
    expect(AuditFindingsDocument.safeParse([bad]).success).toBe(false);
  });

  it("sıralı ve tekil fingerprint ister", () => {
    const second = { ...confirmed, fingerprint: "aaa:first" };
    expect(AuditFindingsDocument.safeParse([confirmed, second]).success).toBe(false);
    expect(AuditFindingsDocument.safeParse([{ ...confirmed }, { ...confirmed }]).success).toBe(
      false,
    );
  });

  it("güvensiz kaynak yollarını reddeder", () => {
    for (const bad of ["../etc/passwd", "C:\\x\\y", "~/gizli", "/etc/passwd", "a/../b"]) {
      expect(isSafeRelativeSourcePath(bad)).toBe(false);
    }
    expect(isSafeRelativeSourcePath("apps/desktop/src/preload/index.ts")).toBe(true);
  });
});
