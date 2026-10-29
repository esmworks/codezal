import { LOCALE_CODES } from "@codezal/i18n";
import { useTranslation } from "react-i18next";
import { InputRow, Row, SelectRow, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

// ---------- Genel ----------

export function GenelPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  // Electron `setLoginItemSettings`'i yalnız macOS ve Windows'ta uygular; Linux'ta satır gizlenir.
  const loginItem = !navigator.userAgent.includes("Linux");
  const linkOptions: Array<{ value: S["linkTarget"]; label: string }> = [
    { value: "app", label: t("settings.genel.linkApp") },
    { value: "system", label: t("settings.genel.linkSystem") },
  ];
  const themes: Array<{ key: S["theme"]; label: string; left: string; right: string }> = [
    { key: "açık", label: t("settings.genel.themeLight"), left: "#f4f4f3", right: "#f4f4f3" },
    { key: "koyu", label: t("settings.genel.themeDark"), left: "#26292d", right: "#26292d" },
    { key: "sistem", label: t("settings.genel.themeSystem"), left: "#f4f4f3", right: "#26292d" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[14px] font-semibold text-tx2">{t("settings.genel.appTitle")}</div>
      <div className="overflow-hidden rounded-[14px] border border-line bg-card2">
        <Row label={t("settings.genel.themeLabel")} desc={t("settings.genel.themeDesc")} first>
          <div className="flex gap-[10px]">
            {themes.map((th) => {
              const on = s.theme === th.key;
              return (
                <button
                  type="button"
                  key={th.key}
                  onClick={() => patch({ theme: th.key })}
                  className="flex flex-col items-center gap-[6px]"
                >
                  <span
                    className={`flex h-[46px] w-[74px] overflow-hidden rounded-[8px] border-2 ${on ? "border-tx2" : "border-line2"}`}
                  >
                    <span className="flex-1" style={{ background: th.left }} />
                    <span className="flex-1" style={{ background: th.right }} />
                  </span>
                  <span className={`text-[12px] ${on ? "text-tx" : "text-tx3"}`}>{th.label}</span>
                </button>
              );
            })}
          </div>
        </Row>
        <ToggleRow
          label={t("settings.genel.menubarLabel")}
          desc={t("settings.genel.menubarDesc")}
          on={s.menubar}
          onChange={(v) => patch({ menubar: v })}
        />
        {loginItem ? (
          <ToggleRow
            label={t("settings.genel.startupLabel")}
            desc={t("settings.genel.startupDesc")}
            on={s.startup}
            onChange={(v) => patch({ startup: v })}
          />
        ) : null}
        <ToggleRow
          label={t("settings.genel.notificationsLabel")}
          desc={t("settings.genel.notificationsDesc")}
          on={s.notifications}
          onChange={(v) => patch({ notifications: v })}
        />
        <ToggleRow
          label={t("settings.genel.soundLabel")}
          desc={t("settings.genel.soundDesc")}
          on={s.notificationSound}
          onChange={(v) => patch({ notificationSound: v })}
          {...(s.notifications ? {} : { disabled: true })}
        />
        <ToggleRow
          label={t("settings.genel.awakeLabel")}
          desc={t("settings.genel.awakeDesc")}
          on={s.keepAwake}
          onChange={(v) => patch({ keepAwake: v })}
        />
        <ToggleRow
          label={t("settings.genel.autoTitleLabel")}
          desc={t("settings.genel.autoTitleDesc")}
          on={s.autoTitle}
          onChange={(v) => patch({ autoTitle: v })}
        />
        <SelectRow
          label={t("settings.genel.languageLabel")}
          desc={t("settings.genel.languageDesc")}
          value={s.language}
          options={LOCALE_CODES.map((code) => ({
            value: code,
            label: t(`settings.genel.languageNames.${code}`),
          }))}
          onChange={(v) => patch({ language: v })}
        />
      </div>
      <div className="pt-3 text-[14px] font-semibold text-tx2">
        {t("settings.genel.terminalTitle")}
      </div>
      <div className="overflow-hidden rounded-[14px] border border-line bg-card2">
        <InputRow
          first
          mono
          label={t("settings.genel.fontLabel")}
          desc={t("settings.genel.fontDesc")}
          value={s.terminalFont}
          placeholder={t("settings.genel.fontPlaceholder")}
          onChange={(v) => patch({ terminalFont: v })}
        />
      </div>
      <div className="pt-3 text-[14px] font-semibold text-tx2">
        {t("settings.genel.linksTitle")}
      </div>
      <div className="overflow-hidden rounded-[14px] border border-line bg-card2">
        <SelectRow
          first
          label={t("settings.genel.linkWebLabel")}
          desc={t("settings.genel.linkWebDesc")}
          value={s.linkTarget}
          options={linkOptions}
          onChange={(v) => patch({ linkTarget: v })}
        />
        <SelectRow
          label={t("settings.genel.linkLocalLabel")}
          desc={t("settings.genel.linkLocalDesc")}
          value={s.localLinkTarget}
          options={linkOptions}
          onChange={(v) => patch({ localLinkTarget: v })}
        />
      </div>
    </div>
  );
}
