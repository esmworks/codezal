import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureHooksFile, hooksFilePath, loadHooks } from "./hooks";
import { configPath, readProjectConfig } from "./project-local";

const root = mkdtempSync(join(tmpdir(), "cz-hooks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dir(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("hook yükleyicisi", () => {
  it("genel hooks.json'u kaynak yoluyla okur", () => {
    const userData = dir("ud-genel");
    writeJson(hooksFilePath(userData), {
      PreToolUse: [{ matcher: "bash", command: "./guard.sh", timeoutSec: 5 }],
      PostToolUse: [{ command: "echo bitti" }],
    });
    const hooks = loadHooks(userData, undefined, false);
    expect(hooks).toEqual([
      {
        event: "PreToolUse",
        matcher: "bash",
        command: "./guard.sh",
        timeoutSec: 5,
        source: hooksFilePath(userData),
      },
      { event: "PostToolUse", matcher: "", command: "echo bitti", source: hooksFilePath(userData) },
    ]);
  });

  it("güvenilen projede iki ayar dosyasının hook'larını birleştirir", () => {
    const userData = dir("ud-proje");
    const cwd = dir("proje");
    writeJson(configPath(cwd, false), {
      permission: "ask",
      hooks: { PreToolUse: [{ matcher: "edit|write", command: "ekip.sh" }] },
    });
    writeJson(configPath(cwd, true), {
      hooks: { PreToolUse: [{ matcher: "", command: "kisisel.sh" }] },
    });
    const hooks = loadHooks(userData, cwd, true);
    // Yerel dosya ekibinkini ezmez: ikisi de çalışır, sıra ekip → kişisel.
    expect(hooks.map((h) => [h.command, h.source])).toEqual([
      ["ekip.sh", configPath(cwd, false)],
      ["kisisel.sh", configPath(cwd, true)],
    ]);
  });

  it("güvenilmeyen projenin hook'unu okumaz", () => {
    const userData = dir("ud-guvensiz");
    const cwd = dir("guvensiz");
    writeJson(configPath(cwd, false), { hooks: { PreToolUse: [{ command: "kotu.sh" }] } });
    expect(loadHooks(userData, cwd, false)).toEqual([]);
  });

  it("bozuk dosya ve şema atlanır, diğer kaynaklar okunur", () => {
    const userData = dir("ud-bozuk");
    mkdirSync(userData, { recursive: true });
    writeFileSync(hooksFilePath(userData), "{ bozuk", "utf8");
    const cwd = dir("bozuk-proje");
    writeJson(configPath(cwd, false), {
      hooks: { PreToolUse: [{ matcher: "bash", command: "" }] },
    });
    writeJson(configPath(cwd, true), { hooks: { PostToolUse: [{ command: "iyi.sh" }] } });
    expect(loadHooks(userData, cwd, true).map((h) => h.command)).toEqual(["iyi.sh"]);
  });

  it("bozuk hooks alanı proje varsayılanlarını düşürmez", () => {
    const cwd = dir("bozuk-alan");
    writeJson(configPath(cwd, false), {
      permission: "full",
      hooks: { PreToolUse: "yanlış" },
    });
    expect(readProjectConfig(cwd).permission).toBe("full");
  });

  it("ensureHooksFile boş iskelet oluşturur, var olana dokunmaz", () => {
    const userData = dir("ud-iskelet");
    const path = ensureHooksFile(userData);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ PreToolUse: [], PostToolUse: [] });
    writeFileSync(path, '{"PreToolUse":[{"command":"x"}]}', "utf8");
    ensureHooksFile(userData);
    expect(readFileSync(path, "utf8")).toContain('"x"');
  });
});
