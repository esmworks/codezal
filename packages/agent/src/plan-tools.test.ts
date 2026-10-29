import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PlanDecision, PlanReview } from "@codezal/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlanBridge, PlanReviewGate, planTools, unresolvedQuestions } from "./plan-tools.js";

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

function fakeBridge(init: {
  mode?: PermissionMode;
  path?: string | undefined;
  decision?: PlanDecision;
}) {
  const state = { mode: init.mode ?? "ask", entered: 0, reviewed: [] as string[] };
  const bridge: PlanBridge = {
    mode: () => state.mode,
    planPath: () => init.path,
    enter: () => {
      state.entered += 1;
      state.mode = "plan";
    },
    review: async (plan) => {
      state.reviewed.push(plan);
      const d = init.decision ?? { approved: true };
      if (d.approved) state.mode = "auto-edit";
      return d;
    },
  };
  return { bridge, state };
}

const run = (tool: ReturnType<typeof planTools>[number]) =>
  tool.execute("t1", {}, undefined, undefined, {} as never);

describe("PlanReviewGate", () => {
  it("isteği yayınlar, cevapla çözülür ve bekleyenlerden düşer", async () => {
    let review: PlanReview | undefined;
    const gate = new PlanReviewGate((r) => {
      review = r;
    });
    const p = gate.request("s1", "# Plan", "/p/s1.md", "auto-edit");
    expect(review).toMatchObject({ sessionId: "s1", plan: "# Plan", returnTo: "auto-edit" });
    expect(gate.pendingFor("s1")?.requestId).toBe(review?.requestId);
    expect(gate.respond(review?.requestId ?? "", { approved: true })).toBe(true);
    await expect(p).resolves.toEqual({ approved: true });
    expect(gate.pendingFor("s1")).toBeUndefined();
    expect(gate.respond("yok", { approved: true })).toBe(false);
  });

  it("iptalde oturumun bekleyenleri geri bildirimle reddedilir", async () => {
    const gate = new PlanReviewGate(() => {});
    const a = gate.request("s1", "a", "/a.md", "ask");
    const b = gate.request("s2", "b", "/b.md", "ask");
    gate.rejectAll("s1", "iptal");
    await expect(a).resolves.toEqual({ approved: false, feedback: "iptal" });
    expect(gate.pendingFor("s2")).toBeDefined();
    gate.rejectAll("s2");
    await expect(b).resolves.toEqual({ approved: false });
  });
});

describe("unresolvedQuestions", () => {
  it("açık soru bölümünü, işaretsiz maddeyi ve soru satırını yakalar", () => {
    const plan = [
      "# Plan",
      "",
      "## Açık sorular",
      "- www mi, non-www mi?",
      "5. TBD",
      "",
      "## Adımlar",
      "1. Dizini kopyala",
      "- [ ] yasal metinleri taşı",
    ].join("\n");
    const found = unresolvedQuestions(plan);
    expect(found).toContain("## Açık sorular");
    expect(found).toContain("- www mi, non-www mi?");
    expect(found).toContain("5. TBD");
    expect(found).toContain("- [ ] yasal metinleri taşı");
    // Başlık altındaki bölüm kapanır: "Adımlar" maddeleri soru sayılmaz.
    expect(found).not.toContain("1. Dizini kopyala");
  });

  it("boş sözde bölümü ve temiz planı soru saymaz", () => {
    expect(unresolvedQuestions("# Plan\n\n## Açık sorular\nYok.\n")).toEqual(["## Açık sorular"]);
    expect(
      unresolvedQuestions("# Plan\n\n## Kararlar\n- Renk: petrol\n\n## Adımlar\n1. Uygula\n"),
    ).toEqual([]);
  });
});

