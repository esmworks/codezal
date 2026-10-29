import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUserData, windowsDataRoot } from "./paths.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-paths-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("windowsDataRoot", () => {
  it("LOCALAPPDATA varsa oraya Codezal klasörü koyar", () => {
    expect(
      windowsDataRoot({ LOCALAPPDATA: join("C:", "Users", "e", "AppData", "Local") }, "bosta"),
    ).toBe(join("C:", "Users", "e", "AppData", "Local", "Codezal"));
  });

  it("yoksa mevcut köke düşer", () => {
    expect(windowsDataRoot({}, "C:\\fallback")).toBe("C:\\fallback");
    expect(windowsDataRoot({ LOCALAPPDATA: "   " }, "C:\\fallback")).toBe("C:\\fallback");
  });
});

describe("migrateUserData", () => {
  it("kaynağı hedefe taşır, kaynağı bırakmaz", () => {
    const root = tmp();
    const from = join(root, "Roaming", "Codezal");
    const to = join(root, "Local", "Codezal");
    mkdirSync(join(from, "sessions"), { recursive: true });
    writeFileSync(join(from, "sessions", "s.jsonl"), "satır");
    writeFileSync(join(from, "settings.json"), "{}");

    expect(migrateUserData(from, to)).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "sessions", "s.jsonl"), "utf8")).toBe("satır");
    expect(readFileSync(join(to, "settings.json"), "utf8")).toBe("{}");
  });

  it("önceki denemeden kalan geçici klasörü temizleyip taşır", () => {
    const root = tmp();
    const from = join(root, "Roaming", "Codezal");
    const to = join(root, "Local", "Codezal");
    mkdirSync(join(from, "sessions"), { recursive: true });
    writeFileSync(join(from, "a.txt"), "x");
    mkdirSync(`${to}.tmp`, { recursive: true });
    writeFileSync(join(`${to}.tmp`, "artik.txt"), "eski");

    expect(migrateUserData(from, to)).toBe(true);
    expect(existsSync(`${to}.tmp`)).toBe(false);
    expect(readFileSync(join(to, "a.txt"), "utf8")).toBe("x");
  });

  it("hedef doluysa dokunmaz", () => {
    const root = tmp();
    const from = join(root, "a");
    const to = join(root, "b");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "yeni.txt"), "yeni");
    expect(migrateUserData(from, to)).toBe(false);
    expect(readFileSync(join(to, "yeni.txt"), "utf8")).toBe("yeni");
  });

  it("kaynak yoksa false döner", () => {
    const root = tmp();
    expect(migrateUserData(join(root, "yok"), join(root, "hedef"))).toBe(false);
  });
});
