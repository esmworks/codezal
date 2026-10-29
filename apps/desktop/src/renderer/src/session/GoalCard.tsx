import type { GoalState } from "@codezal/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useSessions } from "../stores/sessions";

interface Props {
  /** Oturum kimliği; düğmeler doğrudan `sessions:goal` aksiyonuna gider. */
  id: string;
  goal: GoalState;
}

/**
 * Composer üstündeki kalıcı hedef şeridi: hedef metni, iterasyon sayacı ve Duraklat/Devam/Durdur.
 * Durum değişimleri `goal` olaylarıyla gelir; düğmeler yalnızca IPC'yi çağırır, yerel durum tutmaz.
 */
export function GoalCard({ id, goal }: Props) {
  const { t } = useTranslation();
  const goalAction = useSessions((s) => s.goal);
  const btn =
    "rounded-[6px] px-2 py-[3px] text-[11px] text-tx3 hover:bg-hov hover:text-tx [-webkit-app-region:no-drag]";
  return (
    <div className="mb-2 flex items-start gap-2 rounded-[10px] border border-line bg-card px-3 py-[7px]">
      <Icon name="loop" size={13} className="mt-[2px] shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-tx" title={goal.text}>
          {goal.text}
        </div>
        <div className="text-[11px] text-tx3">
          {goal.paused ? t("goal.paused") : t("goal.active")}
          {" · "}
          {t("goal.iter", { iter: goal.iter + 1, max: goal.maxIter })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {goal.paused ? (
          <button type="button" className={btn} onClick={() => void goalAction(id, "resume")}>
            {t("goal.resume")}
          </button>
        ) : (
          <button type="button" className={btn} onClick={() => void goalAction(id, "pause")}>
            {t("goal.pause")}
          </button>
        )}
        <button
          type="button"
          className={`${btn} hover:!text-red`}
          onClick={() => void goalAction(id, "stop")}
        >
          {t("goal.stop")}
        </button>
      </div>
    </div>
  );
}
