import { commandAnchor } from "../lib/commandAnchor";
import { useApp } from "../stores/app";
import { useModels } from "../stores/models";
import { useSessions } from "../stores/sessions";
import type { CommandPorts } from "./commands";

/**
 * Komutların oturum bağlantı noktaları. İki çağrı yolu da (gönderim kapısı ve `/` paleti) aynı
 * kurulumu kullanır: seçim oturuma yazılır, oturumun kendi değerleri menüde işaretlenir. Giriş
 * ekranında oturum yoktur, seçim genel tercihe yazılır — çiplerin davranışının aynısı.
 *
 * Ayrı dosyada durur çünkü `stores/sessions` komut çalıştırıcısını import eder; port kurucusu
 * ters yönde import ettiği için aynı dosyada olsalardı döngü doğardı.
 */
export function sessionCommandPorts(id: string): CommandPorts {
  const sessions = useSessions.getState();
  const runtime = sessions.runtime[id];
  const global = useModels.getState();
  return {
    sessionId: id,
    anchor: commandAnchor(),
    model: runtime?.model ?? global.model ?? null,
    permission: runtime?.permission ?? global.permission,
    thinking: runtime?.thinking ?? global.thinking,
    setModel: (ref) => {
      void sessions.setModel(id, ref);
    },
    setThinking: (level) => {
      void sessions.setThinking(id, level);
    },
    setPermission: (mode) => {
      void sessions.setPermission(id, mode);
    },
    compact: () => sessions.compact(id),
    goal: (action, text) => sessions.goal(id, action, text),
    newTask: () => useApp.getState().goHome(),
  };
}

/** Giriş ekranı (oturum yok): model/mod/seviye seçimleri genel tercihe yazılır. */
export function homeCommandPorts(): CommandPorts {
  const models = useModels.getState();
  return {
    sessionId: null,
    anchor: commandAnchor(),
    model: models.model ?? null,
    permission: models.permission,
    thinking: models.thinking,
    setModel: (ref) => {
      void models.setModel(ref);
    },
    setThinking: (level) => {
      void models.setThinking(level);
    },
    setPermission: (mode) => {
      void models.setPermission(mode);
    },
    // Oturum yokken bu komutlar listelenmez (`sessionOnly`); çağrılırsa komut katmanı hata verir.
    compact: () => Promise.reject(new Error("no-session")),
    goal: () => Promise.reject(new Error("no-session")),
    newTask: () => useApp.getState().goHome(),
  };
}
