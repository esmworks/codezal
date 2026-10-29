import type { AgentEventInput } from "@codezal/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "./event-bus.js";

const status = (s: "idle" | "working"): AgentEventInput => ({
  type: "status",
  sessionId: "s1",
  at: 1,
  status: s,
});

describe("AgentEventBus", () => {
  it("genel ve türe özel aboneler olayı alır", () => {
    const bus = new AgentEventBus();
    const all = vi.fn();
    const only = vi.fn();
    bus.subscribe(all);
    bus.on("status", only);
    bus.on("run_end", vi.fn());
    bus.emit(status("working"));
    expect(all).toHaveBeenCalledTimes(1);
    expect(only).toHaveBeenCalledWith(expect.objectContaining({ status: "working" }));
  });

  it("abonelik kaldırılınca olay gelmez", () => {
    const bus = new AgentEventBus();
    const fn = vi.fn();
    const off = bus.on("status", fn);
    off();
    bus.emit(status("idle"));
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });

  it("bir abonenin hatası diğerlerini engellemez", () => {
    const bus = new AgentEventBus();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    bus.subscribe(() => {
      throw new Error("patladı");
    });
    bus.subscribe(second);
    bus.emit(status("idle"));
    expect(second).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("zarf alanlarını ekler ve oturum başına monoton artırır", () => {
    const bus = new AgentEventBus("ep-1");
    const seen: number[] = [];
    bus.subscribe((event) => seen.push(event.seq));
    bus.emit(status("working"));
    bus.emit(status("idle"));
    // Aynı oturuma verilen sıra 1'den başlayıp artar; snapshot lastSeq bununla eşleşir.
    expect(seen).toEqual([1, 2]);
    expect(bus.seqOf("s1")).toBe(2);
  });

  it("farklı oturumların sıraları bağımsızdır", () => {
    const bus = new AgentEventBus("ep-1");
    bus.emit(status("working"));
    bus.emit({ type: "status", sessionId: "s2", at: 1, status: "idle" });
    expect(bus.seqOf("s1")).toBe(1);
    expect(bus.seqOf("s2")).toBe(1);
  });

  it("epoch tüm olaylara aynen taşınır", () => {
    const bus = new AgentEventBus("ep-42");
    let epoch = "";
    bus.subscribe((event) => {
      epoch = event.epoch;
    });
    bus.emit(status("working"));
    expect(epoch).toBe("ep-42");
  });

  it("varsayılan epoch üretilir ve boş değildir", () => {
    const bus = new AgentEventBus();
    expect(bus.epoch.length).toBeGreaterThan(0);
  });
});
