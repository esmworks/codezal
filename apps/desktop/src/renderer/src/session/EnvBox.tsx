import {
  type BackgroundJob,
  type SubagentRun,
  TEST_IDS,
  type TranscriptItem,
  testId,
} from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { FLOAT_PANEL_WIDTH } from "../lib/floatPanel";
import { openStepsOfLastTurn, progressSteps, visibleSteps } from "../lib/progress";
import { revealChanges } from "../lib/revealChanges";
import { revealTerminal } from "../lib/revealTerminal";
import { useApp } from "../stores/app";
import { useGit } from "../stores/git";
import { QuotaBox } from "./QuotaBox";
import { StatusBox } from "./StatusBox";

/**
 * Ortam bilgisi, durum (Terminaller + Ajanlar) ve İlerleme kutuları (panel kapalıyken, sohbetin sağında
 * yüzen katman). Sütun değildir: sohbet alanı altına kadar uzandığı için dikey kaydırma çubuğu
 * pencere kenarında kalır, sohbet metni yine bu katmanın solunda biter (bkz. `lib/floatPanel`).
 */
export function EnvBox({
  sessionId,
  cwd,
  transcript,
  backgrounds,
  subagents,
  active,
}: {
  sessionId: string;
  cwd: string;
  transcript: TranscriptItem[];
  /** Çalışan/biten arka plan görevleri (`background_start`/`background_end` olaylarından). */
  backgrounds: BackgroundJob[];
  /** Bu oturumun alt ajan koşuları (`subagents` olayından). */
  subagents: SubagentRun[];
  /**
   * Tur sürüyor mu (çalışıyor ya da onay bekliyor). Tur bitince kutu, son turda açık bırakılan
   * adım varsa uyarı satırıyla görünür kalır; model listeyi bir sonraki turda kapatınca kaybolur.
   */
  active: boolean;
}) {
  const { t } = useTranslation();
  const { setModal } = useApp();
  const status = useGit((s) => s.status[cwd]);
  const refreshGit = useGit((s) => s.refresh);
  // Durum ana ekranda yalnız projenin klasörü için yüklenir; worktree'de açılan oturumun klasörü
  // hiç sorulmazsa kutu ajan bir dosyaya dokunana dek "git yok" gösteriyordu.
  useEffect(() => {
    void refreshGit(cwd);
  }, [cwd, refreshGit]);
  const [envOpen, setEnvOpen] = useState(true);
  const [progOpen, setProgOpen] = useState(true);
  const steps = progressSteps(transcript);
  const done = steps.filter((s) => s.done).length;
  const allDone = steps.length > 0 && done === steps.length;
  // Tur bittiğinde açık kalan liste kutuda kalır: modelin yarım bıraktığı iş görünmez olmasın.
  const leftOpen = openStepsOfLastTurn(transcript).length;
  const showProgress = steps.length > 0 && !allDone && (active || leftOpen > 0);
  const shown = visibleSteps(steps);
  const changed = status?.files.length ?? 0;
  const actions = [
    {
      label: t("shortcuts.changes.label"),
      // Dosya sayısı yerine satır toplamı: Değişiklikler panelinin başlığıyla aynı ölçü.
      meta: changed ? (
        <span className="flex gap-[6px]">
          <span className="text-add">+{status?.additions ?? 0}</span>
          <span className="text-del">−{status?.deletions ?? 0}</span>
        </span>
      ) : null,
      icon: "changes" as const,
      go: () => revealChanges(),
    },
    {
      label: t("shortcuts.commit.label"),
      meta: null,
      icon: "commit" as const,
      go: () => setModal("commit"),
    },
    {
      label: t("shortcuts.terminal.label"),
      meta: null,
      icon: "terminal" as const,
      go: () => revealTerminal(cwd),
    },
  ];

  return (
    <div
      // Yüzen panel kimliği: e2e testi paneli genişliğinden (314) ve `position: absolute`ten
      // aramak zorunda kalmasın.
      {...testId(TEST_IDS.floatPanel)}
      className="absolute inset-y-0 right-0 z-20 flex flex-col gap-[10px] overflow-y-auto pt-[12px] pr-[18px]"
      style={{ width: FLOAT_PANEL_WIDTH }}
    >
      <div className="overflow-hidden rounded-[14px] border border-line2 bg-card">
        <button
          type="button"
          onClick={() => setEnvOpen(!envOpen)}
          className="flex w-full items-center gap-2 px-[14px] pt-3 pb-1 text-left"
        >
          <div className="flex-1 text-[14px] font-semibold">{t("env.title")}</div>
          <Icon
            name="chevronDown"
            size={13}
            stroke={2}
            className="text-tx3 transition-transform"
            style={{ transform: envOpen ? undefined : "rotate(-90deg)" }}
          />
        </button>
        <div className="flex items-center gap-[7px] px-[14px] pb-[10px] text-[14px] text-tx3">
          <span
            className={`h-[6px] w-[6px] rounded-full ${status?.isRepo ? "animate-pulse bg-green" : "bg-tx3"}`}
          />
          <span className="truncate">{status?.isRepo ? status.branch : t("env.noGit")}</span>
        </div>
        {envOpen ? (
          <div className="flex flex-col border-t border-line py-[6px]">
            {actions.map((a) => (
              <button
                type="button"
                key={a.label}
                onClick={a.go}
                className="flex items-center gap-[10px] px-[14px] py-2 text-left text-[14px] hover:bg-hov"
              >
                <Icon name={a.icon} size={15} className="text-tx2" />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.meta ? <span className="shrink-0 text-[14px] text-tx3">{a.meta}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <StatusBox sessionId={sessionId} backgrounds={backgrounds} subagents={subagents} />
      {showProgress ? (
        <div className="overflow-hidden rounded-[14px] border border-line2 bg-card">
          <button
            type="button"
            onClick={() => setProgOpen(!progOpen)}
            className="flex w-full items-center gap-2 px-[14px] py-3 text-left"
          >
            <div className="text-[14px] font-semibold">{t("env.progressTitle")}</div>
            <span className="text-[14px] text-tx3">
              {done}/{steps.length}
            </span>
            <span className="flex-1" />
            <Icon
              name="chevronDown"
              size={13}
              stroke={2}
              className="text-tx3 transition-transform"
              style={{ transform: progOpen ? undefined : "rotate(-90deg)" }}
            />
          </button>
          {progOpen ? (
            <div className="flex flex-col gap-1 border-t border-line px-[14px] pt-2 pb-[10px]">
              {!active && leftOpen > 0 ? (
                <div className="text-[14px] text-amber">
                  {t("env.openStepsLeft", { count: leftOpen })}
                </div>
              ) : null}
              {steps.length === 0 ? (
                <div className="text-[14px] text-tx3">{t("env.noSteps")}</div>
              ) : null}
              {shown.shown.map((s) => (
                <div key={s.label} className="flex items-start gap-2 text-[14px]">
                  <span
                    className={`w-3 shrink-0 ${s.done ? "text-green" : s.active ? "text-tx" : "text-tx3"}`}
                  >
                    {s.done ? "✓" : s.active ? "›" : "·"}
                  </span>
                  <span className="min-w-0 truncate text-tx2">{s.label}</span>
                </div>
              ))}
              {shown.hidden > 0 ? (
                <div className="pl-5 text-[14px] text-tx3">
                  {t("env.moreSteps", { count: shown.hidden })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <QuotaBox sessionId={sessionId} active={active} />
    </div>
  );
}
