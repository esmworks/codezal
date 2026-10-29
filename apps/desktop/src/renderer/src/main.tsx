import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App";
import { invoke } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { i18n } from "./lib/i18n";
import { watchScrollbars } from "./lib/scrollbars";
import { humanizeError, toast } from "./stores/toast";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error(i18n.t("errors.rootMissing"));

// `void invoke(...)` ile beklenmeyen IPC hataları ve diğer yakalanmamış reddetmeler burada yüzeye çıkar.
const report = (scope: string, error: unknown) => {
  const message = humanizeError(error);
  toast.error(message, {
    label: i18n.t("common.logs"),
    run: () => void invoke("app:openLogs", undefined).catch(() => undefined),
  });
  void invoke("app:logError", { scope, message }).catch(() => undefined);
};
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  report("renderer:promise", e.reason);
});
window.addEventListener("error", (e) => {
  report("renderer:error", e.error ?? e.message);
});

// Kaydırma çubukları yalnızca kaydırırken belirsin; uygulama boyunca tek dinleyici yeter.
watchScrollbars();

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nextProvider>
  </StrictMode>,
);
