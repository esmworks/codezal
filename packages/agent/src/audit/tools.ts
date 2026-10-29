import type { AuditStartOptions, AuditView } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

/**
 * Denetim araçları: model altı fazı bu araçlarla yürütür. Tüm durum uygulamada tutulur
 * (`AuditSession`); araçlar yalnızca kimlik ve kompakt özet taşır, böylece ana oturumun
 * bağlamı onlarca birim ve adayla şişmez.
 */

export const AUDIT_START_TOOL = "audit_start";
export const AUDIT_HUNT_TOOL = "audit_hunt";
export const AUDIT_VERIFY_TOOL = "audit_verify";
export const AUDIT_RECORD_TOOL = "audit_record";
export const AUDIT_STATUS_TOOL = "audit_status";
export const AUDIT_REPORT_TOOL = "audit_report";

/** Oturum denetim moduna girince etkinleşen araçlar; `audit_start` her zaman açıktır. */
export const AUDIT_TOOLS = [
  AUDIT_HUNT_TOOL,
  AUDIT_VERIFY_TOOL,
  AUDIT_RECORD_TOOL,
  AUDIT_STATUS_TOOL,
  AUDIT_REPORT_TOOL,
];

/** Bir av turunda en çok birim, bir doğrulama turunda en çok aday (bağlam ve maliyet sınırı). */
export const MAX_HUNT_UNITS = 6;
export const MAX_VERIFY_CANDIDATES = 6;

export interface AuditUnitSummary {
  id: string;
  attackClass: string;
  surface: string;
  files: number;
}

export interface AuditStartResult {
  runId: string;
  profile: string;
  units: number;
  packs: string[];
  budget: number | null;
  nextUnits: AuditUnitSummary[];
  message: string;
}

export interface AuditCandidateSummary {
  id: string;
  title: string;
  evidence: string;
  confidence: string | null;
}

export interface AuditHuntResult {
  unit: string;
  attackClass: string;
  candidates: AuditCandidateSummary[];
  /** Avcının süresi doldu, elindekiyle yazdı: birim tam taranmadı. */
  partial?: boolean;
  parseError?: string;
  error?: string;
}

export interface AuditVerifyResult {
  id: string;
  verdict: string;
  reason: string;
}

export interface AuditRecordResult {
  recorded: Array<{ id: string; verdict: string; severity: string | null }>;
  errors: string[];
}

export interface AuditStatusResult {
  runId: string;
  profile: string;
  phase: string;
  status: string;
  packs: string[];
  executionPolicy: string;
  counts: AuditView["counts"];
  budget: AuditView["budget"];
  nextUnits: AuditUnitSummary[];
  pendingVerification: string[];
  findings: Array<{ id: string; verdict: string; severity: string | null; title: string }>;
  incompleteReason: string | null;
}

export interface AuditReportResult {
  reportPath: string;
  detailPath: string;
  needsValidationPath: string;
  status: string;
  counts: AuditView["counts"];
}

/** Motor köprüsü: araçlar yalnızca bunu çağırır (Pi'yi bilen tek yer engine'dir). */
export interface AuditRunner {
  start(options: AuditStartOptions): Promise<AuditStartResult>;
  /** `onProgress`: her alt oturum dönüşünde kartta görünecek tek satırlık durum metni. */
  hunt(
    units: string[],
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ): Promise<AuditHuntResult[]>;
  verify(
    candidates: string[],
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ): Promise<AuditVerifyResult[]>;
  record(candidates: string[]): Promise<AuditRecordResult>;
  status(): Promise<AuditStatusResult>;
  report(): Promise<AuditReportResult>;
}

export function auditTools(run: AuditRunner, lang: Locale = "tr") {
  const d = dict(lang);

  const startTool = defineTool({
    name: AUDIT_START_TOOL,
    label: d.agent.tool.auditStart,
    description: d.prompt.auditStartDesc,
    promptSnippet: d.prompt.auditStartSnippet,
    promptGuidelines: [d.prompt.auditStartGuideline],
    parameters: Type.Object({
      profile: Type.Optional(
        Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
          description: d.prompt.auditProfile,
        }),
      ),
      scope_paths: Type.Optional(
        Type.Array(Type.String(), { description: d.prompt.auditScope, maxItems: 20 }),
      ),
      budget: Type.Optional(Type.Integer({ minimum: 5, description: d.prompt.auditBudget })),
    }),
    async execute(_id, params) {
      const options: AuditStartOptions = {
        profile: params.profile ?? "standard",
        ...(params.scope_paths && params.scope_paths.length > 0
          ? { scopePaths: params.scope_paths }
          : {}),
        ...(params.budget ? { budget: params.budget } : {}),
      };
      const result = await run.start(options);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const huntTool = defineTool({
    name: AUDIT_HUNT_TOOL,
    label: d.agent.tool.auditHunt,
    description: d.prompt.auditHuntDesc,
    promptSnippet: d.prompt.auditHuntSnippet,
    promptGuidelines: [d.prompt.auditHuntGuideline],
    parameters: Type.Object({
      units: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_HUNT_UNITS,
        description: d.prompt.auditUnits,
      }),
    }),
    async execute(_id, params, signal, onUpdate) {
      const result = await run.hunt(params.units, signal, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: [] });
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const verifyTool = defineTool({
    name: AUDIT_VERIFY_TOOL,
    label: d.agent.tool.auditVerify,
    description: d.prompt.auditVerifyDesc,
    promptSnippet: d.prompt.auditVerifySnippet,
    promptGuidelines: [d.prompt.auditVerifyGuideline],
    parameters: Type.Object({
      candidates: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_VERIFY_CANDIDATES,
        description: d.prompt.auditCandidates,
      }),
    }),
    async execute(_id, params, signal, onUpdate) {
      const result = await run.verify(params.candidates, signal, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: [] });
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const recordTool = defineTool({
    name: AUDIT_RECORD_TOOL,
    label: d.agent.tool.auditRecord,
    description: d.prompt.auditRecordDesc,
    promptSnippet: d.prompt.auditRecordSnippet,
    promptGuidelines: [d.prompt.auditRecordGuideline],
    parameters: Type.Object({
      candidates: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 50,
          description: d.prompt.auditCandidates,
        }),
      ),
    }),
    async execute(_id, params) {
      const result = await run.record(params.candidates ?? []);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const statusTool = defineTool({
    name: AUDIT_STATUS_TOOL,
    label: d.agent.tool.auditStatus,
    description: d.prompt.auditStatusDesc,
    promptSnippet: d.prompt.auditStatusSnippet,
    promptGuidelines: [d.prompt.auditStatusGuideline],
    parameters: Type.Object({}),
    async execute() {
      const result = await run.status();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const reportTool = defineTool({
    name: AUDIT_REPORT_TOOL,
    label: d.agent.tool.auditReport,
    description: d.prompt.auditReportDesc,
    promptSnippet: d.prompt.auditReportSnippet,
    promptGuidelines: [d.prompt.auditReportGuideline],
    parameters: Type.Object({}),
    async execute() {
      const result = await run.report();
      return {
        content: [
          { type: "text", text: `${d.prompt.auditReportDone}\n${JSON.stringify(result, null, 2)}` },
        ],
        details: result,
      };
    },
  });

  return [startTool, huntTool, verifyTool, recordTool, statusTool, reportTool];
}

/** `audit_start` her oturumda aktiftir; tetikleyici cümle doğal çalışsın diye. */
export function auditStartTool(run: AuditRunner, lang: Locale = "tr") {
  return auditTools(run, lang)[0];
}
