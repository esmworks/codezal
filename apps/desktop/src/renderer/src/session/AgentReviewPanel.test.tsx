import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import type { AgentRunRow } from "../stores/agentRuns";
import { AgentReviewCard } from "./AgentReviewPanel";

const run = (over: Partial<AgentRunRow>): AgentRunRow => ({
  id: "run-1",
  parentSessionId: "s1",
  cwd: "/repo",
  agent: "general",
  title: "bol.js hatasını düzelt",
  task: "Çalışma klasörü: /repo Görev: bol.js dosyasını düzelt",
  status: "review",
  isolated: true,
  background: false,
  worktree: "/repo/.worktrees/ajan-bol-js",
  sessionId: "child-1",
  createdAt: 1,
  stepsDone: 3,
  stepsTotal: 3,
  error: null,
  ...over,
});

describe("sohbetteki inceleme kartı", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("tr");
  });

  // Statik çizim depo durumunu okumaz (sunucu anlık görüntüsü); kart tek koşuyla çizilir.
  it("karar düğmeleriyle çizilir, ham görev istemi görünmez", () => {
    const html = renderToStaticMarkup(
      <AgentReviewCard sessionId="s1" run={run({ files: ["bol.js"] })} />,
    );
    expect(html).toContain("Ajanın değişikliği incelemede");
    expect(html).toContain("bol.js hatasını düzelt");
    expect(html).toContain("1 dosya değişti");
    expect(html).toContain("Uygula");
    expect(html).toContain("İncele");
    expect(html).toContain("Sil");
    expect(html).not.toContain("Çalışma klasörü");
  });

  // Ardışık onaylarda kart tıklanan yere kayabiliyor: ilk düğme zararsız, kararlar geç açılır.
  it("ilk düğme İncele'dir, Uygula ve Sil ilk çizimde kapalıdır", () => {
    const html = renderToStaticMarkup(
      <AgentReviewCard sessionId="s1" run={run({ files: ["bol.js"] })} />,
    );
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => ({
      disabled: /disabled=""/.test(m[1] ?? ""),
      text: (m[2] ?? "").replace(/<[^>]+>/g, "").trim(),
    }));
    expect(buttons.map((b) => b.text)).toEqual(["İncele", "Uygula", "Sil"]);
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, true]);
  });
});
