import type { UpdateStatus } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, on } from "../../api";
import { ButtonRow, InputRow, Row, Section, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

// ---------- Hesap ----------

function About() {
  const [v, setV] = useState<{ app: string; electron: string; pi: string } | null>(null);
  useEffect(() => {
    void invoke("app:version", undefined).then(setV);
  }, []);
  return (
    <div className="flex items-center gap-[14px] px-[18px] py-[14px]">
      <img src="./brand/icon.png" alt="Codezal" width={44} height={44} className="rounded-[10px]" />
      <div className="flex-1">
        <div className="text-[14px] font-semibold">Codezal {v ? v.app : ""}</div>
        <div className="font-mono text-[12px] text-tx3">
          {v ? `Pi ${v.pi} · Electron ${v.electron}` : "…"}
        </div>
      </div>
    </div>
  );
}

function UpdateRow() {
  const { t } = useTranslation();
  const [st, setSt] = useState<UpdateStatus>({ state: "idle" });
  useEffect(() => on("update:status", setSt), []);
  const text =
    st.state === "disabled"
      ? t("settings.account.updateDisabled")
      : st.state === "idle"
        ? t("settings.account.updateIdle")
        : st.state === "checking"
          ? t("settings.account.updateChecking")
          : st.state === "available"
            ? t("settings.account.updateAvailable")
            : st.state === "downloading"
              ? t("settings.account.updateDownloading")
              : st.state === "ready"
                ? t("settings.account.updateReady")
                : t("settings.account.updateError");
  const desc =
    st.state === "downloading"
      ? `${text} %${st.percent ?? 0}`
      : st.state === "error"
        ? `${text}: ${st.message ?? ""}`
        : `${text}${st.version ? ` · ${st.version}` : ""}`;
  // Eylem duruma göre: indirildiyse yeniden başlat, bilinen yeni sürüm varsa indir, yoksa denetle.
  const knownVersion = !!st.version && st.version !== st.currentVersion;
  const action =
    st.state === "ready"
      ? {
          label: t("settings.account.restartAction"),
          run: () => void invoke("app:installUpdate", undefined),
        }
      : st.state === "available" && knownVersion
        ? {
            label: t("settings.account.downloadAction"),
            run: () => void invoke("app:downloadUpdate", undefined).then(setSt),
          }
        : {
            label: t("settings.account.updateAction"),
            run: () => void invoke("app:checkUpdates", undefined).then(setSt),
          };
  return (
    <ButtonRow
      label={t("settings.account.updateLabel")}
      desc={desc}
      value={action.label}
      disabled={st.state === "disabled" || st.state === "checking" || st.state === "downloading"}
      onClick={action.run}
    />
  );
}

export function AccountPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const [exported, setExported] = useState<string | null>(null);
  return (
    <>
      <Section title={t("settings.account.profileTitle")}>
        <InputRow
          first
          label={t("settings.account.nameLabel")}
          desc={t("settings.account.nameDesc")}
          value={s.profileName}
          onChange={(v) => patch({ profileName: v })}
        />
        <Row label={t("settings.account.planLabel")} desc={t("settings.account.planDesc")} />
      </Section>
      <Section title={t("settings.account.appTitle")}>
        <About />
        <UpdateRow />
        <ToggleRow
          label={t("settings.account.autoUpdateLabel")}
          desc={t("settings.account.autoUpdateDesc")}
          on={s.autoUpdate}
          onChange={(v) => patch({ autoUpdate: v })}
        />
      </Section>
      <Section title={t("settings.account.dataTitle")}>
        <ButtonRow
          first
          label={t("settings.account.exportLabel")}
          desc={
            exported
              ? t("settings.account.exportSaved", { path: exported })
              : t("settings.account.exportDesc")
          }
          value={t("settings.account.exportAction")}
          onClick={() => void invoke("settings:exportData", undefined).then(setExported)}
        />
      </Section>
    </>
  );
}
