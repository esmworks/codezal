import { useTranslation } from "react-i18next";
import { InputRow, Section, SelectRow, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

// ---------- Kod incelemesi ----------

export function ReviewPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Section title={t("settings.review.checksTitle")}>
        <ToggleRow
          first
          label={t("settings.review.reviewLabel")}
          desc={t("settings.review.reviewDesc")}
          on={s.review}
          onChange={(v) => patch({ review: v })}
        />
        <ToggleRow
          label={t("settings.review.lintToggleLabel")}
          desc={s.lintCmd || t("settings.review.noCommand")}
          on={s.lintOn}
          onChange={(v) => patch({ lintOn: v })}
        />
        <InputRow
          label={t("settings.review.lintInputLabel")}
          value={s.lintCmd}
          onChange={(v) => patch({ lintCmd: v })}
          placeholder="pnpm lint"
          mono
        />
        <ToggleRow
          label={t("settings.review.testToggleLabel")}
          desc={s.testCmd || t("settings.review.noCommand")}
          on={s.testOn}
          onChange={(v) => patch({ testOn: v })}
        />
        <InputRow
          label={t("settings.review.testInputLabel")}
          value={s.testCmd}
          onChange={(v) => patch({ testCmd: v })}
          placeholder="pnpm test"
          mono
        />
        <ToggleRow
          label={t("settings.review.buildToggleLabel")}
          desc={s.buildCmd || t("settings.review.noCommand")}
          on={s.buildOn}
          onChange={(v) => patch({ buildOn: v })}
        />
        <InputRow
          label={t("settings.review.buildInputLabel")}
          value={s.buildCmd}
          onChange={(v) => patch({ buildCmd: v })}
          placeholder="pnpm build"
          mono
        />
        <ToggleRow
          label={t("settings.review.turnChecksLabel")}
          desc={t("settings.review.turnChecksDesc")}
          on={s.turnChecks}
          onChange={(v) => patch({ turnChecks: v })}
        />
        <ToggleRow
          label={t("settings.review.reviewerLabel")}
          desc={t("settings.review.reviewerDesc")}
          on={s.reviewerOn}
          onChange={(v) => patch({ reviewerOn: v })}
        />
      </Section>
      <Section title={t("settings.review.commitTitle")}>
        <SelectRow
          first
          label={t("settings.review.msgFormatLabel")}
          value={s.commitFormat}
          options={[
            { value: "conventional", label: "Conventional" },
            { value: "free", label: t("settings.review.formatFree") },
            { value: "short", label: t("settings.review.formatShort") },
          ]}
          onChange={(v) => patch({ commitFormat: v })}
        />
      </Section>
    </>
  );
}
