import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureUserPathOnEnv,
  extractSentinelPath,
  mergePath,
  PATH_BEGIN,
  PATH_END,
} from "./path-env.js";

const joinPath = (...parts: string[]): string => parts.join(delimiter);

describe("mergePath", () => {
  it("kabuk PATH'ini önce, mevcut PATH'i sonra ekler ve tekrarları atar", () => {
    expect(mergePath(joinPath("/a", "/b"), joinPath("/b", "/c"))).toBe(joinPath("/a", "/b", "/c"));
  });

  it("yedek dizinleri en sona koyar", () => {
    expect(mergePath(joinPath("/a"), joinPath("/b"), ["/yedek"])).toBe(
      joinPath("/a", "/b", "/yedek"),
    );
  });

  it("boş parçaları atar, sondaki ayraçları normalleştirir", () => {
    expect(mergePath("/a/", "", ["", "/x/"])).toBe(joinPath("/a", "/x"));
  });

  it("kabuk PATH'i yoksa mevcut PATH korunur", () => {
    expect(mergePath(undefined, joinPath("/usr/bin", "/bin"))).toBe(joinPath("/usr/bin", "/bin"));
  });
});

describe("extractSentinelPath", () => {
  it("sentinel arasındaki PATH'i döndürür, profil gürültüsünü yok sayar", () => {
    const stdout = `conda: base aktif\n${PATH_BEGIN}/nvm/bin:/usr/bin${PATH_END}\n`;
    expect(extractSentinelPath(stdout)).toBe(joinPath("/nvm/bin", "/usr/bin"));
  });

  it("sentinel yoksa undefined döner", () => {
    expect(extractSentinelPath("warning: foo: bar")).toBeUndefined();
  });

  it("boş PATH undefined sayılır, tek girdili PATH kabul edilir", () => {
    expect(extractSentinelPath(`${PATH_BEGIN}${PATH_END}`)).toBeUndefined();
    expect(extractSentinelPath(`${PATH_BEGIN}/only/bin${PATH_END}`)).toBe("/only/bin");
  });
});

describe("ensureUserPathOnEnv", () => {
  it("kabuk PATH'i ile mevcut PATH'i birleştirir", () => {
    const env: NodeJS.ProcessEnv = { PATH: joinPath("/usr/bin", "/bin") };
    ensureUserPathOnEnv(env, {
      shell: "/bin/zsh",
      shellPath: () => joinPath("/nvm/bin", "/usr/bin"),
      dirs: [],
    });
    expect(env.PATH).toBe(joinPath("/nvm/bin", "/usr/bin", "/bin"));
  });

  it("kabuk çözülemezse yalnız var olan yedek dizinleri sona ekler", () => {
    const dir = mkdtempSync(join(tmpdir(), "codezal-path-"));
    try {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      ensureUserPathOnEnv(env, {
        shell: "/bin/zsh",
        shellPath: () => undefined,
        dirs: [dir, join(dir, "yok")],
      });
      expect(env.PATH).toBe(joinPath("/usr/bin", dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
