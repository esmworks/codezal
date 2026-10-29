import { describe, expect, it, vi } from "vitest";
import { AUDIT_HUNT_TOOL, AUDIT_VERIFY_TOOL, type AuditRunner, auditTools } from "./tools.js";

/** Testte yalnızca ilgili metot çağrılır; diğerlerine erişilirse hata verir. */
function runnerWith(overrides: Partial<AuditRunner>): AuditRunner {
  const unused = () => {
    throw new Error("bu metot testte kullanılmaz");
  };
  return {
    start: unused,
    hunt: unused,
    verify: unused,
    record: unused,
    status: unused,
    report: unused,
    ...overrides,
  };
}

/** `defineTool` dönüşü heterojen birleşim; testte yalnızca execute imzası gerekir. */
type ToolExecutor<P> = {
  execute: (
    id: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
  ) => Promise<unknown>;
};

function toolFor<P>(runner: AuditRunner, name: string): ToolExecutor<P> {
  const tool = auditTools(runner, "tr").find((t) => t.name === name);
  if (!tool) throw new Error(`${name} aracı bulunamadı`);
  return tool as unknown as ToolExecutor<P>;
}

describe("denetim araçları", () => {
  it("av ilerlemesini kartın onUpdate'ine aktarır", async () => {
    const runner = runnerWith({
      hunt: async (_units, _signal, onProgress) => {
        onProgress?.("2/6 birim tarandı · 1 aday");
        return [];
      },
    });
    const onUpdate = vi.fn();
    await toolFor<{ units: string[] }>(runner, AUDIT_HUNT_TOOL).execute(
      "t1",
      { units: ["u1", "u2"] },
      undefined,
      onUpdate,
    );
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "2/6 birim tarandı · 1 aday" }],
      details: [],
    });
  });

  it("doğrulama ilerlemesini kartın onUpdate'ine aktarır", async () => {
    const runner = runnerWith({
      verify: async (_ids, _signal, onProgress) => {
        onProgress?.("1/3 aday doğrulandı");
        return [];
      },
    });
    const onUpdate = vi.fn();
    await toolFor<{ candidates: string[] }>(runner, AUDIT_VERIFY_TOOL).execute(
      "t1",
      { candidates: ["c1", "c2", "c3"] },
      undefined,
      onUpdate,
    );
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "1/3 aday doğrulandı" }],
      details: [],
    });
  });

  it("onUpdate verilmezse ilerleme yayını sorun çıkarmaz", async () => {
    const runner = runnerWith({
      hunt: async (_units, _signal, onProgress) => {
        onProgress?.("1/1 birim tarandı · 0 aday");
        return [];
      },
    });
    const result = await toolFor<{ units: string[] }>(runner, AUDIT_HUNT_TOOL).execute(
      "t1",
      { units: ["u1"] },
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ details: [] });
  });
});
