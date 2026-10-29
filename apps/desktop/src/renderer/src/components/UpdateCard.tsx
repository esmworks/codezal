import { useTranslation } from "react-i18next";
import { updateView, useUpdate } from "../stores/update";
import { Button } from "./Button";
import { Icon } from "./Icon";

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Eski Tauri sürümündeki güncelleme kartı: sağ altta sürüm karşılaştırması, sürüm notları ve
 * ilerleme; "Sonra" deyince köşedeki kalıcı rozete küçülür, tıklayınca geri açılır.
 */
export function UpdateCard() {
  const { t } = useTranslation();
  const status = useUpdate((s) => s.status);
  const minimized = useUpdate((s) => s.minimized);
  const snoozed = useUpdate((s) => s.snoozed);
  const snooze = useUpdate((s) => s.snooze);
  const reopen = useUpdate((s) => s.reopen);
  const download = useUpdate((s) => s.download);
  const install = useUpdate((s) => s.install);

  const view = updateView(status, minimized, snoozed);
  if (view === "hidden") return null;
  const version = status.version ?? "";
  const failed = status.state === "error";
  const busy = status.state === "downloading";
  const ready = status.state === "ready";
  const percent = status.percent ?? null;
  const total = status.total ?? 0;
  const transferred = status.transferred ?? 0;

  if (view === "badge") {
    const label = t("update.badge", { version });
    return (
      <button
        type="button"
        onClick={reopen}
        aria-label={label}
        title={label}
        className="pointer-events-auto flex items-center gap-1.5 self-end rounded-full border border-line bg-card py-1.5 pr-3 pl-2.5 text-[12px] font-medium text-tx2 shadow-panel transition-colors hover:bg-hov hover:text-tx"
      >
        <span className="relative flex h-4 w-4 items-center justify-center">
          <Icon name="sparkle" size={13} className="text-acc" />
          {ready ? (
            <span
              className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-acc"
              aria-hidden="true"
            />
          ) : null}
        </span>
        v{version}
      </button>
    );
  }

  const desc = failed
    ? status.message || "—"
    : busy
      ? t("update.downloading")
      : ready
        ? t("update.ready")
        : t("update.available", { version });

  return (
    <div
      role="status"
      className="pointer-events-auto overflow-hidden rounded-[12px] border border-line bg-card shadow-panel"
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            failed ? "bg-chip text-tx2" : "bg-accSoft text-acc"
          }`}
        >
          <Icon
            name={failed ? "bug" : busy ? "loop" : ready ? "check" : "sparkle"}
            size={15}
            className={busy ? "animate-spin" : ""}
          />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[13px] font-semibold text-tx">
            {failed ? t("update.failed") : t("update.title")}
          </div>
          <div className="mt-0.5 break-words text-[12px] leading-[1.4] text-tx3">{desc}</div>
        </div>
        <button
          type="button"
          onClick={snooze}
          aria-label={t("update.later")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-tx3 hover:bg-hov hover:text-tx"
        >
          <Icon name="x" size={11} stroke={2} />
        </button>
      </div>

      <div className="px-4 pb-1">
        {!failed && status.currentVersion ? (
          <div className="mb-3 flex items-center gap-2 text-[12px]">
            <code className="rounded bg-card2 px-1.5 py-0.5 text-tx3">
              v{status.currentVersion}
            </code>
            <span className="text-tx3">→</span>
            <code className="rounded bg-accSoft px-1.5 py-0.5 font-medium text-acc">
              v{version}
            </code>
          </div>
        ) : null}

        {status.releaseNotes && !failed ? (
          <div className="mb-3 max-h-28 overflow-y-auto rounded-[8px] border border-line bg-card2 p-2.5">
            <div className="mb-1 text-[11px] font-medium tracking-wide text-tx3 uppercase">
              {t("update.releaseNotes")}
            </div>
            {/* Sürüm notu düz metin gelir; satır sonları korunur. */}
            <div className="whitespace-pre-wrap text-[12px] text-tx2">{status.releaseNotes}</div>
          </div>
        ) : null}

        {busy ? (
          <div className="py-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-card2">
              <div
                className={`h-full rounded-full bg-acc transition-[width] duration-200 ${
                  percent === null ? "w-1/3 animate-pulse" : ""
                }`}
                style={percent !== null ? { width: `${percent}%` } : undefined}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11.5px] text-tx3">
              <span>{t("update.downloading")}</span>
              <span>
                {percent !== null ? `%${percent}` : ""}
                {total > 0 ? ` · ${mb(transferred)}/${mb(total)} MB` : ""}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        {status.state === "available" ? (
          <>
            <Button variant="ghost" size="sm" onClick={snooze}>
              {t("update.later")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void download()}>
              {t("update.download")}
            </Button>
          </>
        ) : null}
        {busy ? (
          <>
            <span className="mr-auto text-[11.5px] text-tx3">{t("update.downloadingHint")}</span>
            <Button variant="ghost" size="sm" onClick={snooze}>
              {t("update.later")}
            </Button>
          </>
        ) : null}
        {ready ? (
          <>
            <Button variant="ghost" size="sm" onClick={snooze}>
              {t("update.later")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void install()}>
              {t("update.restart")}
            </Button>
          </>
        ) : null}
        {failed ? (
          <>
            <Button variant="ghost" size="sm" onClick={snooze}>
              {t("update.later")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download()}>
              {t("update.retry")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
