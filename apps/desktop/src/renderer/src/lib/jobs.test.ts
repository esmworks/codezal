import type { BackgroundJob, SubagentRun, ToolCallItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  backgroundJobs,
  compactLabel,
  DONE_LINGER_MS,
  isBackgroundLaunch,
  sessionJobs,
  type WorkerJobInput,
} from "./jobs";

const bg = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "bg-1",
  command: "pnpm test",
  status: "running",
  startedAt: 1000,
  ...over,
});

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  id: "job-1",
  label: "iş",
  kind: "explore",
  status: "running",
  ...over,
});

describe("sessionJobs", () => {
  it("alt ajan koşularını süren, kuyruk, biten sırasıyla dizer", () => {
    const rows = sessionJobs([
      run({ id: "run-1", label: "kodu incele", kind: "review", startedAt: 2000, activity: "grep" }),
      run({ id: "queued", label: "testleri yaz", kind: "worker", status: "queued" }),
      run({ id: "done", label: "bitti", kind: "explore", status: "done", endedAt: 900 }),
    ]);
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "review:run-1",
      "worker:queued",
      "explore:done",
    ]);
    expect(rows[0]).toMatchObject({ activity: "grep", status: "running", source: "agent" });
    // Kuyruktaki koşunun başlama anı yok: satır süre saymaz.
    expect(rows[1]?.startedAt).toBeUndefined();
  });

  it("keşif koşusunu canlı iz kimliğiyle satıra çevirir", () => {
    const rows = sessionJobs([
      run({
        id: "sub-1",
        kind: "explore",
        label: "izin kapısı nerede",
        startedAt: 2000,
        steps: 3,
        model: "test-model",
        tokens: 500,
        tokensPerSec: 38,
        usage: { input: 10, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
      }),
    ]);
    expect(rows[0]).toMatchObject({
      id: "sub-1",
      traceId: "sub-1",
      source: "agent",
      kind: "explore",
      steps: 3,
      model: "test-model",
      tokens: 500,
      tokensPerSec: 38,
      cost: 0.02,
    });
  });

  it("denetim avcı/doğrulayıcı türleri korunur", () => {
    const rows = sessionJobs([
      run({ id: "hunt", kind: "audit-hunter", label: "Avcı · auth.md" }),
      run({ id: "verify", kind: "audit-verifier", label: "Doğrulayıcı · XSS" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["audit-hunter", "audit-verifier"]);
  });

  it("başarısız koşuyu hata durumuna taşır", () => {
    expect(sessionJobs([run({ status: "error" })])[0]?.status).toBe("error");
  });

  it("zaman verilmezse biten satırlar süzülmez: çağıran tüm listeyi görür", () => {
    expect(sessionJobs([run({ status: "done", startedAt: 1000, endedAt: 2000 })])).toHaveLength(1);
  });

  it("ömrü dolan biten satır düşer, süren ve kuyruktaki satırlar kalır", () => {
    const rows = sessionJobs(
      [
        run({ id: "t1", kind: "explore", startedAt: 1000 }),
        run({ id: "queued", label: "sırada", status: "queued" }),
        run({ id: "done", status: "done", startedAt: 1000, endedAt: 2000 }),
      ],
      [],
      { now: 2000 + DONE_LINGER_MS },
    );
    expect(rows.map((r) => r.id)).toEqual(["t1", "queued"]);
  });

  it("ömrü dolmamış biten satır listede kalır: sonuç bir an görünür", () => {
    const rows = sessionJobs([run({ status: "done", startedAt: 1000, endedAt: 2000 })], [], {
      now: 2000 + DONE_LINGER_MS - 1,
    });
    expect(rows).toHaveLength(1);
  });

  it("zaman damgası olmayan bitmiş satır düşer: ömrü ölçülemeyen satır kalıcı olamaz", () => {
    expect(sessionJobs([run({ status: "done" })], [], { now: 5000 })).toEqual([]);
  });

  it("ayrık koşu satırını oturum ve koşu kimliğiyle bağlar", () => {
    const workers: WorkerJobInput[] = [
      {
        id: "w1",
        title: "şemayı yaz",
        status: "working",
        sessionId: "sess-w1",
        startedAt: 1000,
        isolated: true,
      },
    ];
    const rows = sessionJobs([], workers);
    expect(rows[0]).toMatchObject({
      id: "w1",
      kind: "worker",
      label: "şemayı yaz",
      traceId: "sess-w1",
      runId: "w1",
      source: "worker",
      status: "running",
    });
  });

  it("yalıtımsız arka plan koşusu ajan türüyle görünür", () => {
    const rows = sessionJobs([], [{ id: "r1", title: "tara", status: "working" }]);
    expect(rows[0]).toMatchObject({ kind: "agent", source: "worker", traceId: "r1" });
  });

  it("inceleme bekleyen worker ömrü dolsa da düşmez: onu gösteren başka yüzey yok", () => {
    const workers: WorkerJobInput[] = [
      { id: "w-review", title: "birleştir", status: "review", startedAt: 1000, endedAt: 2000 },
      { id: "w-done", title: "bitti", status: "done", startedAt: 1000, endedAt: 2000 },
    ];
    const rows = sessionJobs([], workers, { now: 2000 + DONE_LINGER_MS });
    expect(rows.map((r) => r.id)).toEqual(["w-review"]);
  });
});

describe("backgroundJobs", () => {
  it("süren komutları başlama sırasıyla, bitenleri en yeni biten önce dizer", () => {
    const rows = backgroundJobs([
      bg({ id: "bg-1", startedAt: 3000 }),
      bg({ id: "bg-0", startedAt: 1500, status: "exited", endedAt: 4000, code: 0 }),
      bg({ id: "bg-2", startedAt: 100, status: "stopped", endedAt: 4500 }),
      bg({ id: "bg-3", startedAt: 2000 }),
    ]);
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "background:bg-3",
      "background:bg-1",
      "background:bg-2",
      "background:bg-0",
    ]);
    expect(rows[2]?.status).toBe("stopped");
    expect(rows[3]?.code).toBe(0);
  });

  it("başlık açıklamadır; açıklamasız komutta komutun tek satırı, tam komut görevde", () => {
    const command = "echo başla;\n  for i in 1 2; do sleep 1; done";
    const [described] = backgroundJobs([bg({ command, description: "Depo özetini çıkar" })]);
    expect(described?.label).toBe("Depo özetini çıkar");
    expect(described?.task).toBe(command);
    const [raw] = backgroundJobs([bg({ command })]);
    expect(raw?.label).toBe("echo başla; for i in 1 2; do sleep 1; done");
  });

  it("exited durumunu done'a çevirir", () => {
    const rows = backgroundJobs([bg({ status: "exited", endedAt: 2000, code: 3 })]);
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.code).toBe(3);
  });

  it("ömrü dolan biten komut düşer, süren komut kalır", () => {
    const rows = backgroundJobs(
      [
        bg({ id: "run", startedAt: 3000 }),
        bg({ id: "done", status: "exited", startedAt: 1000, endedAt: 2000, code: 0 }),
      ],
      { now: 2000 + DONE_LINGER_MS },
    );
    expect(rows.map((r) => r.id)).toEqual(["run"]);
  });
});

