import { describe, expect, it } from "vitest";
import { AssistantContext } from "./settings.js";

describe("AssistantContext", () => {
  it("kopya alanı olmayan eski kaydı null ile okur", () => {
    const parsed = AssistantContext.parse({ kind: "file", value: "/a/rapor.pdf", label: "rapor" });
    expect(parsed.copy).toBeNull();
  });

  it("kopya yolunu ve zamanını korur", () => {
    const parsed = AssistantContext.parse({
      kind: "folder",
      value: "/a/Projeler",
      label: "Projeler",
      copy: { path: "/p/Bağlam/Projeler", copiedAt: 1234 },
    });
    expect(parsed.copy).toEqual({ path: "/p/Bağlam/Projeler", copiedAt: 1234 });
  });

  it("tanımsız türü reddeder", () => {
    expect(AssistantContext.safeParse({ kind: "url", value: "x", label: "x" }).success).toBe(false);
  });
});
