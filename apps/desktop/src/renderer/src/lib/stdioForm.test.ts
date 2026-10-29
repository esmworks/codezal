import { describe, expect, it } from "vitest";
import { parseEnvLines, splitArgs } from "./stdioForm";

describe("splitArgs", () => {
  it("boşluktan böler, tırnaklı parçayı tek argüman tutar", () => {
    expect(splitArgs("-y @modelcontextprotocol/server-filesystem /tmp")).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(splitArgs(`--root "/Users/a b/Belgeler" 'tek tırnak'`)).toEqual([
      "--root",
      "/Users/a b/Belgeler",
      "tek tırnak",
    ]);
    expect(splitArgs(`--x "a \\"b\\"" ""`)).toEqual(["--x", 'a "b"', ""]);
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("parseEnvLines", () => {
  it("AD=değer satırlarını okur, yorum ve boş satırı atlar, geçersizleri ayırır", () => {
    const r = parseEnvLines("GITHUB_TOKEN=abc=def\n# yorum\n\nbozuk satır\n1AD=x\n DEBUG = 1");
    expect(r.env).toEqual({ GITHUB_TOKEN: "abc=def", DEBUG: " 1" });
    expect(r.invalid).toEqual(["bozuk satır", "1AD=x"]);
  });
});
