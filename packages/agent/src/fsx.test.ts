import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRetryableFsError, removeQuietly, retrySync, writeFileAtomic } from "./fsx.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codezal-fsx-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("içeriği yazar, üzerine yazar ve geçici dosya bırakmaz", () => {
    const dir = tmp();
    const file = join(dir, "alt", "ayar.json");
    writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    writeFileAtomic(file, '{"a":2}');
    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("removeQuietly", () => {
  it("ağacı siler, olmayan yolda sessiz kalır", () => {
    const dir = tmp();
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "f.txt"), "x");
    expect(removeQuietly(join(dir, "a"), { recursive: true })).toBe(true);
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(removeQuietly(join(dir, "yok"))).toBe(true);
  });
});

describe("retrySync", () => {
  it("geçici hatada yeniden dener, kalıcı hatada hemen durur", () => {
    let calls = 0;
    const value = retrySync(
      () => {
        calls += 1;
        if (calls < 2) throw Object.assign(new Error("meşgul"), { code: "EBUSY" });
        return "tamam";
      },
      3,
      1,
    );
    expect(value).toBe("tamam");
    expect(calls).toBe(2);

    let persistent = 0;
    expect(() =>
      retrySync(
        () => {
          persistent += 1;
          throw Object.assign(new Error("yok"), { code: "ENOENT" });
        },
        3,
        1,
      ),
    ).toThrow("yok");
    expect(persistent).toBe(1);
  });
});

describe("isRetryableFsError", () => {
  it("yalnız kilit hatalarını geçici sayar", () => {
    expect(isRetryableFsError({ code: "EBUSY" })).toBe(true);
    expect(isRetryableFsError({ code: "EPERM" })).toBe(true);
    expect(isRetryableFsError({ code: "ENOENT" })).toBe(false);
    expect(isRetryableFsError(new Error("kilit yok"))).toBe(false);
  });
});
