import { handle } from "../ipc.js";
import { listOpenWithApps, openWith } from "../open-with.js";

/** "Şurada aç" kanalları: kurulu harici uygulamalar ve proje klasörünü onlarda açma. */
export function registerOpenWithIpc(): void {
  handle("openWith:list", () => listOpenWithApps());
  handle("openWith:open", ({ appId, path }) => openWith(appId, path));
}
