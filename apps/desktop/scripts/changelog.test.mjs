import { describe, expect, it } from "vitest";
import { closeUnreleased, isVersionHeading, plainifyNotes, sectionFor } from "./changelog.mjs";

const SAMPLE = `# Changelog

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/).

## [Unreleased]

### Added
- **Yeni şey**: ayrıntı.

## [1.0.0] - 2026-09-16

### Added
- **Eski şey**: ayrıntı.
`;

describe("closeUnreleased", () => {
  it("Unreleased bölümünü sürüm başlığına kapatır ve yeni boş bölüm açar", () => {
    const { text, empty } = closeUnreleased(SAMPLE, "1.0.1", "2026-09-17");
    expect(empty).toBe(false);
    expect(text).toContain("## [Unreleased]\n\n### Added\n\n## [1.0.1] - 2026-09-17");
    expect(text).toContain("- **Yeni şey**: ayrıntı.");
    // Kapanan bölüm ve eski sürümler yerinde kalır.
    expect(text).toContain("## [1.0.0] - 2026-09-16");
    expect(text).toContain("- **Eski şey**: ayrıntı.");
  });

  it("bölüm boşsa empty:true döner", () => {
    const emptySample = SAMPLE.replace("- **Yeni şey**: ayrıntı.\n", "");
    expect(closeUnreleased(emptySample, "1.0.1", "2026-09-17").empty).toBe(true);
  });

  it("Unreleased başlığı yoksa hata verir", () => {
    expect(() => closeUnreleased("# boş günlük\n", "1.0.1", "2026-09-17")).toThrow(/Unreleased/);
  });
});

describe("sectionFor", () => {
  it("sürüm bölümünün gövdesini çıkarır", () => {
    expect(sectionFor(SAMPLE, "1.0.0")).toBe("### Added\n- **Eski şey**: ayrıntı.");
  });

  it("olmayan sürümde null döner", () => {
    expect(sectionFor(SAMPLE, "9.9.9")).toBeNull();
  });

  it("Unreleased bölümünü de çıkarabilir", () => {
    expect(sectionFor(SAMPLE, "Unreleased")).toContain("Yeni şey");
  });
});

describe("plainifyNotes", () => {
  it("markdown başlıklarını kalın satıra indirir", () => {
    expect(plainifyNotes("### Added\n- madde\n#### Alt\nmetin")).toBe(
      "**Added**\n- madde\n**Alt**\nmetin",
    );
  });
});

describe("isVersionHeading", () => {
  it("sürüm başlıklarını tanır, eşleşmeyi doğrular", () => {
    expect(isVersionHeading("## [1.2.3] - 2026-09-16")).toBe(true);
    expect(isVersionHeading("## [1.2.3] - 2026-09-16", "1.2.3")).toBe(true);
    expect(isVersionHeading("## [1.2.3] - 2026-09-16", "1.2.4")).toBe(false);
    expect(isVersionHeading("## [Unreleased]")).toBe(false);
    expect(isVersionHeading("### Added")).toBe(false);
  });
});
