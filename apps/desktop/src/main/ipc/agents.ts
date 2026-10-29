import { existsSync, mkdirSync, statSync } from "node:fs";
import { shell } from "electron";
import type { AppContext } from "../context.js";
import { broadcast, handle } from "../ipc.js";

/**
 * Ajan kanalları (Ayarlar > Ajanlar). Depo motorda durur (`engine.agents`): aynı tanımlar alt
 * ajan koşularında da okunur, böylece sayfada kaydedilen değişiklik modelin gördüğü listeyle
 * ayrışmaz. Her yazma sonrası `agents:changed` yayınlanır ve açık oturumlar tazelenir; `agent`
 * aracının tanımı hangi ajanların çağrılabileceğini oturum açılışında bu listeden alır.
 */
export function registerAgentsIpc({ engine: eng }: AppContext): void {
  const changed = () => {
    broadcast("agents:changed", {});
    void eng.reloadLiveSessions();
  };
  const agents = eng.agents;

  handle("agents:list", ({ cwd }) => agents.list(cwd));
  handle("agents:create", ({ cwd, draft }) => {
    try {
      return agents.create(cwd, draft);
    } finally {
      changed();
    }
  });
  handle("agents:update", ({ cwd, id, draft }) => {
    try {
      return agents.update(cwd, id, draft);
    } finally {
      changed();
    }
  });
  handle("agents:delete", ({ cwd, id }) => {
    try {
      agents.remove(cwd, id);
    } finally {
      changed();
    }
  });
  handle("agents:setEnabled", ({ id, enabled }) => {
    try {
      agents.setEnabled(id, enabled);
    } finally {
      changed();
    }
  });
  handle("agents:setModelOverride", ({ id, model }) => {
    try {
      agents.setModelOverride(id, model);
    } finally {
      changed();
    }
  });
  handle("agents:reveal", async ({ path }) => {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    if (statSync(path).isDirectory()) await shell.openPath(path);
    else shell.showItemInFolder(path);
  });
  // İlk açılışta kullanıcı klasörü hazır olsun: dosyayı elle eklemek isteyen kullanıcı
  // "klasörü aç" dediğinde boş bir yol görmesin.
  agents.ensureUserDir();
}
