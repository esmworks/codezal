import { defineConfig } from "vitest/config";

export default defineConfig({
  // PI_OFFLINE: motor açılışta uzak model kataloğunu çekmesin, testler ağa çıkmaz.
  test: { name: "agent", include: ["src/**/*.test.ts"], env: { PI_OFFLINE: "1" } },
});
