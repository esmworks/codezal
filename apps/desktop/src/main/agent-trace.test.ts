import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@codezal/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { AgentTrace, traceFileName } from "./agent-trace";

const dir = mkdtempSync(join(tmpdir(), "cz-trace-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const errorEvent = (sessionId: string, message: string, at = 1): AgentEvent => ({
  type: "error",
  sessionId,
  at,
  message,
  // Zarf alanları bus'ta eklenir; test doğrudan olay kurduğu için burada verilir.
  seq: 1,
  epoch: "test",
});

/** Akış yazımı asenkron; koşul sağlanana kadar kısa aralıklarla bakar. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    try {
      if (check()) return;
    } catch {
      // Dosya henüz oluşmadı; sonraki turda yeniden bakılır.
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("zaman aşımı");
}

describe("AgentTrace", () => {
  it("olayı NDJSON satırı olarak yazar ve gizli anahtarı maskeler", async () => {
    const trace = new AgentTrace(join(dir, "a"), true);
    trace.write(errorEvent("s1", "anahtar sk-ant-1234567890abcdef kaçtı"));
    const file = trace.fileOf("s1");
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("kaçtı"));
    const line = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(line) as AgentEvent;
    expect(parsed.type).toBe("error");
    expect(parsed.sessionId).toBe("s1");
    expect(line).not.toContain("sk-ant-1234567890abcdef");
  });

  it("kapalıyken dosya oluşturmaz, sonradan açılabilir", async () => {
    const trace = new AgentTrace(join(dir, "b"), false);
    trace.write(errorEvent("s2", "yazılmamalı"));
    expect(existsSync(trace.fileOf("s2"))).toBe(false);
    trace.setEnabled(true);
    trace.write(errorEvent("s2", "şimdi yazıldı"));
    await waitFor(() => existsSync(trace.fileOf("s2")));
    expect(readFileSync(trace.fileOf("s2"), "utf8")).toContain("şimdi yazıldı");
  });

  it("5 MB'ı aşınca dosyayı devreder", async () => {
    const trace = new AgentTrace(join(dir, "c"), true);
    const file = trace.fileOf("s3");
    writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
    trace.write(errorEvent("s3", "devir sonrası"));
    await waitFor(() => existsSync(`${file}.1`));
    await waitFor(() => readFileSync(file, "utf8").includes("devir sonrası"));
    expect(readFileSync(`${file}.1`, "utf8").length).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("oturum silinince izi de siler", async () => {
    const trace = new AgentTrace(join(dir, "d"), true);
    trace.write(errorEvent("s4", "silinecek"));
    await waitFor(() => existsSync(trace.fileOf("s4")));
    trace.remove("s4");
    expect(existsSync(trace.fileOf("s4"))).toBe(false);
  });

  it("saklama süresini aşan dosyaları temizler", () => {
    const trace = new AgentTrace(join(dir, "e"), true);
    const old = trace.fileOf("eski");
    const fresh = trace.fileOf("yeni");
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    expect(trace.prune()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("oturum kimliğini güvenli dosya adına çevirir", () => {
    expect(traceFileName("abc/../d e")).toBe("abc_.._d_e.ndjson");
  });
});
