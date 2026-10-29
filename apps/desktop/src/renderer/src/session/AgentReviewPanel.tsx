import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { i18n } from "../lib/i18n";
import { type AgentRunRow, selectRuns, useAgentRuns } from "../stores/agentRuns";
import { humanizeError, toast } from "../stores/toast";

/** Uygula/Sil kararı: sonuç bildirimle söylenir, hata kullanıcıya düşer. */
export function reviewRun(sessionId: string, runId: string, decision: "apply" | "discard"): void {
  void useAgentRuns
    .getState()
    .review(sessionId, runId, decision)
    .then(() =>
      toast.success(i18n.t(decision === "apply" ? "agentRuns.applied" : "agentRuns.discarded")),
    )
    .catch((e) => toast.error(humanizeError(e)));
}

/** Diff'i açar ya da (aynı koşu için açıksa) kapatır. */
export function toggleDiff(sessionId: string, runId: string): void {
  const state = useAgentRuns.getState();
  if (state.diff?.runId === runId) {
    state.clearDiff();
    return;
  }
  void state.loadDiff(sessionId, runId).catch((e) => toast.error(humanizeError(e)));
}

/**
 * İnceleme bekleyen ajan işleri, sohbetin sonunda izin kartı gibi durur: karar anı sohbettedir,
 * kullanıcı ayrı bir panel açmak zorunda kalmaz (panel açılınca Ortam sütunu da gizleniyordu).
 * Kendi worktree'sinde değişiklik bırakan her koşu bir kart; karar verilene kadar değişiklik ana
 * klasöre girmez. Bekleyen koşu yoksa hiçbir şey çizilmez.
 */
export function AgentReviewCards({ sessionId }: { sessionId: string }) {
  const runs = useAgentRuns(selectRuns(sessionId));
  const pending = runs.filter((r) => r.status === "review");
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((run) => (
        <AgentReviewCard key={run.id} sessionId={sessionId} run={run} />
      ))}
    </>
  );
}

/**
 * Kart izin kartlarının arasında belirir; kullanıcı ardışık onay verirken yeni kart tıklanan yere
 * kayabiliyor (denemede "İzin ver" yerine "Uygula"ya basıldı). Karar düğmeleri kısa bir süre kapalı
 * açılır ve ilk sıradaki düğme zararsız İncele'dir.
 */
const ARM_DELAY_MS = 1200;

function useArmed(ms: number): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return armed;
}

/** Tek koşunun kartı: başlık, değişen dosyalar, isteğe bağlı diff ve karar düğmeleri. */
export function AgentReviewCard({ sessionId, run }: { sessionId: string; run: AgentRunRow }) {
  const { t } = useTranslation();
  const armed = useArmed(ARM_DELAY_MS);
  const busy = useAgentRuns((s) => s.busy === run.id) || !armed;
  const diff = useAgentRuns((s) => (s.diff?.runId === run.id ? s.diff : null));
  const files = run.files ?? [];
  const count = files.length || run.filesChanged || 0;
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-accLine bg-card2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <Icon name="branch" size={15} className="shrink-0 text-accTx" />
        <span className="shrink-0 font-medium text-tx">{t("agentRuns.cardTitle")}</span>
        <span className="min-w-0 truncate text-tx3" title={run.title}>
          · {run.title}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-tx3">{run.agent}</span>
      </div>
      <div className="text-[13px] leading-[1.5] text-tx2">
        {t("agentRuns.cardHint", { count })}
        {files.length > 0 ? (
          <span className="font-mono text-[12px] text-tx3">
            {" "}
            {files.slice(0, 4).join(", ")}
            {files.length > 4 ? ` +${files.length - 4}` : ""}
          </span>
        ) : null}
      </div>
      {diff ? <DiffView text={diff.text} /> : null}
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => toggleDiff(sessionId, run.id)}>
          {diff ? t("agentRuns.closeDiff") : t("agentRuns.inspect")}
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => reviewRun(sessionId, run.id, "apply")}
        >
          <Icon name="check" size={13} stroke={2.2} /> {t("agentRuns.apply")}
        </Button>
        <span className="flex-1" />
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => reviewRun(sessionId, run.id, "discard")}
        >
          {t("agentRuns.discard")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Koşunun worktree diff'i; değişiklik yoksa bunu söyler. `onClose` verilirse başlık ve Kapat
 * düğmesi çizilir (Ajanlar sekmesi); sohbet kartında açma/kapama kartın kendi düğmesindedir.
 */
export function DiffView({ text, onClose }: { text: string; onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      {onClose ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 text-[13px] font-medium text-tx3">{t("agentRuns.diffTitle")}</div>
          <Button size="sm" onClick={onClose}>
            {t("agentRuns.closeDiff")}
          </Button>
        </div>
      ) : null}
      {text.trim() === "" ? (
        <div className="text-[13px] text-tx3">{t("agentRuns.emptyDiff")}</div>
      ) : (
        <pre className="max-h-[320px] overflow-auto rounded-[8px] border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-tx">
          {text}
        </pre>
      )}
    </div>
  );
}
