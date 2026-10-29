import type { BackgroundJob, SubagentRun } from "@codezal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { StatusBox } from "./StatusBox";

/**
 * Durum kartı (ZCode'un durum paneli): Terminaller ve Ajanlar bölümleri aynı satır biçimini
 * paylaşır. Statik çizim kullanılır (gerçek DOM yok): saat ve katlanma efektleri çalışmaz.
 */
function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "bg-1",
    command: "pnpm dev",
    status: "running",
    startedAt: Date.now() - 72_000,
    ...over,
  };
}

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "sub-1",
    kind: "explore",
    label: "izin kapısı nerede",
    status: "running",
    startedAt: Date.now() - 5_000,
    ...over,
  } as SubagentRun;
}

function draw(backgrounds: BackgroundJob[], subagents: SubagentRun[] = []): string {
  return renderToStaticMarkup(
    <StatusBox sessionId="s1" backgrounds={backgrounds} subagents={subagents} />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("tr");
});

describe("durum kartı", () => {
  it("süren komutu sayaç ve Durdur düğmesiyle Terminaller bölümünde çizer", () => {
    const html = draw([job()]);
    expect(html).toContain("Terminaller");
    expect(html).toContain("1 arka planda");
    expect(html).toContain("pnpm dev");
    expect(html).toContain("süredir çalışıyor");
    expect(html).toContain("Durdur");
    expect(html).toContain("Çıktıyı gör: pnpm dev");
  });

  it("biten komutta Durdur yerine çıkış kodunu yazar", () => {
    const html = draw([job({ status: "exited", code: 0, endedAt: Date.now() })]);
    expect(html).toContain("çıkış 0");
    expect(html).not.toContain("Durdur");
  });

  it("ajan satırı terminal satırıyla aynı biçimde çizilir", () => {
    const html = draw([job()], [run()]);
    expect(html).toContain("Ajanlar");
    expect(html).toContain("1 çalışıyor");
    expect(html).toContain("izin kapısı nerede");
    // Keşif durdurulabilir: iki satırda da Durdur ve sayaç var.
    expect(html.match(/Durdur/g)).toHaveLength(2);
    expect(html.match(/süredir çalışıyor/g)).toHaveLength(2);
    // İkinci bölüm ayraçla ayrılır.
    expect(html).toContain("border-t border-line pt-1");
  });

  it("yalnız ajan varsa Terminaller bölümü çizilmez", () => {
    const html = draw([], [run()]);
    expect(html).not.toContain("Terminaller");
    expect(html).not.toContain("border-t border-line pt-1");
  });

  it("iş yoksa çizilmez", () => {
    expect(draw([])).toBe("");
  });
});
