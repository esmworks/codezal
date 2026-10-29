import type { CheckResult } from "@codezal/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { ErrorText } from "../components/ErrorBar";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { Working } from "../components/Working";
import { useApp } from "../stores/app";
import { useGit } from "../stores/git";
import { useModels } from "../stores/models";
import { useSettings } from "../stores/settings";

/** Commit modalı: mesaj önerisi (ajan), hazırlanmamışları dahil et, Commit / Commit ve push / Yalnızca push (TODO 2, 3). */
export function CommitModal({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const setModal = useApp((s) => s.setModal);
  const status = useGit((s) => s.status[cwd]);
  const refresh = useGit((s) => s.refresh);
  const settings = useSettings((s) => s.settings);
  const model = useModels((s) => s.model);
  const [message, setMessage] = useState("");
  /** Kullanıcı mesajı elle düzenledi mi: geç dönen öneri onun metnini ezmesin. */
  const editedRef = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [unstaged, setUnstaged] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    void refresh(cwd);
  }, [cwd, refresh]);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await invoke("git:suggestMessage", {
        cwd,
        includeUnstaged: unstaged,
        ...(model ? { model } : {}),
      });
      // Kullanıcı bu arada yazdıysa öneri onun metnini **ezmez**: model çağrısı saniyeler sürer
      // ve pencere açılır açılmaz yazmaya başlayan kullanıcının mesajı kaybolurdu (fark
      // edilmezse yanlış commit mesajı giderdi).
      if (!editedRef.current) setMessage(r.message);
      setHint(
        r.ai
          ? null
          : `${t("commit.heuristic")}${
              r.error ? t("commit.modelHintFailed", { error: r.error }) : ""
            }`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnızca açılışta öner
  useEffect(() => {
    void suggest();
  }, []);

  const runChecks = async (): Promise<boolean> => {
    if (!settings?.review) return true;
    const commands = [
      settings.lintOn ? settings.lintCmd : "",
      settings.testOn ? settings.testCmd : "",
      settings.buildOn ? settings.buildCmd : "",
    ].filter((c) => c.trim());
    if (commands.length === 0) return true;
    setBusy(t("commit.checking"));
    const results = await invoke("checks:run", { cwd, commands });
    setChecks(results);
    return results.every((r) => r.ok);
  };

  const run = async (kind: "commit" | "commit-push" | "push") => {
    setError(null);
    setChecks(null);
    try {
      if (kind !== "push") {
        if (!message.trim()) {
          setError(t("commit.emptyMsg"));
          return;
        }
        if (!(await runChecks())) {
          setBusy(null);
          setError(t("commit.checksFailed"));
          return;
        }
        setBusy(t("commit.committing"));
        await invoke("git:commit", { cwd, message: message.trim(), includeUnstaged: unstaged });
      }
      if (kind !== "commit") {
        setBusy(t("commit.pushing"));
        await invoke("git:push", { cwd });
      }
      await refresh(cwd);
      setModal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const nothing = !status || status.files.length === 0;
  // Pasif hâl solma değil ayrı bir yüzey: opacity, dolu zeminli satırı çamur grisine çeviriyordu.
  const row =
    "flex items-center gap-[9px] rounded-[11px] px-[13px] py-[10px] text-left text-[14px] transition-colors disabled:text-tx3";
  return (
    <Modal title={t("commit.title")} width={600} onClose={() => setModal(null)}>
      <div className="flex flex-col gap-[14px]">
        <div className="flex items-center gap-[9px] text-[13px]">
          <Icon name="branch" size={15} className="text-tx2" />
          <span className="flex-1 text-tx">{status?.branch ?? "…"}</span>
          {status && status.ahead > 0 ? <span className="text-tx3">↑{status.ahead}</span> : null}
          <span className="text-green">+{status?.additions ?? 0}</span>
          <span className="text-red">−{status?.deletions ?? 0}</span>
        </div>
        <div className="relative">
          <textarea
            value={message}
            onChange={(e) => {
              editedRef.current = true;
              setMessage(e.target.value);
            }}
            placeholder={suggesting ? t("commit.suggestPlaceholder") : t("commit.msgPlaceholder")}
            rows={4}
            className="min-h-[112px] w-full resize-y rounded-[11px] border border-line2 bg-transparent px-[13px] py-[11px] text-[14px] leading-[1.5] text-tx outline-none placeholder:text-tx3"
          />
          <button
            type="button"
            onClick={() => void suggest()}
            disabled={suggesting || nothing}
            title={t("commit.suggestTitle")}
            className="absolute right-2 bottom-2 flex items-center gap-1 rounded-[7px] px-2 py-1 text-[12px] text-tx3 enabled:hover:bg-hov enabled:hover:text-tx"
          >
            <Icon name="sparkle" size={12} />
            {suggesting ? "…" : t("commit.suggest")}
          </button>
        </div>
        {hint ? <div className="-mt-1 text-[12px] text-tx3">{hint}</div> : null}
        <button
          type="button"
          onClick={() => setUnstaged(!unstaged)}
          className="flex items-center gap-[9px] text-left text-[14px]"
        >
          <span
            className={`flex h-[18px] w-[18px] items-center justify-center rounded-full ${unstaged ? "bg-tx" : "border-[1.5px] border-line2"}`}
          >
            {unstaged ? <Icon name="check" size={11} stroke={3} className="text-onAcc" /> : null}
          </span>
          {t("commit.includeUnstaged")}
        </button>
        {checks ? (
          <div className="flex flex-col gap-1 rounded-[10px] border border-line bg-bg p-2 font-mono text-[12px]">
            {checks.map((c) => (
              <details key={c.command}>
                <summary className={c.ok ? "text-green" : "text-tx2"}>
                  {c.ok ? "✓" : "✗"} {c.command} ·{" "}
                  {t("commit.checkSec", { sec: Math.round(c.durationMs / 100) / 10 })}
                </summary>
                <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap pt-1 text-tx3">
                  {c.output}
                </pre>
              </details>
            ))}
          </div>
        ) : null}
        {error ? <ErrorText text={error} /> : null}
        {busy ? <Working label={busy} className="gap-2" /> : null}
        <div className="flex flex-col gap-[7px]">
          <button
            type="button"
            disabled={!!busy || nothing}
            onClick={() => void run("commit")}
            className={`${row} bg-chip text-tx enabled:hover:bg-hov`}
          >
            <Icon name="commit" size={15} className="text-tx2" />
            Commit
          </button>
          <button
            type="button"
            disabled={!!busy || nothing || !status?.hasRemote}
            onClick={() => void run("commit-push")}
            className={`${row} bg-tx font-medium text-bg enabled:hover:opacity-90 disabled:bg-chip`}
          >
            <Icon name="export" size={15} />
            {t("commit.commitPush")}
          </button>
          <button
            type="button"
            disabled={!!busy || !status?.hasRemote}
            onClick={() => void run("push")}
            className={`${row} text-tx2 enabled:hover:bg-hov enabled:hover:text-tx`}
          >
            <Icon name="export" size={15} />
            {t("commit.pushOnly")}{" "}
            {status && status.ahead > 0 ? t("commit.pushAhead", { count: status.ahead }) : ""}
          </button>
          {status && !status.hasRemote ? (
            <div className="text-[12px] text-tx3">{t("commit.noRemote")}</div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
