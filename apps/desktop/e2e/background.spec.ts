import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Arka plan komutlarının arayüzü gerçek pencerede: senaryolu model (`ARKA:` satırı, bkz.
 * `packages/agent/src/agents/flow-model.ts`) uzun süren bir komutu `bash_background` ile başlatır.
 * Yüzen kartta sayaç ve Durdur görünür, composer rozeti sayar, satıra tıklamak çıktıyı sağ
 * paneldeki "Arka plan işleri" sekmesinde (Claude'daki "Background tasks" gibi) ayrıntı olarak
 * açar, geri oku listeye döner ve Durdur komutu kapatır.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let app: ElectronApplication;
let page: Page;
let userData: string;
let repo: string;

/** Ekran görüntüsü klasörü verilirse adımlar kaydedilir (görsel inceleme için; CI'da kapalı). */
async function shot(name: string): Promise<void> {
  const dir = process.env.CODEZAL_E2E_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function bridgeInvoke<T>(channel: string, payload: unknown): Promise<T> {
  return (await page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { codezal: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).codezal.invoke(c as string, p),
    [channel, payload] as const,
  )) as T;
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-bg-"));
  repo = mkdtempSync(join(tmpdir(), "codezal-e2e-bg-repo-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# arka plan\n");

  app = await electron.launch({
    args: [join(here, "..")],
    env: {
      ...process.env,
      CODEZAL_USER_DATA: userData,
      CODEZAL_E2E_FAUX: "1",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Yüzen kart 980px'ten dar alanda çizilmez; pencere geniş açılır.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await bridgeInvoke("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-e2e-bg00001" });
  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("arka plan komutu: kartta sayaç, rozet, çıktı sekmesi ve Durdur", async () => {
  const command = "i=0; while true; do i=$((i+1)); echo satir-$i; sleep 0.3; done";
  const session = await bridgeInvoke<{ id: string }>("sessions:create", {
    cwd: repo,
    mode: "kodlama",
    model: { provider: "faux", id: "flow" },
    thinking: "low",
    permission: "full",
    location: "local",
    projectId: null,
  });
  // Model komuta kısa açıklama verir (Claude'daki gibi): kartta ve ayrıntıda başlık odur.
  const title = "Sayaç döngüsü";
  await bridgeInvoke("sessions:prompt", { id: session.id, text: `ARKA[${title}]:${command}` });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();
  await page
    .locator("aside")
    .getByText(/ARKA\[/)
    .first()
    .click();

  // Yüzen kart: komut, canlı sayaç ve Durdur; composer rozeti bir komut sayar.
  await expect(page.getByText(/süredir çalışıyor/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Arka planda 1 komut, 0 ajan" })).toBeVisible();
  await expect(page.getByText("Terminaller", { exact: true })).toBeVisible();
  // Tur bitti ama arka plan komutunu başlatan satır sohbette kalır (dizi katlanmaz).
  await expect(page.getByText("Komut arka planda.")).toBeVisible();
  await expect(page.getByText("Arka planda çalıştırıldı")).toBeVisible();
  await shot("1-kart");

  // Satıra tıklamak komutu "Arka plan işleri" sekmesinde ayrıntıyla açar; çıktı yoklanarak akar.
  await page.getByRole("button", { name: `Çıktıyı gör: ${title}` }).click();
  await expect(page.getByRole("button", { name: "İşlere dön" })).toBeVisible();
  // Başlık açıklamadır; tam komut başlığın altındaki balonda durur.
  await expect(page.getByText(title, { exact: true }).last()).toBeVisible();
  await expect(page.getByText(command, { exact: true }).last()).toBeVisible();
  const output = page.locator("pre", { hasText: "satir-" });
  await expect(output).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => (await output.textContent())?.match(/satir-/g)?.length ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(3);
  await shot("2-ayrinti");

  // Geri oku listeye döner: komut "Çalışıyor" bölümünde kart olarak durur.
  await page.getByRole("button", { name: "İşlere dön" }).click();
  await expect(page.getByText("Çalışıyor", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Çıktıyı gör: ${title}` }).last()).toBeVisible();
  await shot("3-liste");

  // Karttaki Durdur komutu kapatır; kart "Bitti" bölümüne geçer, rozet kaybolur.
  await page.getByRole("button", { name: "Durdur", exact: true }).last().click();
  await expect(page.getByText(/durduruldu/i).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Bitti" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Arka planda 1 komut, 0 ajan" })).toBeHidden();
  const jobs = await bridgeInvoke<Array<{ status: string }>>("background:list", {
    sessionId: session.id,
  });
  expect(jobs.map((j) => j.status)).toEqual(["stopped"]);
  await shot("4-durdu");
});

test("ajan listede kart, tıklayınca ayrıntı; geri oku listeye döner", async () => {
  const session = await bridgeInvoke<{ id: string }>("sessions:create", {
    cwd: repo,
    mode: "kodlama",
    model: { provider: "faux", id: "flow" },
    thinking: "low",
    permission: "full",
    location: "local",
    projectId: null,
  });
  const plan = [{ file: "ajan.js", content: "export const x = 1;", background: true }];
  const text = `PLAN:${JSON.stringify(plan)}`;
  // Oturum önce açılır: ajan hızlı biter, satırı ancak canlı olayla (bitti geri bildirimiyle) görünür.
  await bridgeInvoke("sessions:rename", { id: session.id, name: "ajan denemesi" });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("aside").getByText("ajan denemesi").first().click();
  // Önceki testin açtığı panel durum kartını gizler (kart yalnız panel kapalıyken çizilir).
  const closePanel = page.getByTitle("Paneli kapat");
  if (await closePanel.isVisible()) await closePanel.click();
  await bridgeInvoke("sessions:prompt", { id: session.id, text });

  // Ajan hızlı biter: bölümü "✓" ile katlanır. Bitenler dahil bütün işler "Tüm işler" dizinindedir.
  await expect(page.getByText("Ajanlar", { exact: true })).toBeVisible({ timeout: 20_000 });
  await shot("5-ajan-kart");
  await page.getByRole("button", { name: "Tüm işler" }).click();
  // Listede ajan kartı "Dökümü gör" bağlantısıyla durur; kart başlığı koşunun adıdır.
  const card = page.getByRole("button", { name: /^Dökümü gör: / }).first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await shot("6-liste");

  // Kart ajanın ayrıntısını aynı sekmede açar; geri oku listeye döner.
  await card.click();
  const back = page.getByRole("button", { name: "İşlere dön" });
  await expect(back).toBeVisible();
  await expect(page.getByText("Model", { exact: true })).toBeVisible();
  await shot("7-ajan-ayrinti");
  await back.click();
  await expect(card).toBeVisible();
});
