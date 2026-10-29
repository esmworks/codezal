// pnpm, node-pty prebuild'lerindeki spawn-helper'ın çalıştırma iznini düşürüyor; macOS'ta
// posix_spawnp bu yüzden başarısız olur. Kurulumdan sonra izni geri veririz.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let dir;
try {
  dir = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
} catch {
  process.exit(0);
}
if (!existsSync(dir)) process.exit(0);
for (const platform of readdirSync(dir)) {
  const helper = join(dir, platform, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
