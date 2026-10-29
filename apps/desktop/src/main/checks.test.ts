import { describe, expect, it } from "vitest";
import { runChecks } from "./checks";

describe("runChecks", () => {
  it("komutları sırayla koşar, ilk hatada durur", async () => {
    const r = await runChecks(process.cwd(), ["echo merhaba", "exit 3", "echo asla"]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ ok: true, code: 0 });
    expect(r[0]?.output).toContain("merhaba");
    expect(r[1]).toMatchObject({ ok: false, code: 3 });
  }, 20_000);
});
