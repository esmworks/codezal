import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bumpScript = resolve(import.meta.dirname, "..", "..", "..", "scripts", "bump-version.mjs");
let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function scaffold() {
  root = mkdtempSync(join(tmpdir(), "codezal-bump-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: "1.0.2" }, null, 2)}\n`);
  mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  writeFileSync(
    join(root, "apps", "desktop", "package.json"),
    `${JSON.stringify({ version: "1.0.2" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n### Added\n- madde\n",
  );
}

describe("bump-version", () => {
  it("iki package.json'u yazar ve CHANGELOG bölümünü kapatır", () => {
    scaffold();
    const run = spawnSync(process.execPath, [bumpScript, "1.0.3"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.0.3");
    expect(
      JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version,
    ).toBe("1.0.3");
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[1\.0\.3\] - \d{4}-\d{2}-\d{2}/);
    expect(changelog).toContain("## [Unreleased]\n\n### Added\n\n## [1.0.3]");
    expect(changelog).toContain("- madde");
  });

  it("geçersiz sürümde yazmadan durur", () => {
    scaffold();
    const run = spawnSync(process.execPath, [bumpScript, "sürüm-değil"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.0.2");
  });

  it("boş Unreleased bölümünde uyarır ama kapatır", () => {
    scaffold();
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.9.0] - 2026-09-01\n",
    );
    const run = spawnSync(process.execPath, [bumpScript, "1.0.3"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).toMatch(/bölümü boştu/);
  });
});
