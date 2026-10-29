import { defineConfig } from "@playwright/test";

/** Uçtan uca: derlenmiş Electron uygulaması gerçekten açılır (`pnpm test:e2e`). */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
