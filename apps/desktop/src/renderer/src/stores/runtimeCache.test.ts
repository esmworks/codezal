import { describe, expect, it } from "vitest";
import { emptyRuntime, type SessionRuntime } from "./reduce";
import { runtimeEvictions } from "./runtimeCache";

const idle = (): SessionRuntime => emptyRuntime();

function cache(ids: string[], over: Record<string, Partial<SessionRuntime>> = {}) {
  const runtime: Record<string, SessionRuntime> = {};
  for (const id of ids) runtime[id] = { ...idle(), ...over[id] };
  return runtime;
}

/**
 * Açılan her sohbetin transkripti uygulama kapanana dek bellekte kalıyordu. Son açılanlar,
 * aktif sohbet ve snapshot'ın geri getiremeyeceği durumu taşıyanlar dışındakiler düşer.
 */
describe("runtimeEvictions", () => {
  it("sınır içindeyken hiçbir şey düşmez", () => {
    const ids = ["a", "b", "c"];
    expect(runtimeEvictions(cache(ids), ids, new Set(), 3)).toEqual([]);
  });

  it("en eski açılanları düşürür, son açılanları tutar", () => {
    const ids = ["a", "b", "c", "d"];
    expect(runtimeEvictions(cache(ids), ids, new Set(), 2)).toEqual(["a", "b"]);
  });

  it("aktif sohbet eski olsa da kalır", () => {
    const ids = ["a", "b", "c"];
    expect(runtimeEvictions(cache(ids), ids, new Set(["a"]), 1)).toEqual(["b"]);
  });

  it("çalışan ya da izin kartı bekleyen oturum düşmez", () => {
    const ids = ["a", "b", "c", "d"];
    const runtime = cache(ids, {
      a: { status: "working", activeRunId: "r1" },
      b: {
        status: "waiting",
        permissions: [{ requestId: "p1" } as SessionRuntime["permissions"][number]],
      },
    });
    expect(runtimeEvictions(runtime, ids, new Set(), 1)).toEqual(["c"]);
  });

  it("snapshot'ta olmayan alt ajan listesi taşıyan oturum düşmez", () => {
    const ids = ["a", "b"];
    const runtime = cache(ids, {
      a: { subagents: [{ id: "x" } as SessionRuntime["subagents"][number]] },
    });
    expect(runtimeEvictions(runtime, ids, new Set(), 1)).toEqual([]);
  });

  it("sırada hiç görünmeyen runtime en eski sayılır", () => {
    expect(runtimeEvictions(cache(["x", "a", "b"]), ["a", "b"], new Set(), 2)).toEqual(["x"]);
  });
});
