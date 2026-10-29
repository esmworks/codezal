import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Ajan koşusunun arayüz akışı gerçek pencerede: model senaryoludur (`CODEZAL_E2E_FAUX=1`, bkz.
 * `packages/agent/src/agents/flow-model.ts`), motor, git ve worktree gerçektir. Ana oturum aynı
 * yanıtta iki yazan ajan başlatır; biri ana klasörde çalışıp izin ister (Sor modu), diğeri
 * worktree'de izinsiz (Otomatik düzenle) biter ve incelemeye düşer.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let app: ElectronApplication;
let page: Page;
let userData: string;
let repo: string;

const KARE = "export const kare = (a) => a * a;";
const KUP = "export const kup = (a) => a * a * a;";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
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
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-flow-"));
  repo = mkdtempSync(join(tmpdir(), "codezal-e2e-flow-repo-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "e2e@codezal.dev");
  git("config", "user.name", "Codezal E2E");
  writeFileSync(join(repo, "kare.js"), "export const kare = (a) => a + a;\n");
  writeFileSync(join(repo, "kup.js"), "export const kup = (a) => a * 3;\n");
  git("add", ".");
  git("commit", "-qm", "ilk");

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
  // Karşılama penceresi bağlı sağlayıcı görünce açılmaz; senaryolu model kendi anahtarını taşır,
  // bu anahtar yalnız karşılamayı geçmek için.
  await bridgeInvoke("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-e2e-flow0001" });
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

test("paralel ajanlar: izin kartı etiketli, inceleme kartı tur bitince çıkar, Uygula ana dala girer", async () => {
  const session = await bridgeInvoke<{ id: string }>("sessions:create", {
    cwd: repo,
    mode: "kodlama",
    model: { provider: "faux", id: "flow" },
    thinking: "low",
    permission: "ask",
    location: "local",
    projectId: null,
  });
  const plan = [
    { file: "kare.js", content: KARE },
    { file: "kup.js", content: KUP },
  ];
  await bridgeInvoke("sessions:prompt", { id: session.id, text: `PLAN:${JSON.stringify(plan)}` });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();
  await page.locator("aside").getByText(/PLAN:/).first().click();

  // Ana klasördeki ajan izin ister; kart hangi ajanın sorduğunu yazar. Ana tur bu kartı beklerken
  // worktree ajanı biter ve incelemeye düşer, ama inceleme kartı tur bitene kadar çizilmez.
  const permission = page.getByText(/Ajan: (kare|kup)\.js düzelt/);
  await expect(permission).toBeVisible({ timeout: 20_000 });
  const label = (await permission.textContent()) ?? "";
  const rootFile = label.includes("kare.js") ? "kare.js" : "kup.js";
  const isolatedFile = rootFile === "kare.js" ? "kup.js" : "kare.js";
  const isolatedFix = isolatedFile === "kare.js" ? KARE : KUP;
  await expect.poll(() => git("worktree", "list").split("\n").length, { timeout: 20_000 }).toBe(2);
  await expect
    .poll(
      async () =>
        (await bridgeInvoke<Array<{ status: string }>>("agentRuns:list", { sessionId: session.id }))
          .map((run) => run.status)
          .join(","),
      { timeout: 20_000 },
    )
    .toBe("review");
  const reviewTitle = page.getByText("Ajanın değişikliği incelemede");
  await expect(reviewTitle).toBeHidden();

  await page.getByRole("button", { name: "İzin ver", exact: true }).click();

  // Tur bitti: kart yanıtın altında. İlk düğme zararsız İncele; Uygula kısa süre kapalı açılır.
  await expect(reviewTitle).toBeVisible({ timeout: 20_000 });
  const card = page.locator("div.rounded-\\[12px\\]", { has: reviewTitle });
  const buttons = card.getByRole("button");
  await expect(buttons.first()).toHaveText("İncele");
  const apply = card.getByRole("button", { name: "Uygula" });
  await expect(apply).toBeDisabled();
  await expect(apply).toBeEnabled({ timeout: 5_000 });

  await card.getByRole("button", { name: "İncele" }).click();
  await expect(card.locator("pre")).toContainText(isolatedFix);
  expect(readFileSync(join(repo, isolatedFile), "utf8")).not.toContain(isolatedFix);

  // Ana klasördeki ajanın değişikliği commit'lenir; yerel değişiklik birleştirmeyi engellemesin.
  git("commit", "-qam", "kök düzeltmesi");
  await apply.click();
  await expect(reviewTitle).toBeHidden({ timeout: 10_000 });
  expect(readFileSync(join(repo, isolatedFile), "utf8")).toBe(`${isolatedFix}\n`);
  expect(readFileSync(join(repo, rootFile), "utf8")).toContain(rootFile === "kare.js" ? KARE : KUP);
  expect(git("log", "-3", "--format=%s")).toMatch(/Codezal ajan: ajan-/);
  expect(git("worktree", "list").split("\n")).toHaveLength(1);
});
