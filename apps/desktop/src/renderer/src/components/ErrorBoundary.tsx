import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Button } from "./Button";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Render hatasında beyaz ekran yerine kısa açıklama ve yeniden yükleme düğmesi. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void invoke("app:logError", {
      scope: "renderer:render",
      message: `${error.message}\n${info.componentStack ?? ""}`,
    }).catch(() => undefined);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <Fallback error={error} />;
  }
}

function Fallback({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-bg px-10 text-tx">
      <div className="text-[18px] font-semibold">{t("common.wentWrong")}</div>
      <pre className="max-w-[640px] overflow-auto rounded-[10px] border border-line bg-card2 px-4 py-3 font-mono text-[12px] text-tx2">
        {error.message}
      </pre>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t("common.reload")}
        </Button>
        <Button onClick={() => void invoke("app:openLogs", undefined)}>
          {t("common.openLogs")}
        </Button>
      </div>
    </div>
  );
}
