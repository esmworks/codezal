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

const here = fileURLToPath(new URL(".", import.meta.url));
// Çoklu seçim Windows'ta Ctrl, macOS'ta Cmd ile yapılır; e2e iki platformda da koşabilsin.
const MOD: "Control" | "Meta" = process.platform === "win32" ? "Control" : "Meta";
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "codezal-e2e-"));
  // Uygulama klasörü verilir (package.json "main" → out/main/index.mjs); böylece app.getAppPath()
  // ve sürüm gerçek uygulamadaki gibi çözülür.
  app = await electron.launch({
    args: [join(here, "..")],
    // Test verisi kullanıcının gerçek Codezal klasörüne karışmasın; PI_OFFLINE uzak model
    // kataloğunu kapatır, e2e ağa çıkmaz.
    env: {
      ...process.env,
      CODEZAL_USER_DATA: userData,
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
});

/** Ayarlar kenar çubuğunun altındaki dişli düğmeden açılır (sağ tık hesap menüsünü verir). */
async function openSettings() {
  await page.getByRole("button", { name: "Ayarlar", exact: true }).click();
  await expect(page.getByText("Uygulamaya dön")).toBeVisible();
}

/**
 * Uygulama içi onay penceresini onaylar. Yerel `window.confirm` Windows'ta pencere odağını
 * bırakmadığı için kaldırıldı; onay artık bu pencereden alınıyor.
 */
async function confirmDialog(okLabel = "Sil") {
  const dialog = page.locator(".cz-modal");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: okLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("pencere açılır, ana ekran ve kenar çubuğu gelir", async () => {
  await expect(page).toHaveTitle("Codezal");
  await expect(page.getByRole("button", { name: "Yeni", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder("Ne yapalım?")).toBeVisible();
});

test("ilk açılışta karşılama görünür ve Bağlantı sayfasına götürür", async () => {
  const welcome = page.getByText("Codezal'a hoş geldin");
  await expect(welcome).toBeVisible();
  await page.getByRole("button", { name: "Sağlayıcı bağla" }).click();
  await expect(page.getByText("Uygulamaya dön")).toBeVisible();
  await expect(page.getByPlaceholder("Sağlayıcı ara…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(welcome).toBeHidden();
});

test("mod sekmeleri ekranı değiştirir", async () => {
  await page.getByRole("button", { name: "Asistan", exact: true }).click();
  await expect(page.getByPlaceholder(/Asistan'a bir iş ver/)).toBeVisible();
  await page.getByRole("button", { name: "Kodlama", exact: true }).click();
  await expect(page.getByPlaceholder("Ne yapalım?")).toBeVisible();
});

test("komut paneli / ile açılır, puanla süzülür, seçim etiket bırakır", async () => {
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.click();
  await page.keyboard.type("/");
  // Panel sorguyu yazma kutusundan okur (ZCode'un `/` paneli gibi): ayrı arama kutusu yoktur.
  // Satırda kanonik `/ad` ve Türkçe açıklama durur.
  const panel = page.getByRole("listbox", { name: "Komutlar ve beceriler" });
  const option = (name: string) => panel.getByRole("option", { name: new RegExp(`^/${name}\\b`) });
  await expect(option("plan")).toBeVisible();
  await expect(page.getByText("Komut ya da beceri aramak için yaz")).toBeVisible();
  await page.keyboard.type("debu");
  await expect(option("debug")).toBeVisible();
  await expect(option("plan")).toBeHidden();
  // Türkçe yazım takma addır: listede görünmez ama aramada komutu bulur.
  await composer.fill("/yardım");
  await expect(option("help")).toBeVisible();
  await composer.fill("/görüşme");
  await expect(option("interview")).toBeVisible();
  await composer.fill("/olmayan-komut");
  await expect(page.getByText("Eşleşen komut yok")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Eşleşen komut yok")).toBeHidden();
  // Enter yalnız satırı seçer, istemi **göndermez**: panel tuşu en yüksek öncelikle işler.
  // Seçilen kısayol kutuda tek birimlik etikete döner; gönderimde `/plan` olarak gider.
  await composer.fill("");
  await page.keyboard.type("/pl");
  await expect(option("plan")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  const token = composer.locator('[data-token="command"]');
  await expect(token).toHaveText("plan");
  await expect(token).toHaveAttribute("title", "/plan");
  // Etiket tek birimdir: boşluktan sonra iki Backspace kutuyu boşaltır.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(token).toHaveCount(0);
  await composer.fill("");
});

test("komut ekranı /help ile açılır ve komutları kullanımıyla listeler", async () => {
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.fill("/help");
  await page.keyboard.press("Enter");
  const screen = page.getByTestId("commands-screen");
  await expect(screen).toBeVisible();
  // Kullanım satırı kanonik adı ve dile göre argüman ipucunu taşır.
  await expect(screen.getByText("/help [komut]")).toBeVisible();
  await expect(screen.getByText("/model [sağlayıcı/model]")).toBeVisible();
  await screen.getByPlaceholder("Komut ara…").fill("düşünme");
  await expect(screen.getByText("/effort [low|high|max]")).toBeVisible();
  await expect(screen.getByText("/help [komut]")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(screen).toBeHidden();
  // Seçimle çalışan komut kutuda kalmaz.
  await expect(composer).toHaveText("");
});

test("Ayarlar > Beceriler kataloğu gösterir", async () => {
  await openSettings();
  await page.getByRole("button", { name: "Beceriler", exact: true }).click();
  await expect(page.getByPlaceholder("Beceri ara…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Codezal klasörünü aç" })).toBeVisible();
  // Şablon ve paket yüzeyi kaldırıldı: sayfa yalnız becerileri ve kaynak klasörleri gösterir.
  await expect(page.getByRole("button", { name: "Şablonlar", exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paketler", exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paket kur" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Uygulamaya dön")).toBeHidden();
});

test("Ayarlar > Servisler boş liste ve ekleme formu gösterir", async () => {
  await openSettings();
  await page.getByRole("button", { name: "Servisler", exact: true }).click();
  // Bağlı servis yokken sayfa katalog sekmesinde açılır; boş liste Bağlı sekmesindedir.
  await expect(page.getByPlaceholder("Servis ara…")).toBeVisible();
  await page.getByRole("tab", { name: /^Bağlı servisler/ }).click();
  await expect(page.getByText("Henüz bağlı servis yok", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hazır servislere göz at" }).click();
  await expect(page.getByPlaceholder("Servis ara…")).toBeFocused();
  await page.getByRole("button", { name: "Özel servis ekle" }).click();
  // Elle ekleme formu pencerede açılır; ad ve adres boşken Ekle kapalı.
  const addDialog = page.getByRole("dialog", { name: "Uzak MCP sunucusu ekle" });
  await expect(addDialog.getByPlaceholder("https://mcp.ornek.com/mcp")).toBeVisible();
  await expect(addDialog.getByRole("button", { name: "Ekle", exact: true })).toBeDisabled();
  await addDialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(page.getByPlaceholder("https://mcp.ornek.com/mcp")).toBeHidden();
  // Hazır katalog: sekmeler ve arama yalnız kataloğu süzer; Context7 belirteç penceresi açar.
  await page.getByPlaceholder("Servis ara…").fill("context");
  await expect(page.getByText("Context7", { exact: true })).toBeVisible();
  await expect(page.getByText("Notion", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Ekle", exact: true }).click();
  const tokenDialog = page.getByRole("dialog", { name: "Context7 ekle" });
  await expect(tokenDialog.getByPlaceholder("API anahtarı / erişim belirteci")).toBeVisible();
  // Belirteç isteğe bağlı olduğundan Ekle açık.
  await expect(tokenDialog.getByRole("button", { name: "Ekle", exact: true })).toBeEnabled();
  await tokenDialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(tokenDialog).toBeHidden();
  await page.keyboard.press("Escape");
});

test("Ayarlar > Bağlantı: birden fazla anahtar listelenir, Kullan/Sil ve bekleme süresi", async () => {
  await openSettings();
  await page.getByRole("button", { name: "Bağlantı", exact: true }).click();
  await page.getByPlaceholder("Sağlayıcı ara…").fill("Anthropic");
  await page.getByRole("button", { name: "Bağlan", exact: true }).click();
  const secret = page.locator('input[type="password"]');
  await secret.fill("sk-ant-e2e-aaaa1111");
  await secret.press("Enter");
  await expect(page.getByText("Anahtar 1", { exact: true })).toBeVisible();
  await expect(page.locator("li", { hasText: "····1111" })).toBeVisible();
  await expect(page.getByText("Aktif", { exact: true })).toBeVisible();
  // İkinci anahtar etiketle yedek olarak girer.
  await page.getByPlaceholder("Etiket (isteğe bağlı)").fill("İş");
  await secret.fill("sk-ant-e2e-bbbb2222");
  await page.getByRole("button", { name: "Ekle", exact: true }).click();
  const backup = page.locator("li", { hasText: "····2222" });
  await expect(backup.getByText("İş", { exact: true })).toBeVisible();
  await expect(backup.getByText("Yedek", { exact: true })).toBeVisible();
  await expect(backup.getByRole("button", { name: "Sil" })).toBeVisible();
  await backup.getByRole("button", { name: "Kullan" }).click();
  await expect(page.locator("li", { hasText: "····2222" }).getByText("Aktif")).toBeVisible();
  await expect(page.locator("li", { hasText: "····1111" }).getByText("Yedek")).toBeVisible();
  await expect(page.getByText("Anahtar bekleme süresi")).toBeVisible();
  // Görsel doğrulama için isteğe bağlı ekran görüntüsü (CODEZAL_E2E_SHOT=/yol/dosya.png).
  if (process.env.CODEZAL_E2E_SHOT) await page.screenshot({ path: process.env.CODEZAL_E2E_SHOT });
  await page.getByRole("button", { name: "Tümünü kaldır" }).click();
  await expect(page.getByText("····2222")).toBeHidden();
  await page.keyboard.press("Escape");
});

test("kenar çubuğunda çoklu proje seçimi ve toplu silme", async () => {
  // Karşılama penceresi kenar çubuğunu perdeler; tek başına koşabilmek için kapalı işaretlenir
  // (sağlayıcı listesi geç gelirse pencere sonradan açılmasın diye hem depolama hem düğme).
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "Asistan", exact: true }).click();
  // Aynı adlar Asistan ana ekranında da geçtiğinden aramalar kenar çubuğuyla sınırlanır.
  const sidebar = page.locator("aside");
  const project = (name: string) => sidebar.getByRole("button", { name, exact: true });
  for (const name of ["E2E Alfa", "E2E Beta", "E2E Gama"]) {
    await sidebar.getByRole("button", { name: "Yeni proje" }).click();
    const input = page.getByPlaceholder("ör. Kişisel finans, İngilizce eğitimi");
    await input.fill(name);
    await input.press("Enter");
    await expect(project(name)).toBeVisible();
  }
  // Oturumsuz proje kenar çubuğunda gizlenir (yalnız açık olan görünür); her projeye bir oturum
  // açılır ki üçü de listede kalsın. Köprü çağrısı mağazayı tazelemediği için sayfa yeniden yüklenir.
  const created = await page.evaluate(() =>
    (
      window as unknown as { codezal: { invoke: (c: string, p?: unknown) => Promise<unknown> } }
    ).codezal.invoke("assistant:projects"),
  );
  for (const p of created as { id: string; name: string }[]) {
    if (!p.name.startsWith("E2E ")) continue;
    await bridgeInvoke("sessions:create", {
      cwd: tmpdir(),
      mode: "asistan",
      projectId: p.id,
      name: `${p.name} görevi`,
    });
  }
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Asistan", exact: true }).click();
  await project("E2E Gama").click();
  // Gama açık; Shift ile Alfa'ya tıklamak aradaki Beta ile üçünü seçer.
  await project("E2E Alfa").click({ modifiers: ["Shift"] });
  await project("E2E Alfa").click({ button: "right" });
  await expect(page.getByText("3 satır seçildi")).toBeVisible();
  await page.getByText("Seçimi temizle").click();
  // Cmd/Ctrl açık projeye bir tane daha ekler; aradaki Beta dışarıda kalır.
  await project("E2E Alfa").click({ modifiers: [MOD] });
  await project("E2E Alfa").click({ button: "right" });
  await expect(page.getByText("2 satır seçildi")).toBeVisible();
  // Görsel doğrulama için isteğe bağlı ekran görüntüsü (CODEZAL_E2E_SHOT_SELECT=/yol/dosya.png).
  if (process.env.CODEZAL_E2E_SHOT_SELECT)
    await page.screenshot({ path: process.env.CODEZAL_E2E_SHOT_SELECT });
  await page.keyboard.press("Escape");
  // Sade tıklama seçimi bırakıp projeyi açar: sağ tık yine tek projenin menüsünü verir.
  await project("E2E Beta").click();
  await project("E2E Beta").click({ button: "right" });
  await expect(page.getByText("Projeyi sil", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await project("E2E Alfa").click({ modifiers: [MOD] });
  await project("E2E Alfa").click({ button: "right" });
  await page.getByText("Seçili 2 projeyi sil").click();
  await confirmDialog();
  await expect(project("E2E Alfa")).toBeHidden();
  await expect(project("E2E Beta")).toBeHidden();
  await expect(project("E2E Gama")).toBeVisible();
  await project("E2E Gama").click({ button: "right" });
  await page.getByText("Projeyi sil", { exact: true }).click();
  await confirmDialog();
  await expect(project("E2E Gama")).toBeHidden();
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

test("kenar çubuğunda çoklu sohbet seçimi ve toplu silme", async () => {
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();
  // Sohbet açmak için bağlı sağlayıcı ve seçili klasör gerekir; ikisi de köprüden verilir
  // (klasör seçici yerel pencere açtığından sürülemez), sonra pencere yeniden yüklenir.
  const repo = mkdtempSync(join(tmpdir(), "codezal-e2e-repo-"));
  await bridgeInvoke("models:setApiKey", { provider: "anthropic", apiKey: "sk-ant-e2e-cccc3333" });
  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  const sidebar = page.locator("aside");
  const chat = (name: string) => sidebar.getByText(name, { exact: true });
  for (const text of ["Birinci sohbet", "İkinci sohbet", "Üçüncü sohbet", "Dördüncü sohbet"]) {
    await page.getByRole("button", { name: "Yeni", exact: true }).click();
    const composer = page.getByPlaceholder("Ne yapalım?");
    await composer.click();
    await composer.fill(text);
    await composer.press("Enter");
    await expect(chat(text)).toBeVisible();
  }
  // Açılan sohbet seçimin başlangıcıdır; Cmd/Ctrl iki sohbet daha ekler. (Sohbet sırası son değişiklik
  // zamanıyla kayabildiğinden Shift aralığı burada değil, Projeler testinde denenir.)
  await chat("Birinci sohbet").click();
  await chat("İkinci sohbet").click({ modifiers: [MOD] });
  await chat("Üçüncü sohbet").click({ modifiers: [MOD] });
  await chat("Üçüncü sohbet").click({ button: "right" });
  await expect(page.getByText("3 satır seçildi")).toBeVisible();
  await page.getByText("Seçili 3 sohbeti sil").click();
  await confirmDialog();
  await expect(chat("Birinci sohbet")).toBeHidden();
  await expect(chat("İkinci sohbet")).toBeHidden();
  await expect(chat("Üçüncü sohbet")).toBeHidden();
  await expect(chat("Dördüncü sohbet")).toBeVisible();
  // Sonraki testler anahtarsız durumu bekliyor.
  await bridgeInvoke("models:logout", { provider: "anthropic" });
  rmSync(repo, { recursive: true, force: true });
});

test("Değişiklikler sağ panelde açılır ve geri alma onayı onun üstünde çıkar", async () => {
  await page.evaluate(() => localStorage.setItem("codezal.welcome", '{"done":true}'));
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible()) await later.click();

  // Modal bir git deposu ister: izlenen bir dosya değiştirilir, böylece liste dolu gelir.
  const repo = mkdtempSync(join(tmpdir(), "codezal-e2e-changes-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  try {
    git(["init"]);
  } catch {
    test.skip(true, "git bulunamadı");
    return;
  }
  git(["config", "user.email", "e2e@codezal.test"]);
  git(["config", "user.name", "e2e"]);
  writeFileSync(join(repo, "notlar.txt"), "bir\n");
  git(["add", "."]);
  git(["commit", "-m", "ilk"]);
  writeFileSync(join(repo, "notlar.txt"), "bir\niki\n");

  await bridgeInvoke("project:open", { path: repo });
  await page.evaluate(
    (path) =>
      localStorage.setItem("codezal.projects", JSON.stringify({ paths: { kodlama: path } })),
    repo,
  );
  // Sohbet açmak sağlayıcı ister; anahtar köprüden verilir (klasör seçici yerel pencere açar).
  await bridgeInvoke("models:setApiKey", {
    provider: "anthropic",
    apiKey: "sk-ant-e2e-dddd4444",
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Depoda bir oturum açılır: başlıktaki menüden Değişiklikler sekmesine gidilecek.
  await page.getByRole("button", { name: "Yeni", exact: true }).click();
  const composer = page.getByPlaceholder("Ne yapalım?");
  await composer.click();
  await composer.fill("Değişiklik testi");
  await composer.press("Enter");
  await expect(page.locator("aside").getByText("Değişiklik testi", { exact: true })).toBeVisible();

  await page.locator("main").getByRole("button", { name: "···" }).click();
  // Aynı metin sağdaki "Değişiklikler 1 dosya" düğmesinde de geçer; menü katmanı App'te
  // <main>'den sonra çizildiği için menü satırı son eşleşmedir.
  await page.getByText("Değişiklikler", { exact: true }).last().click();
  // Değişiklikler artık pencere değil, sağ panelde bir sekme: panel açılır ve liste orada çizilir.
  const panel = page.locator(".cz-slide").last();
  await expect(panel.getByText("notlar.txt")).toBeVisible();
  await expect(page.locator(".cz-modal")).toHaveCount(0);

  // Dosya açılınca ham yama değil, satır satır diff görünümü çizilir (satır numarası cetveli).
  await panel.getByText("notlar.txt", { exact: true }).click();
  await expect(panel.getByText("iki", { exact: false })).toBeVisible();
  await expect(panel.getByText("@@", { exact: false })).toHaveCount(0);

  await panel.getByRole("button", { name: /tümünü geri al/ }).click();
  // Onay penceresi panelin üstünde açılır; kapanmazsa akış kilitlenir.
  const modals = page.locator(".cz-modal");
  await expect(modals).toHaveCount(1);
  await modals.getByRole("button", { name: "Geri al", exact: true }).click();
  await expect(modals).toHaveCount(0);
  await expect(panel.getByText("Çalışma ağacı temiz.")).toBeVisible();

  // Sekme kapatılır: sonraki testler paneli açık bulmasın.
  await page.getByTitle("Paneli kapat").click();
  await page.evaluate(() => localStorage.removeItem("codezal.projects"));
  await bridgeInvoke("models:logout", { provider: "anthropic" });
  rmSync(repo, { recursive: true, force: true });
});

test("renderer konsolunda hata yok", async () => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("button", { name: "Asistan", exact: true }).click();
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

/** Tanılama sayfası: halka tampondan gelen canlı günlük ve tanı paketi düğmesi görünmeli. */
test("Ayarlar > Tanılama: canlı günlük ve tanı paketi", async () => {
  // Karşılama katmanı açıkken kenar çubuğunu örter; test tek başına da koşabilsin.
  const later = page.getByRole("button", { name: "Şimdi değil" });
  if (await later.isVisible().catch(() => false)) await later.click();
  await openSettings();
  await page.getByRole("button", { name: "Tanılama", exact: true }).click();
  await expect(page.getByText("Canlı günlük")).toBeVisible();
  // Açılış satırı main'in halka tamponundan gelir: `app:logTail` gerçekten veri döndürüyor.
  await expect(page.getByText(/Codezal .* başlıyor/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Tanı paketini kopyala" })).toBeVisible();
  await page.keyboard.press("Escape");
});
