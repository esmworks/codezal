import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
let app: ElectronApplication;
let page: Page;
let userData: string;
let repo: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-agents-"));
  repo = mkdtempSync(join(tmpdir(), "codezal-e2e-agents-repo-"));
  app = await electron.launch({
    args: [join(here, "..")],
    env: {
      ...process.env,
      CODEZAL_USER_DATA: userData,
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Sağlayıcı bağlı değilse karşılama penceresi yeniden açılıp kenar çubuğunu perdeler; anahtar
  // yazılınca bir daha açılmaz (panel.spec ile aynı ön koşul).
  await bridgeInvoke("models:setApiKey", {
    provider: "anthropic",
    apiKey: "sk-ant-e2e-agents0001",
  });
  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  // Yine açılırsa kapat: ayarlar dişlisi kenar çubuğunda, kaplama açıkken tıklanamaz.
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Renderer'daki tipli IPC köprüsü; e2e'de sürülemeyen adımları (klasör seçici) atlar. */
async function bridgeInvoke<T>(channel: string, payload: unknown): Promise<T> {
  return (await page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { codezal: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).codezal.invoke(c as string, p),
    [channel, payload] as const,
  )) as T;
}

/**
 * Açılır menü katmanı. `MenuLayer` satırları rol taşımayan div'ler olarak çizer ve menü
 * içeriği sabit `z-[141]` sınıfıyla işaretlenir; metin araması bu kapsayıcıyla sınırlanır
 * (aynı metin satır düğmelerinde de geçtiği için yoksa yanlış öğe tıklanır).
 */
const menu = () => page.locator('div[class*="z-[141]"]');

interface AgentRow {
  id: string;
  name: string;
  scope: string;
  enabled: boolean;
  tools: string[] | null;
  model: { provider: string; id: string } | null;
}

const agentFile = (name: string) => join(userData, "agents", `${name}.md`);

/**
 * Ajanlar sayfasını açar. Ayarlar dişlisi kenar çubuğunun altındadır ve kenar çubuğu oturum
 * ekranında görünür; bu yüzden önce bir görev açılır. Dişlinin erişilebilir adı kısayolu da taşır
 * ("Ayarlar (⌘,)"), bu yüzden ad desenle aranır.
 */
async function openAgentsPage() {
  // Önce açık menü, sonra kaplama: Escape iki katmanı sırayla kapatır.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (!(await page.getByRole("button", { name: /^Ayarlar/ }).count())) {
    await page.getByRole("button", { name: "Yeni", exact: true }).click();
  }
  await page
    .getByRole("button", { name: /^Ayarlar/ })
    .first()
    .click();
  await expect(page.getByText("Uygulamaya dön")).toBeVisible();
  await page.getByRole("button", { name: "Ajanlar", exact: true }).click();
  await expect(page.getByPlaceholder("Ajan ara…")).toBeVisible();
}

test("Ayarlar > Ajanlar: gömülü ajanlar listelenir, yeni ajan dosyaya yazılır", async () => {
  await openAgentsPage();

  // Gömülü ajanlar koddan gelir: okunur etiket çevrilir, çağrı adı yanında görünür.
  await expect(page.getByText("Genel ajan", { exact: true })).toBeVisible();
  await expect(page.getByText("Keşif ajanı", { exact: true })).toBeVisible();
  await expect(page.getByText("Henüz ajan tanımlı değil")).toBeVisible();

  await page.getByRole("button", { name: "Yeni ajan", exact: true }).first().click();
  await page.getByPlaceholder("rapor-yazari").fill("rapor-yazari");
  await page
    .getByPlaceholder(/Ne işe yarar, hangi durumda çağrılmalı/)
    .fill("Denetim raporlarını yazar");
  await page.getByPlaceholder(/Ajanın rolü, sınırları/).fill("Rapor yazarı olarak çalışırsın.");
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();

  await expect(page.getByText("rapor-yazari", { exact: true })).toBeVisible();
  expect(existsSync(agentFile("rapor-yazari"))).toBe(true);
  const text = readFileSync(agentFile("rapor-yazari"), "utf8");
  expect(text).toContain("name: rapor-yazari");
  expect(text).toContain("Rapor yazarı olarak çalışırsın.");

  // Modelin gördüğü liste aynı kaynaktan gelir: `agents:list` ajanı döner.
  const catalog = await bridgeInvoke<{ agents: AgentRow[] }>("agents:list", { cwd: repo });
  const created = catalog.agents.find((a) => a.name === "rapor-yazari");
  expect(created?.scope).toBe("user");
  expect(created?.enabled).toBe(true);
});

test("Ayarlar > Ajanlar: gömülü ajanın modeli satırdan değiştirilir", async () => {
  await openAgentsPage();

  // Gömülü ajanların tek düzenlenebilir alanı model seçicisidir; boş değer devral demektir.
  const override = page.getByRole("button", { name: "Varsayılanı devral" }).first();
  await expect(override).toBeVisible();
  await override.click();
  const model = "anthropic/claude-haiku-4-5";
  await menu().getByText(model, { exact: true }).click();

  // Satır seçimi gösterir, durum dosyasına yazılır ve IPC aynı modeli döner.
  await expect(page.getByRole("button", { name: model }).first()).toBeVisible();
  const state = JSON.parse(readFileSync(join(userData, "agents-state.json"), "utf8")) as {
    overrides: Record<string, { provider: string; id: string }>;
  };
  expect(state.overrides["built-in:general"]).toEqual({
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });
  const catalog = await bridgeInvoke<{ agents: AgentRow[] }>("agents:list", { cwd: repo });
  expect(catalog.agents.find((a) => a.name === "general")?.model).toEqual({
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });

  // Devralmaya dönüş kaydı temizler.
  await page.getByRole("button", { name: model }).first().click();
  await menu().getByText("Varsayılanı devral", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Varsayılanı devral" }).first()).toBeVisible();
  const cleared = JSON.parse(readFileSync(join(userData, "agents-state.json"), "utf8")) as {
    overrides: Record<string, unknown>;
  };
  expect(cleared.overrides["built-in:general"]).toBeUndefined();
});

test("Ayarlar > Ajanlar: kapatma, ad değiştirme ve silme", async () => {
  await openAgentsPage();

  // Tek dosya ajanı var: tek anahtar onun.
  await page.getByRole("switch").click();
  await expect(page.getByText("Kapalı", { exact: true })).toBeVisible();
  const off = await bridgeInvoke<{ agents: AgentRow[] }>("agents:list", { cwd: repo });
  expect(off.agents.find((a) => a.name === "rapor-yazari")?.enabled).toBe(false);

  await page.getByRole("switch").click();
  await expect(page.getByText("Kapalı", { exact: true })).toBeHidden();

  // Ad değişince dosya yeni adla yazılır, eskisi silinir.
  await page.getByTitle("Düzenle").click();
  await page.getByPlaceholder("rapor-yazari").fill("rapor-cu");
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(page.getByText("rapor-cu", { exact: true })).toBeVisible();
  expect(existsSync(agentFile("rapor-cu"))).toBe(true);
  expect(existsSync(agentFile("rapor-yazari"))).toBe(false);

  // Silme onay ister; onaylanınca dosya da gider.
  await page.getByTitle("Sil").click();
  const dialog = page.locator(".cz-modal");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sil", exact: true }).click();
  await expect(page.getByText("rapor-cu", { exact: true })).toBeHidden();
  expect(existsSync(agentFile("rapor-cu"))).toBe(false);
});

test("Ajan tanımı bozuksa liste uyarı gösterir, ajan sayılmaz", async () => {
  // Üst verisi olmayan dosya: ajan listesine girmez, uyarı bölümünde görünür.
  const dir = join(userData, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bozuk.md"), "Üst veri yok", "utf8");

  await openAgentsPage();
  await page.getByRole("button", { name: "Listeyi yenile" }).click();
  await expect(page.getByText("Üst veri (---) bloğu yok; dosya yok sayıldı.")).toBeVisible();
  const catalog = await bridgeInvoke<{ agents: AgentRow[] }>("agents:list", { cwd: repo });
  expect(catalog.agents.map((a) => a.name)).not.toContain("bozuk");
});
