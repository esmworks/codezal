import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileLogger } from "./log";

const dir = mkdtempSync(join(tmpdir(), "cz-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("FileLogger", () => {
  it("satır yazar, seviyeyi ve kapsamı işler, anahtarı maskeler", () => {
    const log = new FileLogger(join(dir, "a"));
    log.info("app", "başladı");
    log.error("ipc:x", new Error("token sk-ant-1234567890abcdef kaçtı"));
    const text = readFileSync(log.path, "utf8");
    expect(text).toMatch(/INFO {2}\[app\] başladı/);
    expect(text).toContain("ERROR [ipc:x]");
    expect(text).not.toContain("sk-ant-1234567890abcdef");
  });

  it("5 MB'ı aşınca tek yedek tutar", () => {
    const log = new FileLogger(join(dir, "b"));
    writeFileSync(log.path, "x".repeat(5 * 1024 * 1024 + 1));
    log.info("app", "yeni");
    expect(readFileSync(log.path, "utf8")).toContain("yeni");
    expect(readFileSync(`${log.path}.1`, "utf8").length).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("debug satırı ayrı dosyaya yazılır ve kapalıyken hiç yazılmaz", () => {
    const log = new FileLogger(join(dir, "c"));
    log.debug("x", "kapalı");
    expect(existsSync(log.path)).toBe(false);
    expect(existsSync(log.debugPath)).toBe(false);

    log.setVerbose(true);
    log.debug("x", "açık");
    log.info("x", "bilgi");
    expect(readFileSync(log.debugPath, "utf8")).toContain("DEBUG [x] açık");
    // Bilgi satırı ana dosyada kalır; ayrıntılı dosya ana günlüğü kirletmez.
    expect(readFileSync(log.path, "utf8")).not.toContain("açık");
  });

  it("halka tampon son satırları tutar ve seviyeye göre süzülür", () => {
    const log = new FileLogger(join(dir, "d"));
    log.setVerbose(true);
    for (let i = 0; i < 600; i += 1) log.debug("x", `d${i}`);
    log.warn("x", "son uyarı");
    const all = log.tail();
    expect(all).toHaveLength(500);
    expect(all[all.length - 1]?.message).toBe("son uyarı");
    expect(all[0]?.message).not.toBe("d0");
    const warnings = log.tail(10, "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe("warn");
  });

  it("canlı akış abonelerine satır verir, abonelik kaldırılabilir", () => {
    const log = new FileLogger(join(dir, "e"));
    const seen: string[] = [];
    const off = log.subscribe((line) => seen.push(line.message));
    log.info("x", "bir");
    off();
    log.info("x", "iki");
    expect(seen).toEqual(["bir"]);
  });
});
