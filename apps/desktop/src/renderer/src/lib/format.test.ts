import { describe, expect, it } from "vitest";
import {
  basename,
  formatDuration,
  formatElapsed,
  formatTokens,
  formatUsd,
  greeting,
  shortAgo,
  worktreeParent,
} from "./format";

const now = Date.now();

describe("shortAgo", () => {
  it("türkçe birimler kullanır", () => {
    expect(shortAgo(now - 3_000, "tr", now)).toBe("şimdi");
    expect(shortAgo(now - 5 * 60_000, "tr", now)).toBe("5dk");
    expect(shortAgo(now - 3 * 3_600_000, "tr", now)).toBe("3sa");
    expect(shortAgo(now - 4 * 86_400_000, "tr", now)).toBe("4g");
    expect(shortAgo(now - 70 * 86_400_000, "tr", now)).toBe("2ay");
  });

  it("ingilizce birimler kullanır", () => {
    expect(shortAgo(now - 3_000, "en", now)).toBe("now");
    expect(shortAgo(now - 5 * 60_000, "en", now)).toBe("5m");
    expect(shortAgo(now - 3 * 3_600_000, "en", now)).toBe("3h");
    expect(shortAgo(now - 4 * 86_400_000, "en", now)).toBe("4d");
    expect(shortAgo(now - 70 * 86_400_000, "en", now)).toBe("2mo");
  });
});

describe("formatTokens", () => {
  it("ondalık ayracını dile göre seçer", () => {
    expect(formatTokens(1_200_000, "tr")).toBe("1,2M");
    expect(formatTokens(1_200_000, "en")).toBe("1.2M");
    expect(formatTokens(2_300, "tr")).toBe("2,3K");
    expect(formatTokens(2_300, "en")).toBe("2.3K");
    expect(formatTokens(512, "en")).toBe("512");
  });
});

describe("formatDuration", () => {
  it("birimleri dile göre seçer", () => {
    expect(formatDuration(500, "tr")).toBe("500 ms");
    expect(formatDuration(500, "en")).toBe("500 ms");
    expect(formatDuration(15_500, "tr")).toBe("15,5 sn");
    expect(formatDuration(15_500, "en")).toBe("15.5 s");
    expect(formatDuration(150_000, "tr")).toBe("2 dk 30 sn");
    expect(formatDuration(150_000, "en")).toBe("2 min 30 s");
  });
});

describe("formatElapsed", () => {
  it("sayaç olarak tam saniye verir", () => {
    expect(formatElapsed(16_400, "tr")).toBe("16 sn");
    expect(formatElapsed(16_400, "en")).toBe("16 s");
    expect(formatElapsed(93_000, "tr")).toBe("1 dk 33 sn");
    expect(formatElapsed(93_000, "en")).toBe("1 min 33 s");
  });

  it("saniye altını ve eksi farkı sıfırlar", () => {
    expect(formatElapsed(400, "tr")).toBe("0 sn");
    expect(formatElapsed(-5_000, "tr")).toBe("0 sn");
  });
});

describe("greeting", () => {
  it("saate göre selamlar, isim ekler", () => {
    expect(greeting("tr", undefined, new Date(2026, 0, 1, 3))).toBe("İyi geceler");
    expect(greeting("tr", "Erhan", new Date(2026, 0, 1, 9))).toBe("Günaydın, Erhan");
    expect(greeting("en", "Erhan", new Date(2026, 0, 1, 9))).toBe("Good morning, Erhan");
    expect(greeting("en", undefined, new Date(2026, 0, 1, 20))).toBe("Good evening");
  });
});

describe("formatUsd", () => {
  it("dolar biçimini dile göre ayırır", () => {
    expect(formatUsd(0.0123, "tr")).toBe("$0,012");
    expect(formatUsd(0.0123, "en")).toBe("$0.012");
    expect(formatUsd(12.5, "tr")).toBe("$12,50");
    expect(formatUsd(12.5, "en")).toBe("$12.50");
    expect(formatUsd(0, "tr")).toBe("$0,00");
  });
});

describe("basename", () => {
  it("yoldan son parçayı döndürür", () => {
    expect(basename("a/b/c.txt")).toBe("c.txt");
    expect(basename("/kok/")).toBe("kok");
    expect(basename("C:\\Users\\e\\rapor.md")).toBe("rapor.md");
  });
});

describe("worktreeParent", () => {
  it("varsayılan kökteki worktree'nin projesini döndürür", () => {
    expect(worktreeParent("/p/app/.worktrees/cz-calm-yak")).toBe("/p/app");
    expect(worktreeParent("/p/app/.worktrees/cz-calm-yak/")).toBe("/p/app");
    expect(worktreeParent("C:\\p\\app\\.worktrees\\dal")).toBe("C:\\p\\app");
  });
  it("worktree olmayan yolda null döner", () => {
    expect(worktreeParent("/p/app")).toBeNull();
    expect(worktreeParent("/p/app/.worktrees")).toBeNull();
    expect(worktreeParent("/p/app/.worktrees/dal/src")).toBeNull();
    expect(worktreeParent("/.worktrees/dal")).toBeNull();
  });
});
