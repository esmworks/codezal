import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": resolve(__dirname, "src/renderer/src") };

export default defineConfig({
  test: {
    // İki proje: ana süreç/depo testleri düz Node'da, renderer bileşen testleri JSX + asgari
    // tarayıcı ortamıyla koşar. Bileşen testleri `.tsx` uzantısıyla ayrılır (include deseni).
    projects: [
      {
        resolve: { alias },
        test: {
          name: "desktop",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
        },
      },
      {
        esbuild: { jsx: "automatic" },
        resolve: { alias },
        test: {
          name: "desktop-ui",
          environment: "node",
          include: ["src/**/*.test.tsx"],
          setupFiles: [resolve(__dirname, "src/renderer/src/test/dom-shim.ts")],
        },
      },
    ],
  },
});
