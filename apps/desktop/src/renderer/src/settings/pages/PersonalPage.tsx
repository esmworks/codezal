import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Button } from "../../components/Button";
import { useCurrentProject, useProjects } from "../../stores/projects";
import { ButtonRow, Section, ToggleRow } from "../rows";

import type { Patch, S } from "./common";
import { HooksSection, SandboxSection } from "./SafetySections";

// ---------- Kişiselleştirme ----------

export function PersonalPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const setTrusted = useProjects((p) => p.setTrusted);
  const [text, setText] = useState(s.globalInstructions);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Section title={t("settings.personal.title")}>
        <ButtonRow
          first
          label={t("settings.personal.globalLabel")}
          desc={
            s.globalInstructions.trim()
              ? `${s.globalInstructions.trim().slice(0, 90)}${s.globalInstructions.length > 90 ? "…" : ""}`
              : t("settings.personal.globalEmpty")
          }
          value={editing ? t("common.close") : t("settings.personal.edit")}
          onClick={() => setEditing(!editing)}
        />
        {editing ? (
          <div className="flex flex-col gap-2 border-t border-line px-[18px] py-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={t("settings.personal.placeholder")}
              className="w-full resize-y rounded-[10px] border border-line2 bg-card px-3 py-2 text-[13px] leading-[1.5] text-tx outline-none placeholder:text-tx3"
            />
            <div className="text-[12px] leading-[1.45] text-tx3">
              {t("settings.personal.globalHint")}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setText(s.globalInstructions)}>
                {t("settings.personal.undo")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => patch({ globalInstructions: text })}
              >
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : null}
        <ButtonRow
          label={t("settings.personal.projectLabel")}
          desc={
            current
              ? t("settings.personal.projectDescFile", { path: current.name })
              : t("settings.personal.projectDescNone")
          }
          value={t("common.open")}
          disabled={!current}
          onClick={() =>
            void invoke("settings:openFile", {
              which: "project",
              ...(current ? { cwd: current.path } : {}),
            })
          }
        />
      </Section>
      <Section title={t("settings.personal.projectConfigTitle")}>
        <ButtonRow
          first
          label={t("settings.personal.projectConfigLabel")}
          desc={
            current
              ? t("settings.personal.projectConfigDesc", {
                  path: `${current.name}/.codezal/ayarlar.json`,
                })
              : t("settings.personal.projectDescNone")
          }
          value={t("common.open")}
          disabled={!current}
          onClick={() => {
            if (!current) return;
            // Main dosyayı açarken projeyi güvenilir sayıyor; anahtarın da yansıması için mağaza güncellenir.
            void invoke("settings:openFile", { which: "projectConfig", cwd: current.path }).then(
              () => setTrusted(current.path, true),
            );
          }}
        />
        <ButtonRow
          label={t("settings.personal.projectConfigLocalLabel")}
          desc={
            current
              ? t("settings.personal.projectConfigLocalDesc", {
                  path: `${current.name}/.codezal/ayarlar.local.json`,
                })
              : t("settings.personal.projectDescNone")
          }
          value={t("common.open")}
          disabled={!current}
          onClick={() => {
            if (!current) return;
            // Main dosyayı açarken projeyi güvenilir sayıyor; anahtarın da yansıması için mağaza güncellenir.
            void invoke("settings:openFile", {
              which: "projectConfigLocal",
              cwd: current.path,
            }).then(() => setTrusted(current.path, true));
          }}
        />
        {current ? (
          <ToggleRow
            label={t("settings.personal.trustLabel")}
            desc={t("settings.personal.trustDesc")}
            on={current.trusted === true}
            onChange={(v) => void setTrusted(current.path, v)}
          />
        ) : null}
      </Section>
      <SandboxSection s={s} patch={patch} />
      <HooksSection />
      <Section title={t("settings.personal.behaviorTitle")}>
        <ToggleRow
          first
          label={t("settings.personal.greetLabel")}
          desc={t("settings.personal.greetDesc")}
          on={s.greet}
          onChange={(v) => patch({ greet: v })}
        />
        <ToggleRow
          label={t("settings.personal.cardsLabel")}
          desc={t("settings.personal.cardsDesc")}
          on={s.cards}
          onChange={(v) => patch({ cards: v })}
        />
        <ToggleRow
          label={t("settings.personal.summaryLabel")}
          desc={t("settings.personal.summaryDesc")}
          on={s.summary}
          onChange={(v) => patch({ summary: v })}
        />
      </Section>
    </>
  );
}
