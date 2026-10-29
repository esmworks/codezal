import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { loadEnv } from "vite";

// Workspace paketleri TypeScript kaynağı olarak tüketilir; bundle'a dahil edilmeli.
const workspacePackages = ["@codezal/agent", "@codezal/contracts", "@codezal/i18n", "@codezal/ui"];

/**
 * Yayıncının Google OAuth istemcisi derlemede gömülür; Google dinamik istemci kaydını
 * desteklemediği için bu olmadan her kullanıcı kendi Cloud projesini açmak zorunda kalır. Değerler
 * depo kökündeki `.env` dosyasından (git dışıdır) ya da ortam değişkeninden okunur; verilmezse
 * uygulama kullanıcıdan kendi istemcisini ister. "Masaüstü uygulaması" tipi istemci kullan: Google
 * bu tipte gizli anahtarı sır saymaz (RFC 8252) ve her loopback kapısını kabul eder.
 */
const env = loadEnv(process.env.NODE_ENV ?? "production", resolve(__dirname, "../.."), "CODEZAL_");
const builtInOauth = {
  __GOOGLE_CLIENT_ID__: JSON.stringify(env.CODEZAL_GOOGLE_CLIENT_ID ?? ""),
  __GOOGLE_CLIENT_SECRET__: JSON.stringify(env.CODEZAL_GOOGLE_CLIENT_SECRET ?? ""),
};

export default defineConfig({
  main: {
    define: builtInOauth,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
  },
  preload: {
    // Sandbox'lı preload ESM olamaz; CJS olarak tek dosyaya paketlenir.
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": resolve(__dirname, "src/renderer/src") },
    },
  },
});
