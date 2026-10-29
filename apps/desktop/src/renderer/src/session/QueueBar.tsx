import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";

interface Props {
  /** Sıradaki LLM çağrısında teslim edilecek yönlendirmeler. */
  steering: string[];
  /** Tur tamamen bitince işlenecek takip mesajları. */
  followUp: string[];
  onClear: () => void;
}

/**
 * Composer üstündeki kuyruk şeridi: bekleyen yönlendirme ve takip mesajlarını sayar, ilk mesajın
 * önizlemesini gösterir ve tümünü temizleme düğmesi sunar. Durum Pi `queue_update` olayından gelir;
 * şerit yalnızca kuyruk doluyken çizilir.
 */
export function QueueBar({ steering, followUp, onClear }: Props) {
  const { t } = useTranslation();
  const total = steering.length + followUp.length;
  if (total === 0) return null;
  const preview = [...steering, ...followUp][0] ?? "";
  const parts: string[] = [];
  if (steering.length > 0) parts.push(t("session.queueSteering", { count: steering.length }));
  if (followUp.length > 0) parts.push(t("session.queueFollowUp", { count: followUp.length }));
  const btn =
    "shrink-0 rounded-[6px] px-2 py-[3px] text-[11px] text-tx3 hover:bg-hov hover:text-tx [-webkit-app-region:no-drag]";
  return (
    <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-[7px]">
      <Icon name="clock" size={13} className="shrink-0 text-tx3" />
      <span className="shrink-0 text-[12px] text-tx2">{parts.join(" · ")}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-tx3" title={preview}>
        {preview}
      </span>
      <button type="button" className={btn} onClick={onClear}>
        {t("session.queueClear")}
      </button>
    </div>
  );
}
