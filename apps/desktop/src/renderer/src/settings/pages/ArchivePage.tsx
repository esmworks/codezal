import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { askConfirm } from "../../components/Confirm";
import { shortAgo } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useNow } from "../../lib/useNow";
import { useSessions } from "../../stores/sessions";
import { ButtonRow, Row, Section, SelectRow, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

// ---------- Arşiv ----------

export function ArchivePage({ s: settings, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const lang = useLocale();
  const now = useNow();
  // Seçici içinde filtrelemek her renderda yeni dizi üretir; zustand bunu değişiklik sayıp
  // sonsuz döngüye girer. Kararlı `list` seçilir, süzme render sırasında yapılır.
  const list = useSessions((x) => x.list);
  const { setArchived, purgeArchived, loadList } = useSessions();
  const sessions = list.filter((x) => x.archived);
  useEffect(() => {
    void loadList();
  }, [loadList]);
  const days: Array<S["archiveDays"]> = ["3", "7", "14", "30"];
  return (
    <>
      <Section>
        <ToggleRow
          first
          label={t("settings.archive.autoLabel")}
          desc={t("settings.archive.autoDesc")}
          on={settings.autoArchive}
          onChange={(v) => patch({ autoArchive: v })}
        />
        <SelectRow
          label={t("settings.archive.retentionLabel")}
          desc={t("settings.archive.retentionDesc")}
          value={settings.archiveDays}
          options={days.map((d) => ({
            value: d,
            label: t("settings.archive.retentionDays", { count: Number(d) }),
          }))}
          onChange={(v) => patch({ archiveDays: v })}
        />
      </Section>
      <Section>
        {sessions.length === 0 ? (
          <Row
            first
            label={t("settings.archive.emptyLabel")}
            desc={t("settings.archive.emptyDesc")}
          />
        ) : null}
        {sessions.map((s, i) => (
          <ButtonRow
            key={s.id}
            first={i === 0}
            label={s.name}
            desc={t("settings.archive.agoDesc", {
              ago: shortAgo(s.modifiedAt, lang, now),
              dir: s.cwd.split("/").pop() ?? "",
            })}
            value={t("settings.archive.restore")}
            onClick={() => void setArchived(s.id, false)}
          />
        ))}
        {sessions.length > 0 ? (
          <ButtonRow
            label={t("settings.archive.purgeLabel")}
            desc={t("settings.archive.purgeDesc", { count: sessions.length })}
            value={t("settings.archive.purgeAction")}
            danger
            onClick={() => {
              void askConfirm({
                title: t("settings.archive.purgeLabel"),
                body: t("settings.archive.confirmPurge"),
                okLabel: t("settings.archive.purgeAction"),
                danger: true,
              }).then((ok) => {
                if (ok) void purgeArchived();
              });
            }}
          />
        ) : null}
      </Section>
    </>
  );
}
