import type { CatalogModel, MarkerItem } from "@codezal/contracts";
import { createI18n } from "@codezal/i18n";
import { describe, expect, it } from "vitest";
import { markerView } from "./markers";

const tr = createI18n("tr");
const en = createI18n("en");

const model = (provider: string, id: string, name: string): CatalogModel => ({
  provider,
  id,
  name,
  reasoning: true,
  vision: true,
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0 },
  available: true,
});

const marker = (over: Partial<MarkerItem>): MarkerItem =>
  ({ type: "marker", id: "mk", kind: "compact", at: 1, ...over }) as MarkerItem;

describe("markerView", () => {
  it("model geçişini katalogdaki adlarla yazar", () => {
    const catalog = [model("acme", "a", "Opus 4"), model("acme", "b", "GPT-5")];
    const view = markerView(marker({ kind: "model", from: "acme/a", to: "acme/b" }), catalog, tr.t);
    expect(view.text).toBe("Model · Opus 4 → GPT-5");
    expect(view.icon).toBe("code");
  });

  it("katalogda olmayan modelde kimliği olduğu gibi bırakır", () => {
    // Silinmiş bir modelin satırı okunabilir kalmalı: işaret kaydı silinmez.
    const view = markerView(marker({ kind: "model", to: "eski/silinmis" }), [], tr.t);
    expect(view.text).toBe("Model · eski/silinmis");
  });

  it("ilk model bilinmiyorsa yalnız yeni değeri yazar", () => {
    const view = markerView(
      marker({ kind: "model", to: "acme/b" }),
      [model("acme", "b", "GPT-5")],
      tr.t,
    );
    expect(view.text).toBe("Model · GPT-5");
  });

  it("izin modunu ve düşünme seviyesini dile göre yazar", () => {
    const permission = markerView(
      marker({ kind: "permission", from: "ask", to: "plan" }),
      [],
      tr.t,
    );
    expect(permission.text).toBe(
      `İzin modu · ${tr.t("permissionMode.ask")} → ${tr.t("permissionMode.plan")}`,
    );
    const effort = markerView(marker({ kind: "thinking", from: "low", to: "max" }), [], en.t);
    expect(effort.text).toBe("Thinking · Low → Max");
    expect(effort.icon).toBe("brain");
  });

  it("bilinmeyen mod kimliğini olduğu gibi bırakır (eski kayıt okunur kalsın)", () => {
    const view = markerView(marker({ kind: "permission", to: "gelecek-mod" }), [], tr.t);
    expect(view.text).toBe("İzin modu · gelecek-mod");
  });

  it("özetlemenin üç sonucunu ayrı söyler", () => {
    expect(markerView(marker({ outcome: "done" }), [], tr.t).text).toBe(tr.t("marker.compact"));
    expect(markerView(marker({ outcome: "noop" }), [], tr.t).text).toBe(tr.t("marker.compactNoop"));
    const failed = markerView(marker({ outcome: "failed" }), [], tr.t);
    expect(failed.text).toBe(tr.t("marker.compactFailed"));
    // Başarısız satır nötr tonda: hata metni zaten söylüyor, renk ikinci kez bağırmasın.
    expect(failed.tone).toBe("muted");
  });

  it("gönderilmeyen mesajı başıyla söyler; baş yoksa yalnız durumu yazar", () => {
    const view = markerView(marker({ kind: "unsent", to: "testleri düzelt" }), [], tr.t);
    expect(view.text).toBe("Durduruldu, mesaj gönderilmedi · testleri düzelt");
    expect(view.icon).toBe("x");
    expect(markerView(marker({ kind: "unsent" }), [], en.t).text).toBe("Stopped, message not sent");
  });
});
