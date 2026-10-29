import type { AppContext } from "../context.js";
import { i18n } from "../i18n.js";
import { broadcast, handle } from "../ipc.js";
import { openExternalSafe } from "../links.js";

/** Sağlayıcı ve model kanalları: katalog, API anahtarı, OAuth / cihaz kodu akışı. */
export function registerModelsIpc({ engine: eng }: AppContext): void {
  // Arka plandaki uzak katalog tazelemesi listeyi değiştirdiyse arayüz kataloğu yeniden çeker.
  eng.onCatalogChange(() => broadcast("models:changed", {}));
  handle("models:catalog", () => eng.catalog());
  handle("models:refresh", () => eng.refreshCatalog(true));
  handle("models:providers", () => eng.providers());
  handle("models:setApiKey", ({ provider, apiKey, label }) =>
    eng.setApiKey(provider, apiKey, label),
  );
  handle("models:logout", ({ provider }) => eng.logout(provider));
  handle("models:removeApiKey", ({ provider, keyId }) => eng.removeApiKey(provider, keyId));
  handle("models:activateApiKey", ({ provider, keyId }) => eng.activateApiKey(provider, keyId));
  handle("models:keyHint", async ({ provider }) => {
    const rt = await eng.runtime();
    const p = rt.getProviders().find((x) => x.id === provider);
    return p?.auth.apiKey?.name ?? null;
  });

  const oauthFlows = new Map<string, AbortController>();
  const oauthCodeWaiters = new Map<string, (code: string) => void>();
  handle("models:oauthLogin", async ({ provider }) => {
    oauthFlows.get(provider)?.abort();
    const ac = new AbortController();
    oauthFlows.set(provider, ac);
    const send = (kind: "url" | "code" | "message" | "done" | "error", text: string) =>
      broadcast("oauth:progress", { provider, kind, text });
    try {
      await eng.oauthLogin(provider, {
        signal: ac.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select") return prompt.options[0]?.id ?? "";
          if (prompt.type === "manual_code" || prompt.type === "text") {
            // Kod ya localhost geri çağrısıyla (Pi kendi sunucusunu açar) ya da kullanıcı yapıştırınca gelir.
            send("message", prompt.message);
            return new Promise<string>((resolveCode, reject) => {
              oauthCodeWaiters.set(provider, (code) => {
                oauthCodeWaiters.delete(provider);
                resolveCode(code);
              });
              const cancel = () => {
                oauthCodeWaiters.delete(provider);
                reject(new Error(i18n.t("errors.oauthCancelled")));
              };
              prompt.signal?.addEventListener("abort", cancel);
              ac.signal.addEventListener("abort", cancel);
            });
          }
          throw new Error(i18n.t("prompt.oauthTypeUnsupported", { type: prompt.type }));
        },
        notify: (ev) => {
          if (ev.type === "auth_url") {
            void openExternalSafe(ev.url);
            send("url", ev.url);
          } else if (ev.type === "device_code") {
            void openExternalSafe(ev.verificationUri);
            send("code", `${ev.userCode}`);
            send(
              "message",
              i18n.t("prompt.enterCode", { uri: ev.verificationUri, code: ev.userCode }),
            );
          } else if (ev.type === "info" || ev.type === "progress") send("message", ev.message);
        },
      });
      send("done", i18n.t("settings.connection.connected"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      send("error", msg);
      throw error;
    } finally {
      oauthFlows.delete(provider);
    }
  });
  handle("models:oauthCode", ({ provider, code }) => {
    const w = oauthCodeWaiters.get(provider);
    if (!w) throw new Error(i18n.t("errors.noAuthFlow"));
    w(code.trim());
  });
  handle("models:oauthCancel", ({ provider }) => {
    oauthFlows.get(provider)?.abort();
    oauthFlows.delete(provider);
  });
}
