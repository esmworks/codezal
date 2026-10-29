import { mkdtempSync, rmSync } from "node:fs";
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
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-panel-"));
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
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  repo = mkdtempSync(join(tmpdir(), "codezal-e2e-panel-repo-"));
  await bridgeInvoke("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-e2e-panel0001" });
  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Renderer'daki tipli IPC köprüsü; e2e'de yerel klasör seçici gibi sürülemeyen adımları atlar. */
async function bridgeInvoke(channel: string, payload: unknown) {
  await page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { codezal: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).codezal.invoke(c as string, p),
    [channel, payload] as const,
  );
}

/**
 * Sohbet sütununun gerçek genişliği (px).
 *
 * Kimlikle aranır, DOM zinciriyle değil: eskiden `main > firstElementChild > firstElementChild`
 * kullanılıyordu ve araya bir sarmalayıcı eklendiğinde test, ölçtüğü şey değişmediği hâlde
 * düşüyordu (`TEST_IDS.chatColumn`).
 */
function chatWidth(): Promise<number> {
  return page.evaluate(() => {
    const chat = document.querySelector('[data-testid="chat-column"]');
    return chat ? Math.round(chat.getBoundingClientRect().width) : -1;
  });
}

/** Panelin kırpma kutusunun gerçek genişliği (px); panel kapalıyken 0. */
function panelWidth(): Promise<number> {
  return page.evaluate(() => {
    // DOM'da iki SlidePane var: kenar çubuğu önce, sağ panel sonra render edilir.
    const slides = document.querySelectorAll('[data-testid="slide-pane"]');
    const slide = slides[slides.length - 1];
    return slide ? Math.round(slide.getBoundingClientRect().width) : -1;
  });
}

test("sohbet ekranında panel tam ekrandan çarpıyla kapanınca yer bırakır", async () => {
  await page.getByRole("button", { name: "Yeni", exact: true }).click();
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.click();
  await composer.fill("Panel ölçüm sohbeti");
  await composer.press("Enter");
  // Oturum ekranı açıldı; transcript'te aynı metin başlık ve kenar çubuğunda da geçebiliyor.
  await expect(page.getByTitle(/Sağ panel/)).toBeVisible();

  // Panel hiç açılmadan sohbetin genişliği referans alınır.
  const before = await chatWidth();
  expect(before).toBeGreaterThan(700);

  // Panel aç → tam ekran → sohbet gizlenir (sütun display:none).
  await page.getByTitle(/Sağ panel/).click();
  await page.getByTitle("Tam ekran").click();
  await expect.poll(chatWidth, { message: "tam ekranda sohbet gizlenmedi" }).toBe(0);

  // Çarpıdan kapat: sohbet geri gelir ve panel kayarak alanını bırakır.
  await page.getByTitle("Paneli kapat").click();
  await expect.poll(chatWidth, { message: "sohbet referans genişliğe dönmedi" }).toBe(before);
  await expect.poll(panelWidth, { message: "kapanan panel alan tutuyor" }).toBe(0);

  // Yeniden açılan panel tam ekran kalmamalı: sohbet görünür ve panel normal genişlikte.
  await page.getByTitle(/Sağ panel/).click();
  await expect.poll(panelWidth, { message: "panel normal genişlikte açılmadı" }).toBeLessThan(500);
  const reopened = await chatWidth();
  expect(reopened).toBeGreaterThan(500);

  // Tam ekranda pencere boyutlanınca panel geçişle değil, gecikmeden izlemeli.
  await page.getByTitle("Tam ekran").click();
  await expect.poll(panelWidth).toBeGreaterThan(1000);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1200, height: 900 });
  });
  await page.waitForTimeout(100);
  const resized = await panelWidth();
  // Yeni hedef 1200 - 250 (kenar çubuğu) = 950; geçiş sürüyorsa 100 ms'de hâlâ uzakta kalır.
  expect(resized).toBeLessThan(960);
});
