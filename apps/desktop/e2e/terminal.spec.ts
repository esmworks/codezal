import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

/** Ana süreçteki kabuk kaydı (`terminal:list`); sekmelerin gerçekten pty açıp öldürdüğü buradan doğrulanır. */
interface TerminalInfo {
  id: string;
  cwd: string;
  title: string;
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-term-"));
  repo = mkdtempSync(join(tmpdir(), "codezal-e2e-term-repo-"));
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
  await bridgeInvoke("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-e2e-term0001" });
  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Oturum ekranı: panel yalnız orada durur, görev yazıp açıyoruz (panel.spec ile aynı ön koşul).
  await page.getByRole("button", { name: "Yeni", exact: true }).click();
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.click();
  await composer.fill("Terminal sekmeleri");
  await composer.press("Enter");
  await expect(page.getByTitle(/Sağ panel/)).toBeVisible();

  // Sağ panel boş açılır: ilk terminal boş durum karosundan kurulur.
  await page.getByTitle(/Sağ panel/).click();
  await page.getByRole("button", { name: "Yeni terminal", exact: true }).click();
  await expect(page.getByText("Terminal 1", { exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Renderer'daki tipli IPC köprüsü; e2e'de sürülemeyen adımları (klasör seçici) atlar. */
async function bridgeInvoke<T>(channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { codezal: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).codezal.invoke(c as string, p),
    [channel, payload] as const,
  ) as Promise<T>;
}

/** Ana süreçteki canlı kabuklar. */
const shells = () => bridgeInvoke<TerminalInfo[]>("terminal:list");

/**
 * Görünür terminale komut yazar; sekme değişiminde girdinin doğru kabuğa gittiğini bu kanıtlar.
 * Arkadaki sekmelerin xterm'i DOM'da kalır (`hidden`), bu yüzden yalnız görünür olan seçilir.
 */
async function runInTerminal(command: string) {
  await page.locator(".xterm:visible").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const tab = (n: number) => page.getByText(`Terminal ${n}`, { exact: true });
/** Kapatma çarpısı yalnız sekme üzerine gelince görünür (arka plandaki sekmelerde gizli). */
async function closeTab(n: number) {
  await tab(n).hover();
  await page.getByRole("button", { name: `Terminal ${n} sekmesini kapat` }).click();
}
const waitForFile = (name: string, message: string) =>
  expect.poll(() => existsSync(join(repo, name)), { message, timeout: 20_000 }).toBe(true);

test("panel şeridinde birden fazla terminal sekmesi açılır, her biri kendi kabuğunda çalışır", async () => {
  await expect.poll(async () => (await shells()).length).toBe(1);
  const first = (await shells())[0];

  // "+" menüsünden ikinci terminal: şeride kendi sekmesi gelir ve öne alınır.
  await page.getByTitle("Yeni sekme").click();
  await page.getByText("Yeni terminal", { exact: true }).click();
  await expect(tab(2)).toBeVisible();
  await expect.poll(async () => (await shells()).length).toBe(2);

  // Öndeki sekme yeni terminal: komut onun kabuğunda çalışır.
  await runInTerminal("touch iki.txt");
  await waitForFile("iki.txt", "ikinci terminalin komutu çalışmadı");
  const both = (await shells()).map((s) => s.id);

  // Sekmeye dönüş canlı kabuğa bağlanır: yeni pty açılmaz, komut ilk kabukta çalışır.
  await tab(1).click();
  await runInTerminal("touch bir.txt");
  await waitForFile("bir.txt", "geri dönülen terminalin komutu çalışmadı");
  expect((await shells()).map((s) => s.id).sort()).toEqual(both.sort());
  expect(both).toContain(first.id);

  // Sekmeyi kapatmak yalnız kendi kabuğunu öldürür.
  await closeTab(2);
  await expect(tab(2)).toHaveCount(0);
  await expect.poll(async () => (await shells()).map((s) => s.id)).toEqual([first.id]);

  // Son terminal kapanınca boş durum gelir; yeni terminal boşalan numarayı alır.
  await closeTab(1);
  await expect.poll(async () => (await shells()).length).toBe(0);
  const fresh = page.getByRole("button", { name: "Yeni terminal", exact: true });
  await expect(fresh).toBeVisible();
  await fresh.click();
  await expect(tab(1)).toBeVisible();
  await expect.poll(async () => (await shells()).length).toBe(1);
});
