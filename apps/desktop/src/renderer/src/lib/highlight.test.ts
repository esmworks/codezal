import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, highlight, langForFence, langForPath } from "./highlight";

describe("langForPath", () => {
  it("uzantıdan dili bulur", () => {
    expect(langForPath("/p/src/app/layout.tsx")).toBe("tsx");
    expect(langForPath("/p/pnpm-workspace.yaml")).toBe("yaml");
    expect(langForPath("/p/scripts/run.sh")).toBe("shellscript");
    expect(langForPath("/p/README.md")).toBe("markdown");
  });
  it("özel dosya adlarını tanır", () => {
    expect(langForPath("/p/Dockerfile")).toBe("dockerfile");
    expect(langForPath("/p/.env.example")).toBe("dotenv");
    expect(langForPath("/p/.gitignore")).toBe("ini");
  });
  it("bilinmeyen uzantıda null döner", () => {
    expect(langForPath("/p/veri.bin")).toBeNull();
    expect(langForPath("/p/LICENSE")).toBeNull();
  });
});

describe("langForFence", () => {
  it("takma adları çözer", () => {
    expect(langForFence("ts")).toBe("typescript");
    expect(langForFence("bash")).toBe("shellscript");
    expect(langForFence("Python")).toBe("python");
  });
  it("düz metin ve bilinmeyen dilde null döner", () => {
    expect(langForFence("")).toBeNull();
    expect(langForFence("text")).toBeNull();
    expect(langForFence("olmayan-dil")).toBeNull();
  });
});

describe("highlight", () => {
  it("TSX kodunu satır satır renkli belirteçlere ayırır", async () => {
    const code = 'import { x } from "y";\n\nconst n: number = 1;';
    const lines = await highlight(code, "tsx", false);
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(3);
    const first = lines?.[0] ?? [];
    // Satır metni korunur
    expect(first.map((t) => t.text).join("")).toBe('import { x } from "y";');
    // En az bir belirteç ön renkten farklı renk alır (anahtar sözcük veya dize)
    expect(first.some((t) => t.color)).toBe(true);
  });
  it("açık ve koyu tema farklı renk üretir", async () => {
    const code = "const a = 1;";
    const dark = await highlight(code, "typescript", false);
    const light = await highlight(code, "typescript", true);
    const kwDark = dark?.[0]?.find((t) => t.text.trim() === "const")?.color;
    const kwLight = light?.[0]?.find((t) => t.text.trim() === "const")?.color;
    expect(kwDark).toBeTruthy();
    expect(kwLight).toBeTruthy();
    expect(kwDark).not.toBe(kwLight);
  });
  it("çok büyük kodda null döner", async () => {
    const big = "x".repeat(HIGHLIGHT_MAX_CHARS + 1);
    expect(await highlight(big, "typescript", false)).toBeNull();
  });
});
