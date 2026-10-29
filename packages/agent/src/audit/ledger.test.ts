import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CoverageUnit } from "@codezal/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLedger,
  computeSourceRef,
  filterByScope,
  listSourceFiles,
  packsFor,
  selectPacks,
  surfaceOf,
} from "./ledger.js";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-audit-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, rel: string, text = "export const x = 1;\n"): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const SAMPLE: Array<[string, string]> = [
  ["apps/desktop/src/main/ipc/skills.ts", "export const a = 1;\n"],
  ["apps/desktop/src/main/window.ts", "export const b = 1;\n"],
  ["apps/desktop/src/preload/index.ts", "export const c = 1;\n"],
  ["apps/desktop/src/renderer/src/session/ToolCard.tsx", "export const d = 1;\n"],
  ["packages/agent/src/engine.ts", "export const e = 1;\n"],
  ["packages/agent/src/limit.ts", "export const f = 1;\n"],
  ["packages/contracts/src/ipc.ts", "export const g = 1;\n"],
  [".github/workflows/release.yml", "name: release\n"],
  ["package.json", "{}\n"],
];

function sample(root: string): string[] {
  for (const [rel, text] of SAMPLE) write(root, rel, text);
  return listSourceFiles(root);
}

describe("kapsam defteri", () => {
  it("dosyaları deterministik sırada ve süzerek listeler", () => {
    const root = tmp();
    write(root, "node_modules/x/index.js");
    write(root, "dist/bundle.js");
    write(root, "src/a.ts");
    write(root, "logo.png", "x");
    const files = listSourceFiles(root);
    expect(files).toEqual(["src/a.ts"]);
  });

  it("yüzey ve saldırı sınıfı eşlemesi kararlı", () => {
    expect(surfaceOf("apps/desktop/src/main/ipc/skills.ts")).toBe("main");
    expect(surfaceOf("packages/agent/src/engine.ts")).toBe("agent");
    expect(surfaceOf(".github/workflows/release.yml")).toBe("ci");
    expect(surfaceOf("package.json")).toBe("root");
    expect(packsFor("package.json")).toContain("supply-chain");
    expect(packsFor("packages/agent/src/engine.ts")).toContain("ai-and-llm");
    expect(packsFor("apps/desktop/src/renderer/src/a.tsx")).toContain("client-side");
    expect(packsFor("bilinmeyen/foo.xyz")).toEqual(["core"]);
  });

  it("aynı girdi her zaman aynı birim kimliklerini üretir", () => {
    const root = tmp();
    const files = sample(root);
    const packs = selectPacks(files);
    expect(packs).toContain("desktop-local-ipc");
    expect(packs).toContain("supply-chain");
    const first = buildLedger({ sourceRef: "s1", profile: "standard", files, now: 1 });
    const second = buildLedger({
      sourceRef: "s1",
      profile: "standard",
      files: [...files].reverse(),
      now: 2,
    });
    expect(first.ledger.units.map((u) => u.id)).toEqual(second.ledger.units.map((u) => u.id));
    expect(first.ledger.units.length).toBeGreaterThan(1);
  });

  it("profil birim kapsamını kabalaştırır", () => {
    const root = tmp();
    const files = sample(root);
    const quick = buildLedger({ sourceRef: "s1", profile: "quick", files, now: 1 });
    const standard = buildLedger({ sourceRef: "s1", profile: "standard", files, now: 1 });
    const deep = buildLedger({ sourceRef: "s1", profile: "deep", files, now: 1 });
    expect(quick.ledger.units.every((u) => u.surface === "all")).toBe(true);
    expect(quick.ledger.units.length).toBeLessThan(standard.ledger.units.length);
    expect(deep.ledger.units.length).toBeGreaterThanOrEqual(standard.ledger.units.length);
    expect(deep.ledger.units.some((u) => u.surface === "main/ipc")).toBe(true);
  });

  it("kapsam yollarına göre dosya süzer", () => {
    const files = ["apps/desktop/src/main/a.ts", "packages/agent/b.ts"];
    expect(filterByScope(files, ["apps/desktop/src/main"])).toEqual(["apps/desktop/src/main/a.ts"]);
    expect(filterByScope(files, [])).toEqual(files);
  });

  it("önceki run'ın kapattığı birimi devralır, kaynak değişince düşürür", () => {
    const root = tmp();
    const files = sample(root);
    const first = buildLedger({ sourceRef: "s1", profile: "quick", files, now: 1 });
    const base = first.ledger.units[0];
    if (!base) throw new Error("birim üretilmedi");
    const covered: CoverageUnit = {
      ...base,
      status: "covered",
      fingerprint: "f1",
      foundBy: "hunter-1",
      verifiedBy: "verifier-1",
    };
    const inherited = buildLedger({
      sourceRef: "s1",
      profile: "quick",
      files,
      previous: { ...first.ledger, units: [covered] },
      now: 2,
    });
    expect(inherited.ledger.units[0]?.status).toBe("covered");
    expect(inherited.ledger.units[0]?.verifiedBy).toBe("verifier-1");

    const stale = buildLedger({
      sourceRef: "s2",
      profile: "quick",
      files,
      previous: { ...first.ledger, units: [covered] },
      now: 3,
    });
    expect(stale.ledger.units[0]?.status).toBe("planned");
    expect(stale.ledger.units[0]?.note).toContain("kaynak");
  });

  it("git yoksa kaynak sürümü dosya özetinden gelir", () => {
    const root = tmp();
    write(root, "src/a.ts", "export const a = 1;\n");
    const first = computeSourceRef(root, ["src/a.ts"]);
    expect(first.startsWith("nogit:")).toBe(true);
    const again = computeSourceRef(root, ["src/a.ts"]);
    expect(again).toBe(first);
  });
});
