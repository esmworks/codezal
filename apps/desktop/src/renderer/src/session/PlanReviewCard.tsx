import type { PermissionMode, PlanDecision, PlanReview } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";

interface Props {
  review: PlanReview;
  onDecide: (decision: PlanDecision) => void;
}

const MODE_KEYS: Record<PermissionMode, TranslationKey> = {
  ask: "permissionMode.ask",
  "auto-edit": "permissionMode.auto-edit",
  plan: "permissionMode.plan",
  full: "permissionMode.full",
};

/**
 * Plan onay kartı: `plan_exit` aracının sunduğu plan dosyası. Onay oturumu önceki izin moduna
 * döndürür ve model aynı turda uygulamaya geçer; "Düzeltme iste" geri bildirimi modele gönderir,
 * plan modu sürer; "İptal" plandan vazgeçer, turu durdurur ve plan modundan çıkar.
 */
export function PlanReviewCard({ review, onDecide }: Props) {
  const { t } = useTranslation();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-accLine bg-card2 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name="permPlan" size={15} className="text-accTx" />
        <span className="font-medium text-tx">{t("permission.planTitle")}</span>
        <span className="text-tx3">
          · {t("permission.planReturn", { mode: t(MODE_KEYS[review.returnTo]) })}
        </span>
      </div>
      <div className="max-h-[420px] overflow-y-auto rounded-[8px] border border-line bg-bg px-4 py-3">
        <Markdown text={review.plan} document />
      </div>
      <div className="truncate font-mono text-[11px] text-tx3" title={review.path}>
        {review.path}
      </div>
      {revising ? (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t("permission.planFeedback")}
            className="min-h-[80px] w-full resize-none rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] leading-[1.5] text-tx outline-none placeholder:text-tx3"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={!feedback.trim()}
              onClick={() => onDecide({ approved: false, feedback: feedback.trim() })}
            >
              {t("permission.planSend")}
            </Button>
            <Button variant="secondary" onClick={() => setRevising(false)}>
              {t("permission.planCancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => onDecide({ approved: true })}>
            <Icon name="check" size={13} stroke={2.2} /> {t("permission.planApprove")}
          </Button>
          <Button variant="secondary" onClick={() => setRevising(true)}>
            {t("permission.planRevise")}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={() => onDecide({ approved: false, cancelled: true })}>
            {t("permission.planAbort")}
          </Button>
        </div>
      )}
    </div>
  );
}
