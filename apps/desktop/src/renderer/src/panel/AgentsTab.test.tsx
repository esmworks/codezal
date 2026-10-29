import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../lib/i18n";
import { AgentDetail, thinkingKey } from "./AgentsTab";
import { JobsTab } from "./JobsTab";

beforeAll(async () => {
  // Görünen metni iddia eden testler dili kendisi sabitler (bkz. lib/i18n notu).
  await i18n.changeLanguage("tr");
});

describe("ajan ayrıntısı", () => {
  it("Pi düşünme seviyesini seçicideki üç kademeye indirir", () => {
    // Ham "low"/"xhigh" arayüze sızmaz: motordaki `#thinkingOf` ile aynı eşleme.
    expect(i18n.t(thinkingKey("low"))).toBe("Düşük");
    expect(i18n.t(thinkingKey("minimal"))).toBe("Düşük");
    expect(i18n.t(thinkingKey("medium"))).toBe("Yüksek");
    expect(i18n.t(thinkingKey("high"))).toBe("Yüksek");
    expect(i18n.t(thinkingKey("xhigh"))).toBe("Maks");
    expect(i18n.t(thinkingKey("off"))).toBe("Kapalı");
  });

  it("kaydı olmayan koşuda boş durumu çizer", () => {
    const html = renderToStaticMarkup(<AgentDetail sessionId="s-1" cwd="/tmp" runId="yok" />);
    expect(html).toContain("Bu ajanın kaydı artık yok.");
    // Geri oku listeye döner (Claude'daki "Background tasks" ayrıntısı gibi).
    expect(html).toContain('aria-label="İşlere dön"');
  });
});

describe("Arka plan işleri sekmesi", () => {
  it("iş yokken boş durumu başlık ve açıklamayla çizer", () => {
    const html = renderToStaticMarkup(<JobsTab sessionId="s-1" cwd="/tmp" />);
    expect(html).toContain("Arka plan işi yok");
    expect(html).toContain("text-[13px]");
    expect(html).not.toContain("font-mono");
  });
});