describe("plan_enter / plan_exit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cz-plan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("plan_enter plana geçer ve dosya yolunu bildirir; ikinci çağrı yalnızca hatırlatır", async () => {
    const path = join(dir, "s1.md");
    const { bridge, state } = fakeBridge({ path });
    const [enter] = planTools(bridge);
    const first = textOf(await run(enter));
    expect(state.mode).toBe("plan");
    expect(first).toContain("Plan moduna geçildi");
    expect(first).toContain(path);
    const second = textOf(await run(enter));
    expect(second).toContain("Zaten plan modundasın");
    expect(state.entered).toBe(1);
  });

  it("plan klasörü yoksa araçlar kapalı olduğunu söyler", async () => {
    const { bridge, state } = fakeBridge({ path: undefined });
    const [enter, exit] = planTools(bridge);
    expect(textOf(await run(enter))).toContain("kapalı");
    expect(state.mode).toBe("ask");
    state.mode = "plan";
    expect(textOf(await run(exit))).toContain("kapalı");
  });

  it("plan_exit plan modunda değilken ve dosya boşken uyarır", async () => {
    const path = join(dir, "s1.md");
    const { bridge, state } = fakeBridge({ path });
    const [, exit] = planTools(bridge);
    expect(textOf(await run(exit))).toContain("Plan modunda değilsin");
    state.mode = "plan";
    expect(textOf(await run(exit))).toContain(path);
    expect(state.reviewed).toEqual([]);
  });

  it("plan açık soru taşıyorsa onaya sunulmaz; temizlenince sunulur", async () => {
    const path = join(dir, "s1.md");
    writeFileSync(path, "# Plan\n\n## Açık sorular\n- www tercihi ne olsun?\n", "utf8");
    const { bridge, state } = fakeBridge({ mode: "plan", path });
    const [, exit] = planTools(bridge);
    const blocked = await run(exit);
    expect(textOf(blocked)).toContain("çözülmemiş soru");
    expect(textOf(blocked)).toContain("www tercihi ne olsun?");
    expect(state.reviewed).toEqual([]);
    writeFileSync(path, "# Plan\n\n## Kararlar\n- www tercihi: 3esogutma.com\n", "utf8");
    const ok = await run(exit);
    expect(ok.details).toEqual({ approved: true });
    expect(state.reviewed).toHaveLength(1);
  });

  it("onaylanan plan dönülen modu bildirir, reddedilen geri bildirimi taşır", async () => {
    const path = join(dir, "s1.md");
    writeFileSync(path, "# Plan\n\n1. adım\n", "utf8");
    const ok = fakeBridge({ mode: "plan", path });
    const [, exitOk] = planTools(ok.bridge);
    const approved = await run(exitOk);
    expect(textOf(approved)).toContain("Otomatik düzenle");
    expect(approved.details).toEqual({ approved: true });
    expect(ok.state.reviewed).toEqual(["# Plan\n\n1. adım"]);

    const no = fakeBridge({
      mode: "plan",
      path,
      decision: { approved: false, feedback: "testleri de ekle" },
    });
    const [, exitNo] = planTools(no.bridge);
    const rejected = await run(exitNo);
    expect(textOf(rejected)).toContain("testleri de ekle");
    expect(textOf(rejected)).toContain("plan_exit");
    expect(no.state.mode).toBe("plan");

    const silent = fakeBridge({ mode: "plan", path, decision: { approved: false } });
    const [, exitSilent] = planTools(silent.bridge, "en");
    expect(textOf(await run(exitSilent))).toContain("(no reason given)");
  });

  it("iptal edilen plan geri bildirim istemez, plan modu değişmez", async () => {
    const path = join(dir, "s1.md");
    writeFileSync(path, "# Plan\n\n1. adım\n", "utf8");
    const { bridge, state } = fakeBridge({
      mode: "plan",
      path,
      decision: { approved: false, cancelled: true },
    });
    const [, exit] = planTools(bridge);
    const res = await run(exit);
    expect(res.details).toEqual({ approved: false, cancelled: true });
    expect(textOf(res)).toContain("iptal etti");
    expect(textOf(res)).not.toContain("plan_exit çağır");
    expect(state.mode).toBe("plan");
  });
});
