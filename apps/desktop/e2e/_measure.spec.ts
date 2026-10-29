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

/**
 * Yüzen panelin sohbet kolonunu ezmediğini ölçer: kaydırma kabı pencere kenarına kadar uzanır
 * (dikey çubuk orada durur), sohbet kolonu panelin solunda kalır ve composer ile aynı hizada olur.
 * Bu hizalar yalnız gerçek pencere genişliğinde görünür; birim testiyle yakalanamaz.
 */
let app: ElectronApplication;
let page: Page;
let userData: string;
let repo: string;

test("yüzen panel sohbet kolonunu ezmiyor", async () => {
  userData = mkdtempSync(join(tmpdir(), "codezal-measure-"));
  repo = mkdtempSync(join(tmpdir(), "codezal-measure-repo-"));
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
  const bridge = (c: string, p: unknown) =>
    page.evaluate(
      ([ch, pl]) =>
        (
          window as unknown as { codezal: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).codezal.invoke(ch as string, pl),
      [c, p] as const,
    );
  await bridge("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-measure0001" });
  await bridge("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1500, height: 900 }),
  );
  await page.getByRole("button", { name: "Yeni", exact: true }).click();
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.click();
  await composer.fill("ölçüm");
  await composer.press("Enter");
  await page.waitForTimeout(2000);

  const measure = () =>
    page.evaluate(() => {
      const round = (r: DOMRect) => ({
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      // Hepsi `data-testid` ile aranır: sınıf adı ya da DOM sırası değişince test düşmesin.
      const all = [...document.querySelectorAll<HTMLElement>("div")];
      const scroll = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
      const insideScroll = (el: HTMLElement) => Boolean(scroll?.contains(el));
      const colOf = (only: HTMLElement | undefined): HTMLElement | undefined =>
        [only ?? document.body]
          .flatMap((root) => [...root.querySelectorAll<HTMLElement>("div")])
          .find((d) => d.dataset.testid === "chat-column" && d.getBoundingClientRect().height > 0);
      const overlay = document.querySelector<HTMLElement>('[data-testid="float-panel"]');
      const composerCol = all.find((d) => d.dataset.testid === "composer-box" && !insideScroll(d));
      return {
        innerWidth: window.innerWidth,
        scroll: scroll ? round(scroll.getBoundingClientRect()) : null,
        scrollPadRight: scroll ? getComputedStyle(scroll).paddingRight : null,
        col: colOf(scroll) ? round((colOf(scroll) as HTMLElement).getBoundingClientRect()) : null,
        // Kolonun içerik genişliği (yatay dolgu hariç): composer kutusu bu genişlikte olmalı.
        colInner: (() => {
          const c = colOf(scroll);
          if (!c) return null;
          const cs = getComputedStyle(c);
          return Math.round(
            c.getBoundingClientRect().width -
              Number.parseFloat(cs.paddingLeft) -
              Number.parseFloat(cs.paddingRight),
          );
        })(),
        overlay: overlay ? round(overlay.getBoundingClientRect()) : null,
        overlayPos: overlay ? getComputedStyle(overlay).position : null,
        overlayText: overlay ? (overlay.textContent ?? "").slice(0, 30) : null,
        composer: composerCol ? round(composerCol.getBoundingClientRect()) : null,
      };
    });

  const m = await measure();

  expect(m.scroll).not.toBeNull();
  expect(m.overlay).not.toBeNull();
  expect(m.col).not.toBeNull();
  expect(m.composer).not.toBeNull();
  if (m.scroll && m.overlay && m.col && m.composer) {
    // 1) Kaydırma kabı pencere kenarına kadar uzanıyor (çubuk orada).
    expect(Math.abs(m.scroll.right - m.innerWidth)).toBeLessThanOrEqual(1);
    // 2) Çubuk, panelin solundaki şeritte: sohbet metni panelin altına girmiyor.
    expect(m.scroll.right).toBeGreaterThan(m.overlay.left);
    expect(m.col.right).toBeLessThanOrEqual(m.overlay.left);
    // 3) Sohbet kolonu ile composer kolonu hizalı.
    expect(
      Math.abs((m.col.left + m.col.right) / 2 - (m.composer.left + m.composer.right) / 2),
    ).toBeLessThanOrEqual(1);
    // 4) Genişlikleri de aynı: transkript kabı iki yanda kaydırma çubuğu payı ayırıyor, composer
    //    şeridi bu payı almazsa merkez tutsa da her yandan 10px taşıyordu.
    expect(Math.abs((m.colInner ?? 0) - m.composer.width)).toBeLessThanOrEqual(1);
  }
});

/**
 * Kapatma `afterAll`da: ölçüm iddiası düşerse süreç ve geçici klasörler arkada kalmamalı,
 * yoksa sonraki spec'ler zombi uygulamayla koşar (bkz. diğer e2e dosyaları).
 */
test.afterAll(async () => {
  if (app) await app.close();
  for (const dir of [userData, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});