describe("compactLabel", () => {
  it("görev metninin başındaki yol gürültüsünü atar ve kalanı büyük harfle başlatır", () => {
    expect(
      compactLabel("Codezal deposunda (/Users/dev/Codezal) alt ajan olaylarını araştır."),
    ).toBe("Alt ajan olaylarını araştır.");
  });

  it("yol içermeyen parantezi korur: tür adı parantezde geçiyorsa bilgi kaybolmasın", () => {
    expect(compactLabel("Bu depoda (subagent) araması yap")).toBe(
      "Bu depoda (subagent) araması yap",
    );
  });

  it("uzun başlığı kelime sınırında kısaltır", () => {
    const out = compactLabel("packages/agent içindeki alt ajan yapılandırmasını araştır", 20);
    expect(out).toBe("packages/agent…");
    expect(out.endsWith("…")).toBe(true);
  });

  it("kalan kısım yol ile başlıyorsa büyük harfe çevirmez", () => {
    expect(compactLabel("Depoda (/x/y) packages/agent içindeki kısıtlar")).toBe(
      "packages/agent içindeki kısıtlar",
    );
  });

  it("kısa başlığı (worker adı, avcı kimliği) olduğu gibi bırakır", () => {
    expect(compactLabel("arm build")).toBe("arm build");
    expect(compactLabel("Avcı · auth-01")).toBe("Avcı · auth-01");
  });
});

describe("isBackgroundLaunch", () => {
  const tool = (over: Partial<ToolCallItem>): ToolCallItem => ({
    type: "tool",
    id: "t1",
    toolName: "bash",
    kind: "terminal",
    status: "done",
    title: "Terminal",
    command: "pnpm dev",
    startedAt: 0,
    ...over,
  });

  it("bash_background start arka plan başlatır, diğer eylemleri başlatmaz", () => {
    expect(isBackgroundLaunch(tool({ toolName: "bash_background" }))).toBe(true);
    expect(isBackgroundLaunch(tool({ toolName: "bash_background", kind: "other" }))).toBe(false);
  });

  it("süresi aşıp arka plana alınan bash çıktısındaki bildirimden tanınır", () => {
    const notice = "…arka plana alındı: bg-4. … için: bash_background output bg-4.";
    expect(isBackgroundLaunch(tool({ output: `satir\n\n${notice}` }))).toBe(true);
    expect(isBackgroundLaunch(tool({ output: "satir" }))).toBe(false);
  });
});
