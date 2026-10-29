import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";
import { loadJson, saveJson } from "../lib/storage";
import { useApp } from "../stores/app";
import { useModels } from "../stores/models";

const KEY = "codezal.welcome";

/**
 * İlk açılış: bağlı sağlayıcı yokken tek seferlik karşılama (PRD §9, §11). Ajanın kullanıcının
 * işletim sistemi izinleriyle çalıştığı burada açıkça söylenir.
 */
export function Welcome() {
  const { t } = useTranslation();
  const providers = useModels((s) => s.providers);
  const loading = useModels((s) => s.loading);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const [dismissed, setDismissed] = useState(
    () => loadJson<{ done: boolean }>(KEY, { done: false }).done,
  );
  const anyConnected = providers.some((p) => p.connected);
  if (dismissed || loading || providers.length === 0 || anyConnected) return null;

  const close = () => {
    saveJson(KEY, { done: true });
    setDismissed(true);
  };

  const steps: Array<{ icon: IconName; title: string; desc: string }> = [
    {
      icon: "globe",
      title: t("welcome.step1Title"),
      desc: t("welcome.step1Desc"),
    },
    { icon: "folder", title: t("welcome.step2Title"), desc: t("welcome.step2Desc") },
    { icon: "send", title: t("welcome.step3Title"), desc: t("welcome.step3Desc") },
  ];

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--scrim)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("welcome.title")}
        className="flex w-[520px] max-w-[92vw] flex-col gap-5 rounded-[18px] border border-line2 bg-card p-7 shadow-panel"
      >
        <div className="flex items-center gap-3">
          <img src="./brand/icon.png" alt="" width={40} height={40} className="rounded-[10px]" />
          <div>
            <div className="text-[18px] font-semibold tracking-[-0.01em]">{t("welcome.title")}</div>
            <div className="text-[13px] text-tx3">{t("welcome.subtitle")}</div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <div key={s.title} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-chip text-tx2">
                <Icon name={s.icon} size={14} />
              </span>
              <div>
                <div className="text-[14px] font-medium">
                  {i + 1}. {s.title}
                </div>
                <div className="text-[13px] leading-[1.45] text-tx3">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-[10px] border border-line bg-card2 px-4 py-3 text-[12px] leading-[1.5] text-tx3">
          {t("welcome.note1")} {t("welcome.note2a")} <span className="font-mono">rm -rf</span>{" "}
          {t("welcome.note2b")}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              close();
              setSettingsOpen(true, "baglanti");
            }}
          >
            {t("welcome.connect")}
          </Button>
          <Button variant="ghost" size="lg" onClick={close}>
            {t("welcome.later")}
          </Button>
        </div>
      </div>
    </div>
  );
}
