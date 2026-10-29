import type { SkillCatalog } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { skillSuggestions, withMentions } from "./skills";

describe("withMentions", () => {
  it("yolları taslağa ekler, sondaki tek `@` yerine yazar", () => {
    // Boşluklu yol tırnaklanır: tırnaksız bahis ilk boşlukta biterdi.
    expect(withMentions("@", ["/a b"])).toBe('@"/a b" ');
    expect(withMentions("düzelt ", ["/x"])).toBe("düzelt @/x ");
    expect(withMentions("", ["/x", "/y"])).toBe("@/x @/y ");
  });
});

describe("skillSuggestions", () => {
  const catalog: SkillCatalog = {
    skills: [
      {
        name: "tdd",
        description: "Test önce",
        path: "/s/tdd/SKILL.md",
        baseDir: "/s/tdd",
        scope: "user",
        source: "auto",
        enabled: true,
        hidden: false,
      },
      {
        name: "kapali",
        description: "Kapalı beceri",
        path: "/s/k/SKILL.md",
        baseDir: "/s/k",
        scope: "user",
        source: "auto",
        enabled: false,
        hidden: false,
      },
    ],
    sources: [],
    diagnostics: [],
    ownSkillsDir: "/pi/skills",
  };

  it("yalnızca açık becerileri satıra çevirir", () => {
    const items = skillSuggestions(catalog);
    expect(items.map((i) => i.value)).toEqual(["/skill:tdd"]);
    expect(items.map((i) => i.kind)).toEqual(["skill"]);
    expect(skillSuggestions(null)).toEqual([]);
  });

  it("beceri satırında yalnız ad görünür, seçim kendiliğinden çalışmaz", () => {
    const [skill] = skillSuggestions(catalog);
    expect(skill?.label).toBe("tdd");
    expect(skill?.runOnPick).toBe(false);
  });
});
