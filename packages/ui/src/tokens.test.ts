import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_NAMES } from "./index.js";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("tokens.css", () => {
  it("her token koyu ve açık temada tanımlı", () => {
    for (const name of TOKEN_NAMES) {
      const matches = css.match(new RegExp(`--${name}:`, "g")) ?? [];
      expect(matches.length, name).toBeGreaterThanOrEqual(2);
    }
  });
});
