import type { PerfRecordRequest } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { ToolLatencyTracker } from "./perf";

describe("ToolLatencyTracker", () => {
  it("beklenen satır çizilince süreyi bir kez bildirir; beklenmeyen yok sayılır", () => {
    const sent: PerfRecordRequest[] = [];
    const tracker = new ToolLatencyTracker((req) => sent.push(req));
    tracker.expect("t1", 1_000, 1_000);
    tracker.rendered("t1", 1_042);
    tracker.rendered("t1", 1_100);
    // Geçmişten yüklenen kart (canlı olay yok) ölçülmez.
    tracker.rendered("eski", 1_100);
    expect(sent).toEqual([{ metric: "toolCard", ms: 42 }]);
    expect(tracker.size).toBe(0);
  });

  it("bayat ve fazla bekleyen kayıtlar düşer", () => {
    const sent: PerfRecordRequest[] = [];
    const tracker = new ToolLatencyTracker((req) => sent.push(req));
    tracker.expect("gec", 0, 0);
    tracker.rendered("gec", 40_000);
    expect(sent).toEqual([]);
    tracker.expect("a", 0, 0);
    tracker.expect("b", 50_000, 50_000);
    expect(tracker.size).toBe(1);
    for (let i = 0; i < 70; i += 1) tracker.expect(`x${i}`, 50_000, 50_000);
    expect(tracker.size).toBe(64);
  });
});
